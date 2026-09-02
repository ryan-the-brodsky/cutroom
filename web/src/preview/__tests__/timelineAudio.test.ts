/**
 * The Timeline preview's mix, decided without a browser.
 *
 * Everything that matters — which clip is under the playhead, how far into its file,
 * whether it has drifted far enough to be worth a snap — is a pure function over the
 * compiled timeline and a plain snapshot of an element, so it is tested here rather
 * than by staring at a waveform.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DRIFT_SNAP, type AudioCue, type ElState, TimelineAudio, audioCues, cueAction,
  mixSummary, parseGainDb, roleOf, volumeOf,
} from "../timelineAudio";
import type { Clip, Timeline } from "../../timeline/model";

const V = { id: "v1", kind: "video" as const, name: "V1", order: 0 };
const A1 = { id: "a1", kind: "audio" as const, name: "A1", order: 1 };
const MUSIC = { id: "mu", kind: "audio" as const, name: "MUSIC", order: 2 };
const SFX = { id: "sx", kind: "audio" as const, name: "SFX", order: 3 };

const clip = (over: Partial<Clip> & Pick<Clip, "id" | "track_id">): Clip => ({
  kind: "audio", start: 0, duration: 24, source: "audio/x.wav",
  source_start: 0, source_fps: 24, ...over,
} as Clip);

const timeline = (clips: Clip[]): Timeline => ({
  fps: 24, width: 1920, height: 1080,
  tracks: [V, A1, MUSIC, SFX], clips, markers: [],
  total_frames: 240, duration_seconds: 10, cutroom: {},
});

const url = (rel: string) => `/api/projects/p/media/${rel}?token=t`;

const cue = (over: Partial<AudioCue> = {}): AudioCue => ({
  id: "c1", src: url("audio/a.wav"), start: 2, end: 5, offset: 0,
  volume: 1, role: "vo", label: "B01-S1 vo", ...over,
});

const el = (over: Partial<ElState> = {}): ElState =>
  ({ paused: true, currentTime: 0, duration: null, ...over });

describe("audioCues", () => {
  it("takes every audio clip, in timeline seconds, and leaves the picture alone", () => {
    const cues = audioCues(timeline([
      clip({ id: "vid", track_id: V.id, kind: "video", source: "renders/a.mp4" }),
      clip({ id: "vo", track_id: A1.id, start: 24, duration: 36,
             source: "audio/vo.wav", cutroom: { role: "vo" } }),
      clip({ id: "bed", track_id: MUSIC.id, start: 0, duration: 240,
             source: "audio/bed.wav", cutroom: { role: "music", gain: -16 } }),
      clip({ id: "hit", track_id: SFX.id, start: 48, duration: 12,
             source: "audio/hit.wav", cutroom: { role: "sfx" } }),
    ]), url);

    expect(cues.map((c) => c.id)).toEqual(["bed", "vo", "hit"]);   // sorted by start
    expect(cues.find((c) => c.id === "vo")).toMatchObject({
      start: 1, end: 2.5, offset: 0, role: "vo", volume: 1,
      src: url("audio/vo.wav"),
    });
  });

  it("honours a dB gain the film carries, and falls back to the role's level", () => {
    const cues = audioCues(timeline([
      clip({ id: "bed", track_id: MUSIC.id, cutroom: { role: "music", gain: -16 } }),
      clip({ id: "quiet", track_id: MUSIC.id, start: 24, cutroom: { role: "music" } }),
      clip({ id: "hit", track_id: SFX.id, start: 48, cutroom: { role: "sfx" } }),
      clip({ id: "line", track_id: A1.id, start: 72, cutroom: { role: "vo" } }),
    ]), url);
    const by = Object.fromEntries(cues.map((c) => [c.id, c.volume]));
    expect(by.bed).toBeCloseTo(0.158, 3);     // −16 dB, not the 0.5 default
    expect(by.quiet).toBe(0.5);
    expect(by.hit).toBe(0.8);
    expect(by.line).toBe(1);
  });

  it("reads the source in-point at the SOURCE fps, not the timeline's", () => {
    const [c] = audioCues(timeline([
      clip({ id: "a", track_id: A1.id, start: 24, duration: 24,
             source_start: 48, source_fps: 48 }),
    ]), url);
    expect(c.offset).toBe(1);
  });

  it("skips a clip with no media and never claims a video track is audible", () => {
    const cues = audioCues(timeline([
      clip({ id: "gap", track_id: A1.id, source: undefined }),
      clip({ id: "slate", track_id: V.id, kind: "text", source: undefined }),
    ]), url);
    expect(cues).toEqual([]);
  });

  it("falls back to the track name when the compiler set no role", () => {
    expect(roleOf(clip({ id: "x", track_id: MUSIC.id }), "MUSIC")).toBe("music");
    expect(roleOf(clip({ id: "x", track_id: SFX.id }), "SFX")).toBe("sfx");
    expect(roleOf(clip({ id: "x", track_id: A1.id }), "A1")).toBe("vo");
  });
});

describe("parseGainDb", () => {
  it("takes a number as decibels and digs one out of the importer's free text", () => {
    expect(parseGainDb(-16)).toBe(-16);
    expect(parseGainDb("-16dB under narration")).toBe(-16);
    expect(parseGainDb("-8")).toBe(-8);
    expect(parseGainDb(null)).toBeNull();
    expect(parseGainDb("loud")).toBeNull();
  });
  it("never asks an element for a volume above unity", () => {
    expect(volumeOf(clip({ id: "x", track_id: A1.id, cutroom: { gain: 12 } }), "vo"))
      .toBe(1);
  });
});

describe("cueAction", () => {
  it("starts a clip the playhead has entered, from the right place in the file", () => {
    expect(cueAction(cue({ offset: 0.5 }), 3, true, el())).toEqual({ do: "start", at: 1.5 });
  });

  it("leaves a playing clip alone until it drifts past the snap threshold", () => {
    const c = cue();
    expect(cueAction(c, 3, true, el({ paused: false, currentTime: 1.05 })))
      .toEqual({ do: "none" });
    const off = DRIFT_SNAP + 0.05;
    expect(cueAction(c, 3, true, el({ paused: false, currentTime: 1 + off })))
      .toEqual({ do: "snap", at: 1 });
  });

  it("pauses a clip the playhead has left, and says nothing about one already paused", () => {
    expect(cueAction(cue(), 6, true, el({ paused: false, currentTime: 3 })))
      .toEqual({ do: "pause" });
    expect(cueAction(cue(), 6, true, el())).toEqual({ do: "none" });
    expect(cueAction(cue(), 1, true, el())).toEqual({ do: "none" });   // not there yet
  });

  it("parks the head where a scrub left it, so the next play is in sync", () => {
    expect(cueAction(cue(), 4, false, el({ currentTime: 0 })))
      .toEqual({ do: "park", at: 2 });
    expect(cueAction(cue(), 4, false, el({ currentTime: 2 })))
      .toEqual({ do: "none" });
    expect(cueAction(cue(), 4, false, el({ paused: false, currentTime: 2 })))
      .toEqual({ do: "park", at: 2 });
  });

  it("lets a file shorter than its slot run out instead of looping its tail", () => {
    const c = cue({ start: 0, end: 10 });
    expect(cueAction(c, 9, true, el({ paused: true, currentTime: 2, duration: 2 })))
      .toEqual({ do: "none" });
    expect(cueAction(c, 9, true, el({ paused: false, currentTime: 2, duration: 2 })))
      .toEqual({ do: "pause" });
    // …and still starts it when the playhead is back inside the media.
    expect(cueAction(c, 1, true, el({ paused: true, currentTime: 2, duration: 2 })))
      .toEqual({ do: "start", at: 1 });
  });
});

describe("mixSummary", () => {
  it("counts what the film will actually sound", () => {
    expect(mixSummary([
      cue({ id: "a", role: "vo" }), cue({ id: "b", role: "vo" }),
      cue({ id: "c", role: "music" }), cue({ id: "d", role: "sfx" }),
    ])).toBe("2 VO lines · 1 music cue · 1 SFX");
    expect(mixSummary([cue({ role: "vo" })])).toBe("1 VO line");
    expect(mixSummary([])).toBe("");
  });
});

// --------------------------------------------------------------- the DOM shell

/** Just enough <audio> to drive the mixer: jsdom's own element cannot play. */
class FakeAudio {
  static made: FakeAudio[] = [];
  src = "";
  preload = "auto";
  volume = 1;
  muted = false;
  paused = true;
  currentTime = 0;
  duration = NaN;
  plays = 0;
  loads = 0;
  /** Set to an error name to make the next play() refuse. */
  refuse: string | null = null;

  constructor() { FakeAudio.made.push(this); }
  play(): Promise<void> {
    this.plays += 1;
    if (this.refuse) {
      return Promise.reject(Object.assign(new Error("nope"), { name: this.refuse }));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void { this.paused = true; }
  load(): void { this.loads += 1; }
  removeAttribute(): void { this.src = ""; }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TimelineAudio", () => {
  const cues = [
    cue({ id: "a", start: 0, end: 2, src: url("a.wav"), volume: 1 }),
    cue({ id: "b", start: 2, end: 4, src: url("b.wav"), volume: 0.5, role: "music" }),
  ];
  const made = () => FakeAudio.made;

  beforeEach(() => {
    FakeAudio.made = [];
    (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
  });

  it("mints nothing until play, then one element per clip, under the gesture", () => {
    const mix = new TimelineAudio();
    mix.setCues(cues);
    mix.sync(0.5, false);
    expect(made()).toHaveLength(0);

    mix.sync(0.5, true, true);
    expect(made()).toHaveLength(2);
    const [a, b] = made();
    expect(a.src).toBe(url("a.wav"));
    expect(a.paused).toBe(false);
    expect(a.currentTime).toBe(0.5);
    expect(b.paused).toBe(true);          // the playhead is not on it yet
    expect(b.volume).toBe(0.5);
  });

  it("hands the film over from one clip to the next, and snaps a drifted one", () => {
    const mix = new TimelineAudio();
    mix.setCues(cues);
    mix.sync(0.5, true, true);
    const [a, b] = made();

    mix.sync(2.5, true);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
    expect(b.currentTime).toBe(0.5);

    b.currentTime = 0.55;                 // inside the snap window: left alone
    mix.sync(2.6, true);
    expect(b.currentTime).toBe(0.55);
    b.currentTime = 1.4;                  // 0.7s off the playhead: snapped back
    mix.sync(2.7, true);
    expect(b.currentTime).toBeCloseTo(0.7, 6);
  });

  it("parks the mix where a scrub left it, paused", () => {
    const mix = new TimelineAudio();
    mix.setCues(cues);
    mix.sync(0.5, true, true);
    mix.sync(3, false, true);
    const [a, b] = made();
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(true);
    expect(b.currentTime).toBe(1);
  });

  it("mutes and unmutes every element it owns", () => {
    const mix = new TimelineAudio();
    mix.setCues(cues);
    mix.sync(0.5, true, true);
    mix.setMuted(true);
    expect(made().every((e) => e.muted)).toBe(true);
    mix.setMuted(false);
    expect(made().some((e) => e.muted)).toBe(false);
  });

  it("stops retrying a refused play until something asks again", async () => {
    const seen: boolean[] = [];
    const mix = new TimelineAudio((b) => seen.push(b));
    mix.setCues(cues);
    FakeAudio.made = [];
    mix.sync(0.5, true, true);
    const a = made()[0];
    a.refuse = "NotAllowedError";
    // the first attempt happened before we could arm the refusal; force another
    a.paused = true;
    mix.sync(0.6, true, true);
    await flush();
    expect(mix.blocked).toBe(true);
    expect(seen).toContain(true);

    const before = a.plays;
    mix.sync(0.7, true);                  // the frame loop must not hammer it
    mix.sync(0.8, true);
    expect(a.plays).toBe(before);

    a.refuse = null;
    mix.sync(0.9, true, true);            // …but a press of ▶ tries again
    await flush();
    expect(a.plays).toBe(before + 1);
    expect(mix.blocked).toBe(false);
  });

  it("lets go of the media when the page leaves", () => {
    const mix = new TimelineAudio();
    mix.setCues(cues);
    mix.sync(0.5, true, true);
    mix.dispose();
    expect(made().every((e) => e.paused && e.src === "")).toBe(true);
  });
});
