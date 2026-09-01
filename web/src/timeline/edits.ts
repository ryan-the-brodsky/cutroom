/**
 * Pure timeline edit operations — the TS mirror of the server's
 * `cutroom.timeline.edits`. Every function takes a {@link Timeline} and returns
 * a NEW Timeline; the input is never mutated (each op deep-clones first). Clips
 * are identified by `id`; an unknown id (or a kind the op doesn't apply to)
 * yields an unchanged clone so callers can treat every op as total.
 *
 * Rational (frame) time is preserved: a clip's timeline position
 * (`start`/`duration`) stays independent of the source slice it shows
 * (`source_start`/`source_end`), which is what makes slip, ripple trims,
 * freeze-tail-as-an-edit and non-destructive splits expressible.
 *
 * No `validate()` exists on the client (the server is the source of truth); we
 * keep the derived convenience fields (`total_frames`, `duration_seconds`) in
 * sync after every edit so the returned object is internally consistent.
 */

import {
  Clip,
  Timeline,
  clipEnd,
  effectiveSourceEnd,
  framesToSeconds,
  totalFrames,
} from "./model";

const MEDIA_KINDS: ReadonlySet<Clip["kind"]> = new Set(["video", "image", "audio"]);

const newId = (prefix = "c_"): string =>
  prefix + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);

/** Deep clone via JSON round-trip so the input timeline is never touched. */
const clone = (tl: Timeline): Timeline => JSON.parse(JSON.stringify(tl)) as Timeline;

const findClip = (tl: Timeline, clipId: string): Clip | undefined =>
  tl.clips.find((c) => c.id === clipId);

const isMedia = (c: Clip): boolean => MEDIA_KINDS.has(c.kind) && !!c.source;

/** Recompute the server-derived convenience fields, then return the timeline. */
const finalize = (tl: Timeline): Timeline => {
  tl.total_frames = totalFrames(tl);
  tl.duration_seconds = Math.round(framesToSeconds(tl.total_frames, tl.fps) * 1000) / 1000;
  return tl;
};

const sourceStartOf = (c: Clip): number => c.source_start ?? 0;

// --- source-window edits (position & duration fixed) ----------------------

/**
 * Slip a clip's source in/out window by `deltaFrames`, keeping timeline start &
 * duration fixed. Clamped to the available media via the clip's handles; excess
 * is clamped rather than raised.
 */
export function slip(tl: Timeline, clipId: string, deltaFrames: number): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c || !isMedia(c)) return finalize(out);

  const inPt = sourceStartOf(c);
  const outPt = effectiveSourceEnd(c);

  let delta = deltaFrames;
  delta = Math.max(delta, -inPt); // can't slip earlier than the head
  if (c.source_duration != null) {
    delta = Math.min(delta, c.source_duration - outPt); // can't slip past the tail
  }

  c.source_start = inPt + delta;
  c.source_end = outPt + delta;
  return finalize(out);
}

/**
 * Set an explicit source in/out point. When the range length equals the clip
 * duration this is a pure slip; when it differs, `start` is pinned and
 * `duration` is set to the window length (a retime-free trim). Both branches
 * collapse to: start unchanged, window = [sourceStart, sourceEnd), duration =
 * window length. In-point is clamped to >= 0.
 */
export function set_source_range(
  tl: Timeline,
  clipId: string,
  sourceStart: number,
  sourceEnd: number,
): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c || !isMedia(c)) return finalize(out);

  const ss = Math.max(0, Math.trunc(sourceStart));
  const se = Math.trunc(sourceEnd);
  c.source_start = ss;
  c.source_end = se;
  c.duration = se - ss;
  return finalize(out);
}

// --- ripple trims ----------------------------------------------------------

/**
 * Ripple-trim the clip's IN edge. `deltaFrames > 0` extends the head (earlier
 * in-point, longer clip); `< 0` shortens it. `start` and the out-point stay
 * fixed; `duration` changes by the applied delta and every later clip on the
 * same track shifts by that net delta. Bounded by `headHandle` (extend) and
 * duration/window >= 1 (shorten); excess is clamped.
 */
export function ripple_trim_start(
  tl: Timeline,
  clipId: string,
  deltaFrames: number,
): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c || !isMedia(c)) return finalize(out);

  const origEnd = clipEnd(c);
  const inPt = sourceStartOf(c);
  const window = effectiveSourceEnd(c) - inPt;

  let applied: number;
  if (deltaFrames >= 0) {
    applied = Math.min(deltaFrames, inPt); // headHandle === inPt
  } else {
    const maxShorten = Math.min(c.duration, window) - 1;
    applied = Math.max(deltaFrames, -maxShorten);
  }

  // in-point moves by -applied; out-point stays fixed (source_end untouched).
  c.source_start = inPt - applied;
  c.duration = c.duration + applied;
  rippleAfter(out, c, origEnd, applied);
  return finalize(out);
}

/**
 * Ripple-trim the clip's OUT edge. `deltaFrames > 0` extends the tail; `< 0`
 * shortens it. `start` and the in-point stay fixed; `duration` changes by the
 * applied delta and every later clip on the same track shifts by that net delta.
 * Bounded by `tailHandle` (extend, when source_duration is known) and
 * duration/window >= 1 (shorten); excess is clamped.
 */
export function ripple_trim_end(
  tl: Timeline,
  clipId: string,
  deltaFrames: number,
): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c || !isMedia(c)) return finalize(out);

  const origEnd = clipEnd(c);
  const outPt = effectiveSourceEnd(c);
  const window = outPt - sourceStartOf(c);

  let applied: number;
  if (deltaFrames >= 0) {
    applied = c.source_duration != null ? Math.min(deltaFrames, c.source_duration - outPt) : deltaFrames;
  } else {
    const maxShorten = Math.min(c.duration, window) - 1;
    applied = Math.max(deltaFrames, -maxShorten);
  }

  c.source_end = outPt + applied;
  c.duration = c.duration + applied;
  rippleAfter(out, c, origEnd, applied);
  return finalize(out);
}

/** Shift every clip on the edited clip's track starting at/after `thresholdEnd`
 * by `shift` frames (in place, on the working clone). */
function rippleAfter(tl: Timeline, edited: Clip, thresholdEnd: number, shift: number): void {
  if (shift === 0) return;
  for (const c of tl.clips) {
    if (c.id !== edited.id && c.track_id === edited.track_id && c.start >= thresholdEnd) {
      c.start = Math.max(0, c.start + shift);
    }
  }
}

// --- structural edits ------------------------------------------------------

/**
 * Split a clip at absolute timeline frame `atFrame` into two clips sharing the
 * same source. The right clip's `source_start` advances by (atFrame - start) so
 * the source is continuous across the cut; both carry a shared
 * `cutroom.origin_id`. Returns unchanged if `atFrame` is on/outside the clip.
 */
export function split_clip(tl: Timeline, clipId: string, atFrame: number): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c) return finalize(out);
  if (atFrame <= c.start || atFrame >= clipEnd(c)) return finalize(out);

  const offset = atFrame - c.start;
  const origin = (c.cutroom?.origin_id as string | undefined) ?? c.id;

  const second: Clip = {
    id: newId("c_"),
    track_id: c.track_id,
    kind: c.kind,
    start: atFrame,
    duration: c.duration - offset,
    source: c.source,
    source_start: c.source ? sourceStartOf(c) + offset : 0,
    source_end: c.source ? effectiveSourceEnd(c) : undefined,
    source_duration: c.source_duration,
    source_fps: c.source_fps,
    label: c.label,
    text: c.text,
    color: c.color,
    cutroom: { ...(c.cutroom ?? {}), origin_id: origin },
  };

  if (c.source) c.source_end = sourceStartOf(c) + offset;
  c.duration = offset;
  c.cutroom = { ...(c.cutroom ?? {}), origin_id: origin };

  const idx = out.clips.indexOf(c);
  out.clips.splice(idx + 1, 0, second);
  return finalize(out);
}

/** Reposition a clip to a new timeline `start` (no ripple). Clamped to >= 0. */
export function move_clip(tl: Timeline, clipId: string, newStart: number): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c) return finalize(out);
  c.start = Math.max(0, Math.trunc(newStart));
  return finalize(out);
}

/**
 * Remove a clip. With `ripple=true` the gap is closed by shifting every later
 * clip on the same track left by the removed clip's duration.
 */
export function remove_clip(tl: Timeline, clipId: string, ripple = false): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c) return finalize(out);

  const trackId = c.track_id;
  const removedEnd = clipEnd(c);
  const removedDur = c.duration;
  out.clips = out.clips.filter((x) => x.id !== clipId);

  if (ripple) {
    for (const o of out.clips) {
      if (o.track_id === trackId && o.start >= removedEnd) {
        o.start = Math.max(0, o.start - removedDur);
      }
    }
  }
  return finalize(out);
}

/**
 * The FIRST-SECOND LAW as a non-destructive edit: trim a VIDEO clip to its first
 * `liveFrames` frames (source_end = source_start + liveFrames, duration =
 * liveFrames). Only valid on video clips; any other kind is returned unchanged.
 * `liveFrames` outside [1, duration) is a no-op.
 */
export function freeze_tail_trim(tl: Timeline, clipId: string, liveFrames: number): Timeline {
  const out = clone(tl);
  const c = findClip(out, clipId);
  if (!c || c.kind !== "video") return finalize(out);

  const live = Math.trunc(liveFrames);
  if (live < 1 || live >= c.duration) return finalize(out);

  c.source_end = sourceStartOf(c) + live;
  c.duration = live;
  return finalize(out);
}
