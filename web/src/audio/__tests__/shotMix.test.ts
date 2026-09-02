/**
 * The preview mixer's arithmetic: plan → tracks → schedule, plus drift.
 * No real AudioContext — jsdom has none, and none is needed: everything the
 * mixer decides is pure, and the clock is passed in.
 */
import { describe, expect, it } from "vitest";

import {
  DRIFT_THRESHOLD, type AudioPlan, dbToGain, describeTracks, fmtDb,
  needsResync, planTracks, scheduleAt,
} from "../shotMix";

const plan = (over: Partial<AudioPlan> = {}): AudioPlan => ({
  sid: "B01-S2", shot_start: 3, seconds: 3, head_pad: 0.3,
  vo: null, music: [], sfx: [], ...over,
});

const cue = (over: Record<string, unknown> = {}) => ({
  path: "audio/music/bed.wav", at: 0, offset_into_file: 0,
  duration_in_shot: 3, gain_db: -8, fade_in: 0, fade_out: 0, loop: false,
  label: "bed", ...over,
}) as any;

describe("dbToGain", () => {
  it("treats 0 dB as unity and −6 dB as about half the amplitude", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 6);
  });
  it("prints decibels with a real minus sign", () => {
    expect(fmtDb(-8)).toBe("−8 dB");
    expect(fmtDb(0)).toBe("0 dB");
  });
});

describe("planTracks", () => {
  it("lays VO at its head-pad offset with unity gain", () => {
    const t = planTracks(plan({ vo: { path: "audio/generated/a.wav", at: 0.8, duration: 1.2, muted: false } }));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "vo", at: 0.8, duration: 1.2, gain: 1, offset: 0 });
  });

  it("drops a muted VO from the mix", () => {
    const t = planTracks(plan({ vo: { path: "a.wav", at: 0.3, duration: 1, muted: true } }));
    expect(t).toEqual([]);
  });

  it("carries a bed's offset_into_file, gain and fades through", () => {
    const t = planTracks(plan({
      music: [cue({ offset_into_file: 6, fade_in: 0.5, fade_out: 1.5 })],
    }));
    expect(t[0]).toMatchObject({
      kind: "music", at: 0, offset: 6, duration: 3, gainDb: -8,
      fadeIn: 0.5, fadeOut: 1.5, loop: false, label: "bed",
    });
    expect(t[0].gain).toBeCloseTo(dbToGain(-8), 6);
  });

  it("clips a track that would run past the shot's window", () => {
    const t = planTracks(plan({ seconds: 2, sfx: [cue({ at: 1.5, duration_in_shot: 3, kind: "sfx" })] }));
    expect(t[0].duration).toBeCloseTo(0.5, 6);
  });

  it("drops a track with nothing left to play", () => {
    expect(planTracks(plan({ sfx: [cue({ at: 3, duration_in_shot: 1 })] }))).toEqual([]);
  });

  it("orders by start time", () => {
    const t = planTracks(plan({
      vo: { path: "vo.wav", at: 0.8, duration: 1, muted: false },
      music: [cue({ at: 0 })],
      sfx: [cue({ path: "audio/sfx/door.wav", at: 0.4, duration_in_shot: 0.8, label: "door" })],
    }));
    expect(t.map((r) => r.kind)).toEqual(["music", "sfx", "vo"]);
  });
});

describe("scheduleAt", () => {
  const tracks = planTracks(plan({
    vo: { path: "vo.wav", at: 0.8, duration: 1.2, muted: false },
    music: [cue({ offset_into_file: 6 })],
    sfx: [cue({ path: "audio/sfx/door.wav", at: 2.0, duration_in_shot: 0.5, label: "door" })],
  }));

  it("schedules everything ahead of a playhead at the head of the shot", () => {
    const s = scheduleAt(tracks, 0, 100);
    expect(s.map((r) => r.when)).toEqual([100, 100.8, 102]);
    expect(s.map((r) => r.startOffset)).toEqual([6, 0, 0]);
    expect(s.map((r) => r.playFor)).toEqual([3, 1.2, 0.5]);
  });

  it("starts a track already underway now, seeked into its file", () => {
    const s = scheduleAt(tracks, 1.5, 50);
    const bed = s.find((r) => r.kind === "music")!;
    expect(bed.when).toBe(50);              // immediately
    expect(bed.startOffset).toBeCloseTo(7.5, 6);   // 6 into the file + 1.5 elapsed
    expect(bed.playFor).toBeCloseTo(1.5, 6);
    const vo = s.find((r) => r.kind === "vo")!;
    expect(vo.when).toBe(50);
    expect(vo.startOffset).toBeCloseTo(0.7, 6);
  });

  it("drops what has already finished", () => {
    const s = scheduleAt(tracks, 2.6, 0);
    expect(s.map((r) => r.kind)).toEqual(["music"]);   // VO and the door are over
  });

  it("shortens a fade-in we joined halfway through", () => {
    const t = planTracks(plan({ music: [cue({ fade_in: 1.0 })] }));
    expect(scheduleAt(t, 0, 0)[0].fadeIn).toBe(1);
    expect(scheduleAt(t, 0.4, 0)[0].fadeIn).toBeCloseTo(0.6, 6);
    expect(scheduleAt(t, 2.0, 0)[0].fadeIn).toBe(0);
  });

  it("is stable under a fake clock — only `when` moves with it", () => {
    const a = scheduleAt(tracks, 0.5, 0);
    const b = scheduleAt(tracks, 0.5, 1234.5);
    b.forEach((r, i) => expect(r.when - 1234.5).toBeCloseTo(a[i].when, 6));
    expect(b.map((r) => r.startOffset)).toEqual(a.map((r) => r.startOffset));
  });
});

describe("needsResync", () => {
  it("tolerates small slip and catches real drift", () => {
    expect(needsResync(1.0, 1.05)).toBe(false);
    expect(needsResync(0, DRIFT_THRESHOLD)).toBe(false);   // exactly on the line
    expect(needsResync(1.0, 1.3)).toBe(true);
    expect(needsResync(1.3, 1.0)).toBe(true);      // either direction
  });
  it("ignores a clock that is not a number yet", () => {
    expect(needsResync(NaN, 1)).toBe(false);
    expect(needsResync(1, Infinity)).toBe(false);
  });
  it("takes a custom threshold", () => {
    expect(needsResync(1, 1.06, 0.05)).toBe(true);
  });
});

describe("describeTracks", () => {
  it("writes the one line the reviewer reads under the monitor", () => {
    const line = describeTracks(plan({
      vo: { path: "vo.wav", at: 0.8, duration: 0.6, muted: false },
      music: [cue({ gain_db: -8 })],
      sfx: [cue({ path: "audio/sfx/door.wav", duration_in_shot: 1.2, label: "sfx" })],
    }));
    expect(line).toBe("VO 0.6s · bed −8 dB · sfx 1.2s");
  });
  it("says when a line is muted", () => {
    expect(describeTracks(plan({ vo: { path: "a.wav", at: 0.3, duration: 1, muted: true } })))
      .toBe("VO 1.0s (muted)");
  });
  it("is empty with no plan", () => {
    expect(describeTracks(null)).toBe("");
    expect(describeTracks(plan())).toBe("");
  });
});
