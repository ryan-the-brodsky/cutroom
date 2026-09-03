/**
 * Sound for the Timeline's live preview.
 *
 * The preview player composites picture by seeking a `<video>` per frame; audio cannot
 * work that way — a scrubbed `<audio>` element is a click, not a line reading. So the
 * mix is a separate machine that follows the same playhead: one `HTMLAudioElement` per
 * audio clip (VO on A1, the music bed, SFX), started when the playhead enters the clip,
 * paused when it leaves, and snapped back whenever it drifts more than `DRIFT_SNAP`
 * from where the film says it should be.
 *
 * The arithmetic — is this clip under the playhead, how far into its file, and has it
 * drifted — is `cueAction`, a pure function over a plain element snapshot, so the
 * behaviour is unit-tested without a browser. The class below is a thin DOM shell.
 *
 * Autoplay policy: elements are created only on the PLAY path (`sync(t, true)`), which
 * the page calls synchronously from the click handler, so the whole set is minted under
 * the user gesture. They carry `preload="none"` until the playhead is nearly on them —
 * a 97-shot film must not open 97 connections the moment someone presses ▶.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dbToGain } from "../audio/shotMix";
import { type AudioRole, roleOf } from "../timeline/audioMoves";
import {
  type Clip, type Timeline, framesToSeconds, stableClipKey,
} from "../timeline/model";

// `roleOf` lives with the move arithmetic (the Timeline's drag needs it too) and is
// re-exported here because the mix is where a role is heard.
export { roleOf };
export type { AudioRole };

/** One audio clip, in TIMELINE seconds, ready to play. */
export interface AudioCue {
  id: string;
  src: string;
  start: number;      // timeline seconds — when it enters
  end: number;        // timeline seconds — when it leaves (exclusive)
  offset: number;     // seconds into the media file at `start`
  volume: number;     // linear, 0–1
  role: AudioRole;
  label: string;
}

/** Past this much error (seconds) an element is snapped back onto the playhead. */
export const DRIFT_SNAP = 0.15;
/** Below this, leave the element alone — re-seeking inaudible deltas only stutters it. */
const SEEK_EPS = 0.05;
/** How far ahead of a cue we start buffering it, in seconds. */
export const LOOKAHEAD = 4;

/** The preview mix when the film says nothing: VO forward, bed under it. */
export const ROLE_GAIN: Record<AudioRole, number> = { vo: 1, music: 0.5, sfx: 0.8 };

const GAIN_DB_RE = /(-?\d+(?:\.\d+)?)\s*db/i;

/**
 * Cue gain is DECIBELS everywhere in Genga Studio (`cutroom.cues`), and the importer
 * keeps free text like `"-16dB under narration"` — mirror `cues.parse_gain_db`.
 */
export function parseGainDb(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw);
  const m = GAIN_DB_RE.exec(s);
  if (m) return Number(m[1]);
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** An explicit gain on the clip wins; otherwise the role's preview level. */
export function volumeOf(clip: Clip, role: AudioRole): number {
  const db = parseGainDb(clip.cutroom?.gain);
  return db === null ? ROLE_GAIN[role] : clamp01(dbToGain(db));
}

/** Every audible clip in the timeline, in timeline seconds. `srcOf` mints the media URL. */
export function audioCues(tl: Timeline, srcOf: (rel: string) => string): AudioCue[] {
  const fps = tl.fps || 24;
  const audioTracks = new Map(
    tl.tracks.filter((t) => t.kind === "audio").map((t) => [t.id, t.name]));
  return tl.clips
    .filter((c) => !!c.source && (c.kind === "audio" || audioTracks.has(c.track_id)))
    .map((c) => {
      const role = roleOf(c, audioTracks.get(c.track_id));
      const srcFps = c.source_fps || fps;
      return {
        // Content-derived, not the compiler's per-compile random `id`: an
        // edit elsewhere in the film must not tear down and recreate a VO
        // line or music bed that is already playing. See `stableClipKey`.
        id: stableClipKey(c),
        src: srcOf(c.source as string),
        start: framesToSeconds(c.start, fps),
        end: framesToSeconds(c.start + c.duration, fps),
        offset: Math.max(0, framesToSeconds(c.source_start ?? 0, srcFps)),
        volume: volumeOf(c, role),
        role,
        label: c.label || role,
      };
    })
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** "31 VO · 2 music · 5 SFX" — what the mix is actually made of. */
export function mixSummary(cues: AudioCue[]): string {
  const n: Record<AudioRole, number> = { vo: 0, music: 0, sfx: 0 };
  for (const c of cues) n[c.role] += 1;
  const parts: string[] = [];
  if (n.vo) parts.push(`${n.vo} VO line${n.vo === 1 ? "" : "s"}`);
  if (n.music) parts.push(`${n.music} music cue${n.music === 1 ? "" : "s"}`);
  if (n.sfx) parts.push(`${n.sfx} SFX`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ the decision

export type CueAction =
  | { do: "none" }
  | { do: "pause" }                 // the playhead has left it (or the file ran out)
  | { do: "park"; at: number }      // paused/scrubbing: hold the head at `at`
  | { do: "start"; at: number }     // cue it up and play
  | { do: "snap"; at: number };     // playing, but off the playhead

/** What we need to know about an element to decide — the DOM bits, and nothing else. */
export interface ElState {
  paused: boolean;
  currentTime: number;
  /** Media length in seconds, or null while unknown. */
  duration?: number | null;
}

/**
 * What this cue's element should do at film time `t`.
 *
 * A clip whose media is SHORTER than its slot on the timeline (the compiler probes
 * durations, but a re-recorded line can be shorter than the clip it filled) is allowed
 * to run out and stay out: restarting it would loop the tail under the picture.
 */
export function cueAction(cue: AudioCue, t: number, playing: boolean,
                          el: ElState): CueAction {
  const inRange = t >= cue.start && t < cue.end;
  if (!inRange) return el.paused ? { do: "none" } : { do: "pause" };

  const at = Math.max(0, cue.offset + (t - cue.start));
  const dur = el.duration;
  if (dur != null && Number.isFinite(dur) && dur > 0 && at >= dur - SEEK_EPS) {
    return el.paused ? { do: "none" } : { do: "pause" };
  }
  if (!playing) {
    return !el.paused || Math.abs(el.currentTime - at) > SEEK_EPS
      ? { do: "park", at } : { do: "none" };
  }
  if (el.paused) return { do: "start", at };
  return Math.abs(el.currentTime - at) > DRIFT_SNAP ? { do: "snap", at } : { do: "none" };
}

// ------------------------------------------------------------------ the DOM shell

interface Live { cue: AudioCue; el: HTMLAudioElement; warm: boolean }

export class TimelineAudio {
  private live = new Map<string, Live>();
  private cues: AudioCue[] = [];
  private minted = false;
  private mutedFlag = false;
  private retryOnce = false;
  /** True while the browser is refusing to start a clip without a click. */
  blocked = false;

  constructor(private onBlockedChange?: (blocked: boolean) => void) {}

  /** Swap in a new compile. Elements survive when their cue and media are unchanged. */
  setCues(cues: AudioCue[]): void {
    const next = new Map(cues.map((c) => [c.id, c]));
    for (const [id, entry] of [...this.live]) {
      const cue = next.get(id);
      if (!cue || cue.src !== entry.cue.src) {
        this.release(entry.el);
        this.live.delete(id);
      } else {
        entry.cue = cue;
        entry.el.volume = cue.volume;
      }
    }
    this.cues = cues;
    if (this.minted && cues.some((c) => !this.live.has(c.id))) this.mint();
  }

  setMuted(muted: boolean): void {
    this.mutedFlag = muted;
    for (const { el } of this.live.values()) el.muted = muted;
  }

  /**
   * Put every audio clip where film time `t` says it should be.
   *
   * `retry` marks the call as an ASK — a press of ▶, or a tool calling play. Once the
   * browser has refused, only an ask tries again: the frame loop must not fire a
   * rejected `play()` twenty-four times a second at a page that has said no.
   */
  sync(t: number, playing: boolean, retry = false): void {
    if (retry) this.retryOnce = true;
    // Minting on the play path keeps every element inside the user gesture that
    // started playback, which is what the autoplay policy actually checks.
    if (playing && !this.minted) this.mint();
    if (!this.live.size) { this.retryOnce = false; return; }

    for (const cue of this.cues) {
      const entry = this.live.get(cue.id);
      if (!entry) continue;
      const el = entry.el;
      if (playing && !entry.warm && t >= cue.start - LOOKAHEAD && t < cue.end) {
        entry.warm = true;
        el.preload = "auto";
        try { el.load(); } catch { /* it will load when it plays */ }
      }
      const action = cueAction(cue, t, playing, {
        paused: el.paused,
        currentTime: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : null,
      });
      switch (action.do) {
        case "pause": el.pause(); break;
        case "park": el.pause(); this.seek(el, action.at); break;
        case "snap": this.seek(el, action.at); break;
        case "start":
          if (this.blocked && !this.retryOnce) break;
          this.seek(el, action.at);
          this.start(el);
          break;
        default: break;
      }
    }
    this.retryOnce = false;
  }

  /** Silence everything without forgetting where it was (pause, end of playback). */
  stop(): void {
    for (const { el } of this.live.values()) { try { el.pause(); } catch { /* gone */ } }
  }

  /** Silence and let go of the media — the page is leaving. */
  dispose(): void {
    this.stop();
    for (const { el } of this.live.values()) this.release(el);
    this.live.clear();
    this.minted = false;
  }

  /** The clips this mix would sound, for the caption and for tests. */
  get roster(): AudioCue[] { return this.cues; }

  private mint(): void {
    this.minted = true;
    for (const cue of this.cues) {
      if (this.live.has(cue.id)) continue;
      const el = new Audio();
      el.preload = "none";
      el.src = cue.src;
      el.volume = cue.volume;
      el.muted = this.mutedFlag;
      this.live.set(cue.id, { cue, el, warm: false });
    }
  }

  private seek(el: HTMLAudioElement, at: number): void {
    // Before metadata arrives this sets the default playback start position rather
    // than throwing; older engines threw InvalidStateError, hence the guard.
    try { el.currentTime = at; } catch { /* it will start where it lands */ }
  }

  private start(el: HTMLAudioElement): void {
    const p = el.play() as Promise<void> | undefined;
    if (!p?.catch) return;
    p.then(() => this.setBlocked(false)).catch((e: unknown) => {
      // AbortError just means a seek raced the play() — only a refusal is news.
      if ((e as { name?: string })?.name === "NotAllowedError") this.setBlocked(true);
    });
  }

  private setBlocked(v: boolean): void {
    if (this.blocked === v) return;
    this.blocked = v;
    this.onBlockedChange?.(v);
  }

  private release(el: HTMLAudioElement): void {
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch { /* the element is going away regardless */ }
  }
}

// ------------------------------------------------------------------ the React seam

export interface PreviewAudio {
  /**
   * Put every clip where film time `t` says it is. Pass `retry` when the call comes
   * from an ask (▶, or a tool) rather than from the frame loop.
   */
  sync(t: number, playing: boolean, retry?: boolean): void;
  muted: boolean;
  setMuted(muted: boolean): void;
  /** The browser refused to start sound without a click. */
  blocked: boolean;
  cues: AudioCue[];
}

/**
 * The mix for one compiled timeline, owned by the page that draws it.
 *
 * The returned object is stable while nothing real changes, so an effect may depend on
 * it. `srcOf` must be stable too (a `useCallback` over the project id) — it is what
 * turns a clip's project-relative path into a token-carrying media URL.
 */
export function useTimelineAudio(tl: Timeline | null,
                                 srcOf: (rel: string) => string): PreviewAudio {
  const [blocked, setBlocked] = useState(false);
  const [muted, setMutedState] = useState(false);
  const ref = useRef<TimelineAudio | null>(null);

  const mixer = useCallback((): TimelineAudio => {
    if (!ref.current) ref.current = new TimelineAudio(setBlocked);
    return ref.current;
  }, []);

  const cues = useMemo(() => (tl ? audioCues(tl, srcOf) : []), [tl, srcOf]);
  useEffect(() => { mixer().setCues(cues); }, [cues, mixer]);
  useEffect(() => { mixer().setMuted(muted); }, [muted, mixer]);
  useEffect(() => () => { ref.current?.dispose(); ref.current = null; }, []);

  const sync = useCallback((t: number, playing: boolean, retry?: boolean) => {
    mixer().sync(t, playing, retry);
  }, [mixer]);
  const setMuted = useCallback((m: boolean) => setMutedState(m), []);

  return useMemo(() => ({ sync, muted, setMuted, blocked, cues }),
                 [sync, muted, setMuted, blocked, cues]);
}
