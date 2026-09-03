/**
 * The Genga Studio timeline model — the TS mirror of the server's
 * `cutroom.timeline.model` (see FOUNDATION.md §4). Frame-based rational time
 * (integer frames + a timeline fps — never float seconds); a clip's timeline
 * position (`start`/`duration`) is independent of the source slice it shows
 * (`source_start`/`source_end`), and `source_duration` is retained so media
 * handles exist for transitions.
 *
 * Field names are snake_case to match the server JSON wire format exactly — the
 * server is the source of truth, so there is no mapping layer to drift.
 */

export type ClipKind = "video" | "image" | "audio" | "text";
export type TrackKind = "video" | "audio";

export interface Clip {
  id: string;
  track_id: string;
  kind: ClipKind;
  start: number; // timeline start frame
  duration: number; // timeline duration in frames (>= 1)
  // source (media kinds)
  source?: string; // project-relative asset path == mediaId
  source_start?: number; // in-point, source frames (default 0)
  source_end?: number; // out-point, source frames (default start + duration)
  source_duration?: number; // total source frames — handle bounds
  source_fps?: number;
  // presentation
  label?: string;
  text?: string; // text kind
  color?: string; // text kind
  // lineage — what OTIO/FreeCut can't hold
  cutroom?: {
    shot?: string;
    take?: string;
    take_kind?: string;
    prompt?: string;
    model?: string;
    seed?: number;
    [k: string]: unknown;
  };
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  order: number;
}

export interface Marker {
  id: string;
  frame: number;
  label: string;
  color: string;
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  total_frames: number; // server-computed convenience
  duration_seconds: number; // server-computed convenience
  cutroom: Record<string, unknown>;
}

// --- pure helpers (mirror model.py) ---------------------------------------

export const framesToSeconds = (frames: number, fps: number): number => frames / fps;
export const secondsToFrames = (seconds: number, fps: number): number =>
  Math.round(seconds * fps);

export const effectiveSourceEnd = (c: Clip): number =>
  c.source_end ?? (c.source_start ?? 0) + c.duration;

/** Source frames available before the in-point (for a leading transition). */
export const headHandle = (c: Clip): number => c.source_start ?? 0;

/** Source frames available after the out-point, or null if source length unknown. */
export const tailHandle = (c: Clip): number | null =>
  c.source_duration == null ? null : c.source_duration - effectiveSourceEnd(c);

export const clipEnd = (c: Clip): number => c.start + c.duration;

export const totalFrames = (tl: Timeline): number =>
  tl.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

export const clipsOnTrack = (tl: Timeline, trackId: string): Clip[] =>
  tl.clips.filter((c) => c.track_id === trackId).sort((a, b) => a.start - b.start);

/**
 * A key for this clip that survives a recompile, unlike `id`: the server
 * mints a fresh random id for EVERY clip whenever anything in the film
 * changes (the whole-film compile is cached by a fingerprint over the whole
 * project, not per clip — see `cutroom.timeline.compile`), so `id` churns
 * project-wide on an edit to a single shot.
 *
 * The live preview (`preview/PreviewStage.tsx`'s `<Sequence>` key, and the
 * audio mix's element pool in `preview/timelineAudio.ts`) keys on this
 * instead, so an edit to shot B does not remount shot A's still-playing
 * video or reset its still-sounding VO line. Derived from the `cutroom`
 * lineage the server always attaches: a cue's own id when it has one, else
 * the shot (+ line, for a VO clip) it belongs to. Falls back to `id` when a
 * clip carries no lineage at all — never true of a server-compiled clip, so
 * hand-built fixtures in tests behave exactly as before.
 */
export function stableClipKey(c: Clip): string {
  const cr = (c.cutroom || {}) as Record<string, unknown>;
  if (cr.cue != null) return `cue:${cr.cue}`;
  if (cr.shot == null) return c.id;    // no lineage to key on — id is all there is
  return c.kind === "audio"
    ? `${cr.role != null ? String(cr.role) : "audio"}:${cr.shot}:${cr.line ?? 0}`
    : `v:${cr.shot}`;
}

/** Tracks in render order (video under, ordered by `order`). */
export const orderedTracks = (tl: Timeline): Track[] =>
  [...tl.tracks].sort((a, b) => a.order - b.order);
