/**
 * Hear the shot — the Shot Editor monitor's preview mix.
 *
 * The assembler only mixes VO, the music bed and SFX when it cuts the film, so
 * a take reviewed in the monitor used to play silent. `GET
 * /api/projects/:pid/shots/:sid/audio-plan` returns the same placement the cut
 * would use, scoped to one shot; `ShotMixer` plays it in the browser and keeps
 * it locked to the monitor's `<video>`.
 *
 * All the arithmetic — which source starts when, how far into its file, at what
 * gain, and when the mix has drifted off the picture — lives in the exported
 * pure functions below and is unit-tested with a fake clock. The class is a thin
 * Web Audio shell around them.
 *
 * Times in a plan are SHOT-RELATIVE seconds, except `shot_start` (film time).
 * Gain is decibels, as it is everywhere else in Genga Studio: 0 is unity.
 */

// ------------------------------------------------------------------ the plan

export interface PlanVo {
  path: string;
  at: number;                 // seconds after the shot's head
  duration: number | null;
  muted: boolean;
}

export interface PlanCue {
  id?: string | null;
  kind?: "music" | "sfx";
  path: string;
  at: number;                 // seconds after the shot's head
  offset_into_file: number;   // a bed that started earlier joins mid-file
  duration_in_shot: number;
  gain_db: number;
  fade_in: number;
  fade_out: number;
  loop: boolean;
  label?: string | null;
}

export interface AudioPlan {
  sid?: string;
  shot_start: number;         // film seconds
  seconds: number;            // the shot's window
  head_pad?: number;
  vo: PlanVo | null;
  music: PlanCue[];
  sfx: PlanCue[];
}

export type TrackKind = "vo" | "music" | "sfx";

/** One playable thing in the shot's window, in shot-relative seconds. */
export interface MixTrack {
  key: string;
  kind: TrackKind;
  path: string;
  at: number;
  offset: number;             // seconds into the source file at `at`
  duration: number;
  gain: number;               // linear
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
  label: string;
}

/** A track resolved against a playhead: when to start it on the audio clock. */
export interface ScheduledSource extends MixTrack {
  when: number;               // AudioContext time
  startOffset: number;        // seconds into the file at `when`
  playFor: number;            // seconds still to play
}

export const DRIFT_THRESHOLD = 0.12;   // seconds — resync past this
const EPS = 1e-4;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

// ------------------------------------------------------------ plan → tracks

/**
 * Flatten a plan into the tracks that actually sound. The muted VO is dropped
 * here (it is still shown in the track list — the reviewer wants to know a line
 * is being silenced, they just must not hear it).
 */
export function planTracks(plan: AudioPlan | null | undefined): MixTrack[] {
  if (!plan) return [];
  const out: MixTrack[] = [];
  const window = Math.max(0, Number(plan.seconds) || 0);
  const clamp = (at: number, dur: number) => Math.max(0, Math.min(dur, window - at));

  const vo = plan.vo;
  if (vo && !vo.muted && vo.path) {
    const at = Math.max(0, Number(vo.at) || 0);
    // A line may legally run past the cut (the assembler's audio-fit stretches
    // the shot for it); the preview plays what fits in the window.
    const dur = clamp(at, Number(vo.duration) || 0);
    if (dur > EPS) {
      out.push({
        key: "vo", kind: "vo", path: vo.path, at, offset: 0, duration: dur,
        gain: 1, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false, label: "VO",
      });
    }
  }

  const addCues = (rows: PlanCue[] | undefined, kind: TrackKind) => {
    (rows || []).forEach((c, i) => {
      if (!c?.path) return;
      const at = Math.max(0, Number(c.at) || 0);
      const dur = clamp(at, Number(c.duration_in_shot) || 0);
      if (dur <= EPS) return;
      const gainDb = Number(c.gain_db) || 0;
      out.push({
        key: c.id || `${kind}:${c.path}:${i}`,
        kind, path: c.path, at,
        offset: Math.max(0, Number(c.offset_into_file) || 0),
        duration: dur,
        gain: dbToGain(gainDb), gainDb,
        fadeIn: Math.max(0, Number(c.fade_in) || 0),
        fadeOut: Math.max(0, Number(c.fade_out) || 0),
        loop: !!c.loop,
        label: c.label || c.path.split("/").pop() || kind,
      });
    });
  };
  addCues(plan.music, "music");
  addCues(plan.sfx, "sfx");
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

// ------------------------------------------------------------- the schedule

/**
 * Resolve tracks against a playhead. `now` is the AudioContext clock reading at
 * the instant the playhead is `playhead`; everything in the future is scheduled
 * relative to it, and a track already underway starts immediately, seeked into
 * its file. Tracks already finished are dropped.
 */
export function scheduleAt(tracks: MixTrack[], playhead: number,
                           now: number): ScheduledSource[] {
  const out: ScheduledSource[] = [];
  for (const t of tracks) {
    const end = t.at + t.duration;
    if (playhead >= end - EPS) continue;            // over already
    const into = Math.max(0, playhead - t.at);      // joined mid-track
    const startsAt = t.at + into;                   // shot-relative
    out.push({
      ...t,
      when: now + (startsAt - playhead),
      startOffset: t.offset + into,
      playFor: end - startsAt,
      // a fade-in half spent when we joined finishes in what remains of it
      fadeIn: Math.max(0, t.fadeIn - into),
    });
  }
  return out;
}

/** True when the mix has slipped far enough off the picture to matter. */
export function needsResync(pictureTime: number, mixTime: number,
                            threshold: number = DRIFT_THRESHOLD): boolean {
  if (!Number.isFinite(pictureTime) || !Number.isFinite(mixTime)) return false;
  return Math.abs(pictureTime - mixTime) > threshold;
}

/** One line for the reviewer: "VO 0.6s · bed −8 dB · sfx 1.2s". */
export function describeTracks(plan: AudioPlan | null | undefined): string {
  if (!plan) return "";
  const bits: string[] = [];
  if (plan.vo) {
    const d = plan.vo.duration ? `${plan.vo.duration.toFixed(1)}s` : "";
    bits.push(`VO ${d}${plan.vo.muted ? " (muted)" : ""}`.trim());
  }
  for (const c of plan.music || []) {
    bits.push(`${c.label || "bed"} ${fmtDb(c.gain_db)}`);
  }
  for (const c of plan.sfx || []) {
    bits.push(`${c.label || "sfx"} ${c.duration_in_shot.toFixed(1)}s`);
  }
  return bits.join(" · ");
}

/** Decibels with a real minus sign, the way the cue strip prints them. */
export function fmtDb(db: number): string {
  const n = Math.round((Number(db) || 0) * 10) / 10;
  return `${n < 0 ? "−" : ""}${Math.abs(n)} dB`;
}

// ----------------------------------------------------------------- the mixer

export interface MixerOptions {
  /** Decode one project-relative path into a buffer (fetch + decodeAudioData). */
  load: (path: string) => Promise<AudioBuffer>;
  /** Injected for tests; in the app the page makes one on the first click. */
  context?: AudioContext;
  onError?: (path: string, err: unknown) => void;
}

interface Live { src: AudioBufferSourceNode; gain: GainNode }

/**
 * Plays an audio plan against a transport. The picture (a `<video>`, or the
 * still-hold timer) owns the clock; the mixer follows it and resyncs when it
 * drifts past `DRIFT_THRESHOLD`.
 */
export class ShotMixer {
  private opts: MixerOptions;
  private ctx: AudioContext | null;
  private master: GainNode | null = null;
  private tracks: MixTrack[] = [];
  private live: Live[] = [];
  private buffers = new Map<string, AudioBuffer | null>();
  private playing = false;
  private head = 0;                 // shot-relative seconds at `anchor`
  private anchor = 0;               // AudioContext time for `head`
  private enabled = true;
  private generation = 0;

  constructor(opts: MixerOptions) {
    this.opts = opts;
    this.ctx = opts.context ?? null;
  }

  /** Create/resume the context. MUST be called from a user gesture. */
  async resume(make?: () => AudioContext): Promise<AudioContext | null> {
    if (!this.ctx && make) this.ctx = make();
    if (!this.ctx) return null;
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch { /* blocked; caller retries */ }
    }
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 1 : 0;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  setPlan(plan: AudioPlan | null): void {
    this.tracks = planTracks(plan);
    this.buffers.clear();
    if (this.playing) this.seek(this.currentTime);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 1 : 0;
    if (!on) this.stopSources();
    else if (this.playing) this.seek(this.currentTime);
  }

  get isEnabled(): boolean { return this.enabled; }
  get isPlaying(): boolean { return this.playing; }

  get currentTime(): number {
    if (!this.playing || !this.ctx) return this.head;
    return this.head + (this.ctx.currentTime - this.anchor);
  }

  async play(atSec?: number): Promise<void> {
    if (typeof atSec === "number") this.head = Math.max(0, atSec);
    this.playing = true;
    await this.schedule();
  }

  pause(): void {
    this.head = this.currentTime;
    this.playing = false;
    this.stopSources();
  }

  seek(sec: number): void {
    this.head = Math.max(0, sec);
    if (this.ctx) this.anchor = this.ctx.currentTime;
    this.stopSources();
    if (this.playing) void this.schedule();
  }

  /** Follow a media element: its clock wins, always. */
  attach(el: HTMLMediaElement): () => void {
    const onPlay = () => { void this.play(el.currentTime); };
    const onPause = () => this.pause();
    const onSeek = () => this.seek(el.currentTime);
    const onTime = () => {
      if (!this.playing) return;
      if (needsResync(el.currentTime, this.currentTime)) this.seek(el.currentTime);
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("seeking", onSeek);
    el.addEventListener("seeked", onSeek);
    el.addEventListener("timeupdate", onTime);
    if (!el.paused) void this.play(el.currentTime);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("seeking", onSeek);
      el.removeEventListener("seeked", onSeek);
      el.removeEventListener("timeupdate", onTime);
      this.pause();
    };
  }

  dispose(): void {
    this.stopSources();
    this.playing = false;
    this.buffers.clear();
    try { this.master?.disconnect(); } catch { /* already gone */ }
    this.master = null;
  }

  // ------------------------------------------------------------- internals

  private stopSources(): void {
    for (const l of this.live) {
      try { l.src.onended = null; l.src.stop(); } catch { /* already stopped */ }
      try { l.src.disconnect(); l.gain.disconnect(); } catch { /* gone */ }
    }
    this.live = [];
  }

  private async buffer(path: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(path)) return this.buffers.get(path) ?? null;
    try {
      const b = await this.opts.load(path);
      this.buffers.set(path, b);
      return b;
    } catch (e) {
      this.buffers.set(path, null);       // do not retry a broken path per seek
      this.opts.onError?.(path, e);
      return null;
    }
  }

  private async schedule(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.tracks.length) return;
    const gen = ++this.generation;
    // decode first so every source starts against ONE clock reading
    const rows = scheduleAt(this.tracks, this.head, 0);
    const bufs = await Promise.all(rows.map((r) => this.buffer(r.path)));
    if (gen !== this.generation || !this.playing) return;

    this.anchor = ctx.currentTime;
    const base = this.anchor + 0.02;      // a beat of headroom to build the graph
    this.stopSources();
    rows.forEach((r, i) => {
      const buf = bufs[i];
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(this.master!);

      const when = base + r.when;
      const offset = r.loop && buf.duration > 0
        ? r.startOffset % buf.duration
        : Math.min(r.startOffset, Math.max(0, buf.duration - 0.001));
      const dur = r.loop
        ? r.playFor
        : Math.max(0, Math.min(r.playFor, buf.duration - offset));
      if (dur <= EPS) return;
      if (r.loop) { src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration; }

      const g = gain.gain;
      const stop = when + dur;
      if (r.fadeIn > EPS) {
        g.setValueAtTime(1e-4, when);
        g.exponentialRampToValueAtTime(Math.max(r.gain, 1e-4),
                                       when + Math.min(r.fadeIn, dur));
      } else {
        g.setValueAtTime(r.gain, when);
      }
      if (r.fadeOut > EPS && dur > r.fadeOut) {
        g.setValueAtTime(r.gain, stop - r.fadeOut);
        g.exponentialRampToValueAtTime(1e-4, stop);
      }
      try {
        src.start(when, offset, r.loop ? dur : undefined);
        if (r.loop) src.stop(stop);
      } catch { return; }
      this.live.push({ src, gain });
    });
  }
}

/** The app's loader: fetch through the media route (token already appended). */
export function bufferLoader(ctx: AudioContext,
                             url: (path: string) => string) {
  return async (path: string): Promise<AudioBuffer> => {
    const r = await fetch(url(path));
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return ctx.decodeAudioData(await r.arrayBuffer());
  };
}
