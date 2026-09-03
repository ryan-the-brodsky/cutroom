import { APP_BASE } from "../../../routes";
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS, shotTabAnchor } from "../../contract";
import type { ToolErr, ToolOk } from "../../contract";
import { PAID_BACKEND, makeFakeContext, type FakeContext } from "../fakeContext";
import { generateMusic, generateSfx, listCues, placeCue } from "../index";
import { NEXT_CUT_FILM } from "../util";

let f: FakeContext;
beforeEach(() => { f = makeFakeContext(); });

const asOk = (r: unknown) => r as ToolOk;
const asErr = (r: unknown) => r as ToolErr;

/** Settle fake that hands back an audio take, the way gen.sfx really does. */
const audioTake = (rel: string) => (ids: string[]) =>
  ids.map((job) => ({
    job, status: "done", result: { take: rel },
    takes: [{ path: rel, kind: "audio" }],
  }));

// ---------------------------------------------------------------- generate_music

describe("generate_music", () => {
  it("drives the Audio tab's music console and places the cue", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/music/theme.mp3") });
    const r = asOk(await generateMusic.execute(
      { prompt: "slow upright bass, elegiac", seconds: 20, instrumental: true }, g.ctx));

    expect(r.ok).toBe(true);
    expect(g.rec.calls()).toEqual(expect.arrayContaining([
      "setTab(audio)",
      'setCueField(music,prompt,"slow upright bass, elegiac")',
      "setCueField(music,seconds,20)",
      "setCueField(music,instrumental,true)",
      "submitMusic()",
    ]));
    // Visible execution: the trail pulses the real controls, in order.
    expect(g.rec.anchors()).toEqual(expect.arrayContaining([
      shotTabAnchor("audio"), ANCHORS.musicPrompt, ANCHORS.musicSeconds,
      ANCHORS.musicSubmit, ANCHORS.shotCues,
    ]));
    expect(r.take).toBe("audio/music/theme.mp3");
    expect(r.placed).toBe(true);
    expect(r.next).toBe(NEXT_CUT_FILM);
    expect(g.cues.rows).toHaveLength(1);
    // No shot named → the head of the film, at the music bed default.
    expect(g.cues.rows[0]).toMatchObject({
      kind: "music", start: 0, gain: -8, duration: 20,
    });
    g.restore();
  });

  it("rides the named shot's start when a shot is given", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/music/bed.mp3") });
    await generateMusic.execute(
      { prompt: "low strings", shot: "the David Ross close-up", gain: -22 }, g.ctx);
    expect(g.cues.rows[0]).toMatchObject({
      kind: "music", shot: "B10-S2", gain: -22,
    });
    expect(g.cues.rows[0].start).toBeUndefined();
    g.restore();
  });

  it("clamps seconds to the model's 5–120 window", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/music/x.mp3") });
    await generateMusic.execute({ prompt: "drone", seconds: 900 }, g.ctx);
    expect(g.shotPage.cue["music.seconds"]).toBe(120);
    g.restore();
  });

  it("generates without placing when place is false", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/music/x.mp3") });
    const r = asOk(await generateMusic.execute(
      { prompt: "drone", place: false }, g.ctx));
    expect(r.placed).toBe(false);
    expect(g.cues.rows).toHaveLength(0);
    expect(r.hint).toMatch(/place_cue/);
    expect(r.next).toBeUndefined();
    g.restore();
  });

  it("stops on a paid backend before it moves the view", async () => {
    const g = makeFakeContext({ backend: PAID_BACKEND });
    const r = asErr(await generateMusic.execute({ prompt: "theme" }, g.ctx));
    expect(r.error).toBe("needs_confirmation");
    expect(g.rec.nav).toEqual([]);
    expect(g.rec.calls()).toEqual([]);
    g.restore();
  });

  it("proceeds on a paid backend once the cost is confirmed", async () => {
    const g = makeFakeContext({
      backend: PAID_BACKEND, settle: audioTake("audio/music/x.mp3") });
    const r = asOk(await generateMusic.execute(
      { prompt: "theme", confirm_cost: true }, g.ctx));
    expect(r.ok).toBe(true);
    expect(r.cost_class).toBe("paid");
    g.restore();
  });

  it("asks for a prompt instead of guessing", async () => {
    expect(asErr(await generateMusic.execute({ prompt: "  " }, f.ctx)).error)
      .toBe("needs_prompt");
  });

  it("relays a failed job instead of claiming success", async () => {
    const g = makeFakeContext({
      settle: (ids) => ids.map((job) => ({ job, status: "error", error: "402 no credits" })),
    });
    const r = asErr(await generateMusic.execute({ prompt: "theme" }, g.ctx));
    expect(r.error).toBe("music_failed");
    expect(r.hint).toMatch(/402/);
    expect(g.cues.rows).toHaveLength(0);
    g.restore();
  });

  it("returns the job for wait_for_jobs when nothing settled in time", async () => {
    const g = makeFakeContext({
      settle: (ids) => ids.map((job) => ({ job, status: "running" })) });
    const r = asOk(await generateMusic.execute({ prompt: "theme" }, g.ctx));
    expect(r.ok).toBe(true);
    expect(r.placed).toBe(false);
    expect(r.jobs).toHaveLength(1);
    expect(r.hint).toMatch(/wait_for_jobs/);
    g.restore();
  });
});

// ---------------------------------------------------------------- generate_sfx

describe("generate_sfx", () => {
  it("pins the effect to the shot it was asked for", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/sfx/bat.mp3") });
    const r = asOk(await generateSfx.execute(
      { shot: "B10-S2", prompt: "a wooden bat cracking", seconds: 2, offset: 0.4 }, g.ctx));

    expect(r.shot).toBe("B10-S2");
    expect(g.rec.calls()).toEqual(expect.arrayContaining([
      "setTab(audio)",
      'setCueField(sfx,prompt,"a wooden bat cracking")',
      "setCueField(sfx,seconds,2)",
      "submitSfx()",
    ]));
    expect(g.rec.anchors()).toContain(ANCHORS.sfxSubmit);
    expect(g.cues.rows[0]).toMatchObject({
      kind: "sfx", shot: "B10-S2", offset: 0.4, gain: -4,
    });
    expect(r.next).toBe(NEXT_CUT_FILM);
    g.restore();
  });

  it("clamps seconds to 1–10 and passes prompt_influence through", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/sfx/a.mp3") });
    await generateSfx.execute(
      { shot: "B10-S2", prompt: "rain", seconds: 90, prompt_influence: 3 }, g.ctx);
    expect(g.shotPage.cue["sfx.seconds"]).toBe(10);
    expect(g.shotPage.cue["sfx.influence"]).toBe(1);
    g.restore();
  });

  it("relays shot ambiguity instead of picking one", async () => {
    const r = asErr(await generateSfx.execute(
      { shot: "the David Ross close up, shot 37", prompt: "crowd" }, f.ctx));
    expect(r.error).toBe("ambiguous_shot");
    expect(r.candidates).toHaveLength(2);
    expect(f.rec.calls()).toEqual([]);
  });

  it("keeps the take when placing fails", async () => {
    const g = makeFakeContext({ settle: audioTake("audio/sfx/a.mp3") });
    g.shotPage.failCue = "cue rejected";
    const r = asOk(await generateSfx.execute(
      { shot: "B10-S2", prompt: "rain" }, g.ctx));
    expect(r.placed).toBe(false);
    expect(r.take).toBe("audio/sfx/a.mp3");
    expect(r.hint).toMatch(/place_cue/);
    expect(r.next).toBeUndefined();
    g.restore();
  });
});

// ---------------------------------------------------------------- place_cue

describe("place_cue", () => {
  it("places a take on the film editor's cue strip", async () => {
    const r = asOk(await placeCue.execute(
      { take: "audio/music/theme.mp3", start: 90, gain: -12, fade_out: 2 }, f.ctx));
    expect(r.ok).toBe(true);
    expect(f.rec.nav[0]).toBe(`${APP_BASE}/p/next-year/film`);
    expect(f.rec.anchors()).toContain(ANCHORS.filmCues);
    expect(f.cues.rows[0]).toMatchObject({
      kind: "music", start: 90, gain: -12, fade_out: 2,
    });
    expect(String(r.summary)).toContain("1:30");
    expect(r.next).toBe(NEXT_CUT_FILM);
  });

  it("infers the kind from the path", async () => {
    await placeCue.execute({ take: "audio/sfx/door.mp3", shot: "B11-S4" }, f.ctx);
    expect(f.cues.rows[0]).toMatchObject({ kind: "sfx", shot: "B11-S4", gain: -4 });
  });

  it("asks for the kind when the path does not say", async () => {
    const r = asErr(await placeCue.execute({ take: "renders/odd.mp3", start: 0 }, f.ctx));
    expect(r.error).toBe("needs_kind");
  });

  it("asks where to put it when neither shot nor start is given", async () => {
    const r = asErr(await placeCue.execute({ take: "audio/music/a.mp3" }, f.ctx));
    expect(r.error).toBe("needs_place");
  });

  it("refuses an unbounded loop", async () => {
    const r = asErr(await placeCue.execute(
      { take: "audio/sfx/room.mp3", start: 0, loop: true }, f.ctx));
    expect(r.error).toBe("loop_needs_duration");
  });

  it("needs a take path", async () => {
    expect(asErr(await placeCue.execute({ start: 0 }, f.ctx)).error).toBe("needs_take");
  });
});

// ---------------------------------------------------------------- list_cues

describe("list_cues", () => {
  it("reports an empty sheet with a way forward", async () => {
    const r = asOk(await listCues.execute({}, f.ctx));
    expect(r.ok).toBe(true);
    expect(r.music).toEqual([]);
    expect(r.hint).toMatch(/generate_music/);
    expect(f.rec.nav).toEqual([]);           // read-only: never navigates
  });

  it("reads back what was placed, with film times and ids", async () => {
    await placeCue.execute({ take: "audio/music/theme.mp3", start: 65 }, f.ctx);
    await placeCue.execute({ take: "audio/sfx/door.mp3", shot: "B10-S2" }, f.ctx);
    const r = asOk(await listCues.execute({}, f.ctx));
    expect(String(r.summary)).toBe("1 music cue, 1 SFX cue");
    const music = r.music as { at: string; id: string; gain: string }[];
    expect(music[0].at).toBe("1:05");
    expect(music[0].gain).toBe("-8dB");
    expect(music[0].id).toMatch(/^cue_/);
    const sfx = r.sfx as { shot: string }[];
    expect(sfx[0].shot).toBe("B10-S2");
  });

  it("filters to one track", async () => {
    await placeCue.execute({ take: "audio/music/theme.mp3", start: 0 }, f.ctx);
    const r = asOk(await listCues.execute({ kind: "music" }, f.ctx));
    expect(r.music).toHaveLength(1);
    expect(r.sfx).toBeUndefined();
  });

  it("refuses without a project", async () => {
    const g = makeFakeContext({ project: null });
    expect(asErr(await listCues.execute({}, g.ctx)).error).toBe("no_project");
    g.restore();
  });
});
