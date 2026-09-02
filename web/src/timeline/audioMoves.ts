/**
 * Moving audio on the Timeline — the arithmetic, kept away from the pointer.
 *
 * A clip's position on the Timeline is COMPILED, never stored: the server lays VO at
 * `shot start + head_pad + vo_offset` and a cue at its anchor plus its offset. So a drag
 * cannot write "this clip now starts at frame 412"; it has to invert the compile and
 * write the field the compile reads:
 *
 *   VO (A1)         → the shot's `vo_offset` override, in seconds from the shot's head.
 *                     One offset serves every line in the shot, so dragging one line
 *                     slides them all — `lines` says how many.
 *   MUSIC / SFX     → the cue's placement, through `POST /cues/{id}/move` (which keeps a
 *                     shot-anchored cue anchored and moves its offset instead).
 *
 * Picture never moves from here: a shot's place in the film comes from the film, not
 * from the timeline.
 *
 * Everything below is pure and unit-tested: the drag, the WebMCP tool and the tests all
 * plan a move the same way.
 */
import {
  type Clip, type Timeline, clipEnd, framesToSeconds, secondsToFrames,
} from "./model";

export type AudioRole = "vo" | "music" | "sfx";

/** `cutroom.role` if the compiler set one, else the track the clip sits on. */
export function roleOf(clip: Clip, trackName?: string): AudioRole {
  const r = String(clip.cutroom?.role ?? "").toLowerCase();
  if (r === "vo" || r === "music" || r === "sfx") return r;
  const t = (trackName || "").toUpperCase();
  if (t.startsWith("MUSIC")) return "music";
  if (t.startsWith("SFX")) return "sfx";
  return "vo";
}

/** The audio track a clip is on, by name — for `roleOf` and for reporting. */
export const trackNameOf = (tl: Timeline, clip: Clip): string =>
  tl.tracks.find((t) => t.id === clip.track_id)?.name || "";

export const isAudio = (c: Clip): boolean => c.kind === "audio";

export const clipLabel = (c: Clip): string =>
  c.label || String(c.cutroom?.shot || "") || c.kind;

// ------------------------------------------------------------------ drag geometry

/** Pointer travel (px) that separates a click-to-seek from a drag. */
export const DRAG_THRESHOLD_PX = 4;
/** How close (px) a drag has to come before it snaps to a landmark. */
export const SNAP_WITHIN_PX = 8;
/** The fallback grid: quarter-second, the smallest move worth typing a number for. */
export const SNAP_GRID_SECONDS = 0.25;

export type SnapKind = "playhead" | "shot" | "grid";
export interface SnapTarget { frame: number; kind: "playhead" | "shot"; label: string }

/** Did the pointer travel far enough to mean "move this" rather than "seek here"? */
export const isDrag = (dx: number, threshold = DRAG_THRESHOLD_PX): boolean =>
  Math.abs(dx) >= threshold;

/**
 * The landmarks a dragged clip snaps to: the playhead, and every cut in the picture
 * (each shot's head and tail). Nearest wins, so a cue lands ON the cut rather than a
 * frame either side of it.
 */
export function snapTargets(tl: Timeline, playhead: number): SnapTarget[] {
  const out = new Map<number, SnapTarget>();
  out.set(playhead, { frame: playhead, kind: "playhead", label: "playhead" });
  const picture = tl.clips.filter((c) => !isAudio(c));
  // Heads first: a cut is named by the shot that BEGINS there, which is how a
  // director says it ("on B01-S2"), not by the one that just ended.
  for (const c of picture) {
    if (!out.has(c.start)) {
      out.set(c.start, { frame: c.start, kind: "shot", label: clipLabel(c) });
    }
  }
  for (const c of picture) {
    const end = clipEnd(c);
    if (!out.has(end)) {
      out.set(end, { frame: end, kind: "shot", label: `after ${clipLabel(c)}` });
    }
  }
  return [...out.values()].sort((a, b) => a.frame - b.frame);
}

export interface SnapResult { start: number; to: SnapKind; label: string | null }

/**
 * Where a dragged clip actually lands: the nearest landmark within `within` frames,
 * else the quarter-second grid. Always inside the film.
 */
export function snapStart(raw: number, o: {
  targets?: SnapTarget[]; within?: number; fps: number; max?: number;
}): SnapResult {
  const fps = o.fps || 24;
  const max = Math.max(0, o.max ?? Number.MAX_SAFE_INTEGER);
  const clamp = (f: number) => Math.max(0, Math.min(Math.round(f), max));
  const want = clamp(raw);

  const within = o.within ?? 0;
  let best: SnapTarget | null = null;
  for (const t of o.targets || []) {
    const d = Math.abs(t.frame - want);
    if (d > within) continue;
    // Ties go to the playhead: it is the landmark the human is looking at.
    if (!best || d < Math.abs(best.frame - want)
        || (d === Math.abs(best.frame - want) && t.kind === "playhead")) {
      best = t;
    }
  }
  if (best) return { start: clamp(best.frame), to: best.kind, label: best.label };

  const grid = Math.max(1, Math.round(fps * SNAP_GRID_SECONDS));
  return { start: clamp(Math.round(want / grid) * grid), to: "grid", label: null };
}

// ------------------------------------------------------------------ what a drop writes

export interface VoMove {
  target: "vo";
  sid: string;
  /** Seconds after the shot's head pad — exactly what the assembler reads. */
  voOffset: number;
  at: number;
  /** How many VO lines this shot has: one offset moves all of them. */
  lines: number;
  label: string;
}
export interface CueMove {
  target: "cue";
  cue: string;
  role: "music" | "sfx";
  at: number;
  label: string;
}
export interface BlockedMove { target: "blocked"; why: string }
export type MovePlan = VoMove | CueMove | BlockedMove;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The VO lines of one shot, in the order the compiler laid them. */
export function voLines(tl: Timeline, sid: string): Clip[] {
  return tl.clips
    .filter((c) => isAudio(c) && roleOf(c, trackNameOf(tl, c)) === "vo"
      && String(c.cutroom?.shot || "") === sid)
    .sort((a, b) => {
      const la = Number(a.cutroom?.line ?? NaN);
      const lb = Number(b.cutroom?.line ?? NaN);
      if (Number.isFinite(la) && Number.isFinite(lb) && la !== lb) return la - lb;
      return a.start - b.start;
    });
}

/**
 * What writing this clip's new start actually means. `startFrames` is where the clip
 * should begin on the timeline; the plan says which server field carries that.
 */
export function planMove(tl: Timeline, clip: Clip, startFrames: number): MovePlan {
  if (!isAudio(clip)) {
    return { target: "blocked", why: "only audio moves here — a shot's place in the film comes from the film" };
  }
  const fps = tl.fps || 24;
  const at = round3(framesToSeconds(
    Math.max(0, Math.round(startFrames)), fps));
  const role = roleOf(clip, trackNameOf(tl, clip));
  const label = clipLabel(clip);

  if (role === "vo") {
    const sid = String(clip.cutroom?.shot || "");
    if (!sid) {
      return { target: "blocked", why: "this VO clip names no shot, so there is no offset to write" };
    }
    const picture = tl.clips.find(
      (c) => !isAudio(c) && (String(c.cutroom?.shot || "") === sid || c.label === sid));
    if (!picture) {
      return { target: "blocked", why: `${sid} has no picture on this timeline to measure its VO against` };
    }
    const lines = voLines(tl, sid);
    const idx = Math.max(0, lines.findIndex((c) => c.id === clip.id));
    const before = lines.slice(0, idx)
      .reduce((sum, c) => sum + framesToSeconds(c.duration, fps), 0);
    const headPad = Number(tl.cutroom?.head_pad ?? 0.3) || 0;
    const voOffset = round3(
      at - framesToSeconds(picture.start, fps) - headPad - before);
    return { target: "vo", sid, voOffset, at, lines: lines.length || 1, label };
  }

  const cue = String(clip.cutroom?.cue || "");
  if (!cue) {
    return { target: "blocked", why: "this cue has no id yet — reload the Timeline, which gives every imported cue one" };
  }
  return { target: "cue", cue, role, at, label };
}

/**
 * Every other audio clip whose range the moved clip would still sit inside.
 * `ignore` drops the clips that travel WITH it — the other VO lines of a shot,
 * which keep their spacing because one `vo_offset` serves them all.
 */
export function audioOverlaps(tl: Timeline, clip: Clip, startFrames: number,
                              ignore: Iterable<string> = []): Clip[] {
  const skip = new Set([clip.id, ...ignore]);
  const start = Math.max(0, Math.round(startFrames));
  const end = start + clip.duration;
  return tl.clips
    .filter((c) => !skip.has(c.id) && isAudio(c)
      && c.start < end && start < clipEnd(c))
    .sort((a, b) => a.start - b.start);
}

/** `{label, track, start, end}` in seconds — the shape a tool result reports. */
export function describeOverlaps(tl: Timeline, clips: Clip[]) {
  const fps = tl.fps || 24;
  return clips.map((c) => ({
    clip: clipLabel(c),
    track: trackNameOf(tl, c),
    start: round3(framesToSeconds(c.start, fps)),
    end: round3(framesToSeconds(clipEnd(c), fps)),
  }));
}

/** Seconds → the frame a clip should start on, for callers who think in time. */
export const startFrameFor = (seconds: number, fps: number): number =>
  Math.max(0, secondsToFrames(Math.max(0, seconds), fps || 24));
