import { APP_BASE } from "../../../routes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANCHORS } from "../../contract";
import type { ToolErr, ToolOk } from "../../contract";
import * as screen from "../../../screen/store";
import { makeFakeContext, type FakeContext } from "../fakeContext";
import { pickCut, playCut, playTake, previewTimeline, stopPlayback } from "../screen";

let f: FakeContext;
beforeEach(() => { screen.__reset(); f = makeFakeContext(); });
afterEach(() => { f.restore(); screen.__reset(); });

const asOk = (r: unknown) => r as ToolOk;
const asErr = (r: unknown) => r as ToolErr;

/**
 * The <video> the room would hand the store. Without one the tools still work
 * (they report `needs_click`), which is the behaviour the last test pins.
 */
function fakePlayer(opts: { refuse?: boolean; duration?: number } = {}) {
  const p = {
    t: 0, playing: false,
    currentTime: () => p.t,
    duration: () => opts.duration ?? 7,
    seek: (t: number) => { p.t = t; },
    play: async () => { p.playing = !opts.refuse; return p.playing; },
    pause: () => { p.playing = false; },
  };
  screen.attach(p);
  return p;
}

// ---------------------------------------------------------------- play_cut

describe("play_cut", () => {
  it("opens the newest cut in the screening room and plays it", async () => {
    const p = fakePlayer();
    const r = asOk(await playCut.execute({}, f.ctx));

    expect(r.ok).toBe(true);
    expect(r.cut).toBe("assembly/animatic-full-720p-2.mp4");
    expect(r.chapters).toBe(2);
    expect(r.duration).toBe(7);
    expect(r.from).toBe(0);
    expect(r.now_playing_shot).toBe("B10-S2");
    expect(r.needs_click).toBeUndefined();

    // The room is really open, on the cut, with its chapter strip loaded.
    const s = screen.screenState();
    expect(s.open).toBe(true);
    expect(s.rel).toBe("assembly/animatic-full-720p-2.mp4");
    expect(s.chapters.map((c) => c.sid)).toEqual(["B10-S2", "B11-S4"]);
    expect(p.playing).toBe(true);

    // Visible execution: the Film Editor first, then the cut card, then the room.
    expect(f.rec.nav).toContain(`${APP_BASE}/p/next-year`);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      `${ANCHORS.filmCutPlay}[data-path="assembly/animatic-full-720p-2.mp4"]`,
      ANCHORS.screenRoot,
    ]));
  });

  it("seeks to a shot named by sid", async () => {
    const p = fakePlayer();
    const r = asOk(await playCut.execute({ from: "B11-S4" }, f.ctx));
    expect(r.from).toBe(4);
    expect(r.now_playing_shot).toBe("B11-S4");
    expect(p.t).toBe(4);
    expect(screen.screenState().t).toBe(4);
  });

  it("seeks to a clock", async () => {
    fakePlayer();
    expect(asOk(await playCut.execute({ from: "0:05" }, f.ctx)).from).toBe(5);
    expect(asOk(await playCut.execute({ from: 2 }, f.ctx)).from).toBe(2);
  });

  it("seeks to an act, reading the acts off the film", async () => {
    fakePlayer();
    // Both fixture shots are act 3.
    const r = asOk(await playCut.execute({ from: "act3" }, f.ctx));
    expect(r.from).toBe(0);
    expect(r.now_playing_shot).toBe("B10-S2");
  });

  it("falls back to the shot resolver, so a description lands on a frame", async () => {
    fakePlayer();
    const r = asOk(await playCut.execute({ from: "the cemetery at dusk" }, f.ctx));
    expect(r.now_playing_shot).toBe("B11-S4");
    expect(r.from).toBe(4);
  });

  it("takes an index from newest and a file name", async () => {
    fakePlayer();
    expect(asOk(await playCut.execute({ cut: "2" }, f.ctx)).cut)
      .toBe("assembly/animatic-act3-720p.mp4");
    expect(asOk(await playCut.execute({ cut: "animatic-act3-720p.mp4" }, f.ctx)).cut)
      .toBe("assembly/animatic-act3-720p.mp4");
  });

  it("says so when the browser refuses to autoplay, and never fails", async () => {
    fakePlayer({ refuse: true });
    const r = asOk(await playCut.execute({}, f.ctx));
    expect(r.ok).toBe(true);
    expect(r.needs_click).toBe(true);
    expect(String(r.hint)).toMatch(/refused autoplay/);
    expect(screen.screenState().open).toBe(true);
  });

  it("refuses cleanly when the film has never been cut", async () => {
    const g = makeFakeContext({ api: (path: string) =>
      /takes\?kind=animatic/.test(path) ? [] : {} });
    const r = asErr(await playCut.execute({}, g.ctx));
    expect(r.error).toBe("no_cuts");
    expect(String(r.hint)).toMatch(/cut_film/);
    expect(screen.screenState().open).toBe(false);
    g.restore();
  });

  it("refuses cleanly with no project", async () => {
    const g = makeFakeContext({ project: null });
    expect(asErr(await playCut.execute({}, g.ctx)).error).toBe("no_project");
    g.restore();
  });

  it("names the cut the director asked for, or offers what there is", async () => {
    const r = asErr(await playCut.execute({ cut: "the one from tuesday" }, f.ctx));
    expect(r.error).toBe("cut_not_found");
    expect(r.candidates).toEqual([
      "animatic-full-720p-2.mp4", "animatic-act3-720p.mp4",
    ]);
  });
});

describe("pickCut", () => {
  const rows = [{ path: "a/new.mp4" }, { path: "a/mid.mp4" }, { path: "a/old.mp4" }];
  it("reads the words a director uses for a cut", () => {
    expect(pickCut(rows, undefined)?.path).toBe("a/new.mp4");
    expect(pickCut(rows, "latest")?.path).toBe("a/new.mp4");
    expect(pickCut(rows, 1)?.path).toBe("a/new.mp4");
    expect(pickCut(rows, 3)?.path).toBe("a/old.mp4");
    expect(pickCut(rows, "oldest")?.path).toBe("a/old.mp4");
    expect(pickCut(rows, "mid.mp4")?.path).toBe("a/mid.mp4");
    expect(pickCut(rows, "a/mid.mp4")?.path).toBe("a/mid.mp4");
    expect(pickCut(rows, "nothing like it")).toBeNull();
    expect(pickCut([], "latest")).toBeNull();
  });
});

// ---------------------------------------------------------------- play_take

describe("play_take", () => {
  it("puts one shot's clip on the big screen", async () => {
    const p = fakePlayer({ duration: 4 });
    const r = asOk(await playTake.execute({ shot: "B10-S2" }, f.ctx));
    expect(r.take).toBe("renders/B10-S2/motion/a.mp4");
    expect(r.is_still).toBe(false);
    expect(r.shot).toBe("B10-S2");
    expect(screen.screenState().rel).toBe("renders/B10-S2/motion/a.mp4");
    expect(p.playing).toBe(true);
  });

  it("screens a still, held for the shot's seconds", async () => {
    fakePlayer({ duration: 3 });
    const r = asOk(await playTake.execute(
      { shot: "B11-S4", take: "newest still" }, f.ctx));
    expect(r.is_still).toBe(true);
    expect(r.seconds).toBe(3);
    expect(screen.screenState().seconds).toBe(3);
  });

  it("starts partway in when asked", async () => {
    const p = fakePlayer({ duration: 4 });
    const r = asOk(await playTake.execute({ shot: "B10-S2", from: "0:02" }, f.ctx));
    expect(r.from).toBe(2);
    expect(p.t).toBe(2);
  });

  it("passes an unknown shot back as candidates, never a crash", async () => {
    const r = asErr(await playTake.execute({ shot: "the moon landing" }, f.ctx));
    expect(r.ok).toBe(false);
    expect(screen.screenState().open).toBe(false);
  });
});

// ---------------------------------------------------------------- stop_playback

describe("stop_playback", () => {
  it("closes the room and reports where it stopped", async () => {
    fakePlayer();
    await playCut.execute({ from: "B11-S4" }, f.ctx);
    const r = asOk(await stopPlayback.execute({}, f.ctx));
    expect(r.was_playing).toBe(true);
    expect(r.stopped_at).toBe(4);
    expect(screen.screenState().open).toBe(false);
    expect(f.rec.anchors()).toContain(ANCHORS.screenClose);
  });

  it("is safe when nothing is playing", async () => {
    const r = asOk(await stopPlayback.execute({}, f.ctx));
    expect(r.ok).toBe(true);
    expect(r.was_playing).toBe(false);
  });
});

// ---------------------------------------------------------------- preview_timeline

describe("preview_timeline", () => {
  it("opens the Timeline, seeks and presses play", async () => {
    const r = asOk(await previewTimeline.execute({ from: "B11-S4" }, f.ctx));
    expect(f.rec.nav).toContain(`${APP_BASE}/p/next-year/timeline`);
    expect(r.from).toBe(4);
    expect(r.now_playing_shot).toBe("B11-S4");
    expect(r.clips).toBe(2);
    expect(r.duration).toBe(7);
    expect(String(r.note)).toMatch(/video only/);
    expect(f.timelinePage.t).toBe(4);
    expect(f.timelinePage.playing).toBe(true);
    expect(f.timelinePage.selected).toBe("B11-S4");
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.timelineScrub, ANCHORS.timelinePlay,
    ]));
  });

  it("seeks and holds when play is false, and sets the render scope", async () => {
    const r = asOk(await previewTimeline.execute(
      { from: 2, play: false, scope_sec: 12 }, f.ctx));
    expect(r.from).toBe(2);
    expect(f.timelinePage.playing).toBe(false);
    expect(f.timelinePage.scope).toBe(12);
    expect(f.rec.calls()).toContain("timeline.setScope(12)");
  });

  it("reports needs_click rather than failing when play is refused", async () => {
    f.timelinePage.refusePlay = true;
    const r = asOk(await previewTimeline.execute({}, f.ctx));
    expect(r.ok).toBe(true);
    expect(r.needs_click).toBe(true);
  });

  it("refuses cleanly with no project", async () => {
    const g = makeFakeContext({ project: null });
    expect(asErr(await previewTimeline.execute({}, g.ctx)).error).toBe("no_project");
    g.restore();
  });
});

// ---------------------------------------------------------------- the store

describe("the screening-room store", () => {
  it("holds a seek made before the room mounts, then applies it on attach", async () => {
    screen.open("assembly/x.mp4", { pid: "next-year", t: 12 });
    expect(screen.screenState().t).toBe(12);
    const p = fakePlayer();
    const got = await screen.waitForPlayer(50);
    expect(got).toBe(p);
    screen.seek(3);
    expect(p.t).toBe(3);
  });

  it("reports false rather than throwing when play is refused", async () => {
    screen.open("assembly/x.mp4", { pid: "next-year" });
    fakePlayer({ refuse: true });
    expect(await screen.play()).toBe(false);
    expect(screen.screenState().blocked).toBe(true);
  });

  it("resolves waitForPlayer with null instead of hanging", async () => {
    screen.open("assembly/x.mp4", { pid: "next-year" });
    expect(await screen.waitForPlayer(20)).toBeNull();
  });
});
