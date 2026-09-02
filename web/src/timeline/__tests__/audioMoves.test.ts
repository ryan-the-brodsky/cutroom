/**
 * Moving audio: the threshold, the snapping, and the conversion back into the
 * fields the server actually stores.
 *
 * The conversion is the load-bearing part. A clip's place on the Timeline is
 * compiled — VO at `shot start + head_pad + vo_offset`, a cue at its anchor plus
 * its offset — so a drag that wrote frame numbers would write nothing at all.
 * These tests are the proof that the inverse is right, because the only other
 * way to find out is to cut the film and listen.
 */
import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX, audioOverlaps, describeOverlaps, isDrag, planMove,
  snapStart, snapTargets, voLines,
} from "../audioMoves";
import type { Clip, Timeline } from "../model";

const V = { id: "v1", kind: "video" as const, name: "V1", order: 0 };
const A1 = { id: "a1", kind: "audio" as const, name: "A1", order: 1 };
const MUSIC = { id: "mu", kind: "audio" as const, name: "MUSIC", order: 2 };
const SFX = { id: "sx", kind: "audio" as const, name: "SFX", order: 3 };

const clip = (over: Partial<Clip> & Pick<Clip, "id" | "track_id">): Clip => ({
  kind: "audio", start: 0, duration: 24, source: "audio/x.wav", ...over,
} as Clip);

/** Two 4s shots (96f at 24fps), B01-S2 starting at frame 96. */
const film = (clips: Clip[], cutroom: Record<string, unknown> = {}): Timeline => ({
  fps: 24, width: 1920, height: 1080,
  tracks: [V, A1, MUSIC, SFX],
  clips: [
    clip({ id: "pic1", track_id: V.id, kind: "video", start: 0, duration: 96,
           label: "B01-S1", cutroom: { shot: "B01-S1" } }),
    clip({ id: "pic2", track_id: V.id, kind: "video", start: 96, duration: 96,
           label: "B01-S2", cutroom: { shot: "B01-S2" } }),
    ...clips,
  ],
  markers: [], total_frames: 192, duration_seconds: 8,
  cutroom: { head_pad: 0.3, ...cutroom },
});

describe("click or drag", () => {
  it("treats a twitch as a click and real travel as a drag", () => {
    expect(isDrag(0)).toBe(false);
    expect(isDrag(3)).toBe(false);
    expect(isDrag(-DRAG_THRESHOLD_PX)).toBe(true);
    expect(isDrag(40)).toBe(true);
  });
});

describe("snapStart", () => {
  const tl = film([]);
  const targets = snapTargets(tl, 40);          // playhead at frame 40

  it("offers the playhead and both edges of every shot, and no audio", () => {
    expect(targets.map((t) => t.frame)).toEqual([0, 40, 96, 192]);
    expect(targets.find((t) => t.frame === 40)?.kind).toBe("playhead");
    expect(targets.find((t) => t.frame === 96)?.label).toBe("B01-S2");
    expect(targets.find((t) => t.frame === 192)?.label).toBe("after B01-S2");
  });

  it("lands on the cut it was aiming at", () => {
    expect(snapStart(93, { targets, within: 6, fps: 24, max: 191 }))
      .toEqual({ start: 96, to: "shot", label: "B01-S2" });
  });

  it("prefers the playhead when a cut is exactly as close", () => {
    const both = [{ frame: 40, kind: "playhead" as const, label: "playhead" },
                  { frame: 44, kind: "shot" as const, label: "B01-S2" }];
    expect(snapStart(42, { targets: both, within: 6, fps: 24, max: 191 }).to)
      .toBe("playhead");
  });

  it("falls back to the quarter-second grid, never to a random frame", () => {
    const far = snapStart(53, { targets, within: 6, fps: 24, max: 191 });
    expect(far).toEqual({ start: 54, to: "grid", label: null });   // 2.25s
    expect(snapStart(50, { targets, within: 6, fps: 24, max: 191 }).start).toBe(48);
  });

  it("keeps the clip inside the film", () => {
    expect(snapStart(-80, { targets, within: 6, fps: 24, max: 191 }).start).toBe(0);
    expect(snapStart(9999, { targets, within: 6, fps: 24, max: 191 }).start).toBe(191);
  });
});

describe("planMove — VO becomes vo_offset", () => {
  const vo = clip({ id: "vo0", track_id: A1.id, start: 103, duration: 48,
                    label: "B01-S2 vo", cutroom: { shot: "B01-S2", role: "vo", line: 0 } });

  it("inverts the compile: offset = start − shot start − head pad", () => {
    // B01-S2 starts at frame 96 (4s); head pad 0.3s. Dropping the line at 5.0s
    // means 5.0 − 4.0 − 0.3 = 0.7s after the pad.
    const plan = planMove(film([vo]), vo, 120);
    expect(plan).toMatchObject({ target: "vo", sid: "B01-S2", at: 5, voOffset: 0.7, lines: 1 });
  });

  it("reads the head pad off the timeline rather than keeping its own copy", () => {
    const tl = film([vo], { head_pad: 0 });
    expect(planMove(tl, vo, 120)).toMatchObject({ voOffset: 1 });
  });

  it("pulls a line before the pad with a negative offset", () => {
    expect(planMove(film([vo]), vo, 96)).toMatchObject({ at: 4, voOffset: -0.3 });
  });

  it("measures a second line from the end of the first — one offset moves both", () => {
    const line0 = clip({ id: "vo0", track_id: A1.id, start: 103, duration: 24,
                         cutroom: { shot: "B01-S2", role: "vo", line: 0 } });
    const line1 = clip({ id: "vo1", track_id: A1.id, start: 127, duration: 24,
                         cutroom: { shot: "B01-S2", role: "vo", line: 1 } });
    const tl = film([line0, line1]);
    expect(voLines(tl, "B01-S2").map((c) => c.id)).toEqual(["vo0", "vo1"]);
    // Drop line 1 at 6.0s: 6.0 − 4.0 − 0.3 − 1.0 (line 0's length) = 0.7s.
    expect(planMove(tl, line1, 144))
      .toMatchObject({ target: "vo", voOffset: 0.7, lines: 2 });
  });

  it("refuses when there is nothing to write the offset against", () => {
    const orphan = clip({ id: "vo9", track_id: A1.id, start: 10,
                          cutroom: { role: "vo" } });
    expect(planMove(film([orphan]), orphan, 24))
      .toMatchObject({ target: "blocked" });
    const ghost = clip({ id: "vo8", track_id: A1.id, start: 10,
                         cutroom: { role: "vo", shot: "B09-S9" } });
    expect(planMove(film([ghost]), ghost, 24).target).toBe("blocked");
  });
});

describe("planMove — a cue becomes its own placement", () => {
  it("names the cue and the film time to put it at", () => {
    const cue = clip({ id: "c1", track_id: SFX.id, start: 240, duration: 12,
                       label: "sfx:door.mp3",
                       cutroom: { role: "sfx", cue: "cue_door77" } });
    expect(planMove(film([cue]), cue, 108))
      .toMatchObject({ target: "cue", cue: "cue_door77", role: "sfx", at: 4.5 });
  });

  it("says so plainly when a cue predates cue ids", () => {
    const cue = clip({ id: "c2", track_id: MUSIC.id, start: 0, duration: 48,
                       cutroom: { role: "music" } });
    const plan = planMove(film([cue]), cue, 24);
    expect(plan.target).toBe("blocked");
    expect(plan).toHaveProperty("why", expect.stringContaining("id"));
  });

  it("never moves picture: a shot's place comes from the film", () => {
    const tl = film([]);
    const picture = tl.clips[0];
    expect(planMove(tl, picture, 500)).toMatchObject({ target: "blocked" });
  });
});

describe("overlaps", () => {
  const vo = clip({ id: "vo0", track_id: A1.id, start: 96, duration: 48,
                    label: "B01-S2 vo", cutroom: { shot: "B01-S2", role: "vo", line: 0 } });
  const vo2 = clip({ id: "vo1", track_id: A1.id, start: 144, duration: 24,
                     label: "B01-S2 vo", cutroom: { shot: "B01-S2", role: "vo", line: 1 } });
  const sfx = clip({ id: "c1", track_id: SFX.id, start: 240, duration: 24,
                     label: "sfx:door.mp3", cutroom: { role: "sfx", cue: "cue_door77" } });

  it("reports what a landing spot would sit under, across the lanes", () => {
    const tl = film([vo, sfx]);
    expect(audioOverlaps(tl, sfx, 100).map((c) => c.id)).toEqual(["vo0"]);
    expect(audioOverlaps(tl, sfx, 150)).toEqual([]);          // clear of the line
    expect(describeOverlaps(tl, audioOverlaps(tl, sfx, 100)))
      .toEqual([{ clip: "B01-S2 vo", track: "A1", start: 4, end: 6 }]);
  });

  it("does not count the lines that travel with it", () => {
    const tl = film([vo, vo2, sfx]);
    // vo and vo2 share one offset, so vo landing on vo2 is not an overlap.
    expect(audioOverlaps(tl, vo, 150, ["vo0", "vo1"])).toEqual([]);
    expect(audioOverlaps(tl, vo, 150).map((c) => c.id)).toEqual(["vo1"]);
  });
});
