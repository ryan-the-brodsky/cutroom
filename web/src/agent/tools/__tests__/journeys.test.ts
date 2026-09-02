/**
 * The §5 hero journeys, run as sequences over the fake context — these are the
 * evals the video demonstrates. Each test asserts the tool sequence, what the
 * UI was driven to do, and what the human ends up looking at.
 */
import { APP_BASE } from "../../../routes";
import { describe, expect, it } from "vitest";
import { ANCHORS, genSubAnchor, shotTabAnchor } from "../../contract";
import type { ToolErr, ToolOk } from "../../contract";
import { makeFakeContext } from "../fakeContext";
import {
  cutFilm, findShots, freezeTail, generateTakes, selectTake, setKeeper,
  setTimelineSource, waitForJobs,
} from "../index";

const asOk = (r: unknown) => r as ToolOk;
const asErr = (r: unknown) => r as ToolErr;

describe("J1 — “Make a few more generative cuts of the David Ross close-up.”", () => {
  it("resolves to B10-S2, then drives Generate → Still three times", async () => {
    const f = makeFakeContext();

    const found = asOk(await findShots.execute({ query: "David Ross close-up" }, f.ctx));
    expect(found.confidence).toBe("high");
    expect(found.best).toBe("B10-S2");

    const gen = asOk(await generateTakes.execute(
      { shot: "B10-S2", lane: "still", count: "a few" as never }, f.ctx));

    // Navigation the human sees.
    expect(f.rec.nav).toEqual([`${APP_BASE}/p/next-year/shot/B10-S2?tab=generate&sub=still`]);

    // Page handles, in order.
    const calls = f.rec.calls();
    expect(calls[0]).toBe("setTab(generate)");
    expect(calls[1]).toBe("setSub(still)");
    expect(calls.filter((c) => c === "submitGenerate(still)")).toHaveLength(3);

    // The trail: open sub-tab, fill prompt, then a seed + submit per take.
    const anchors = f.rec.anchors();
    expect(anchors[1]).toBe(genSubAnchor("still"));
    expect(f.rec.steps.length).toBeGreaterThanOrEqual(5);
    expect(f.rec.steps.filter((s) => s.job).length).toBe(3);

    // The result the agent reports back.
    expect(gen.jobs).toHaveLength(3);
    expect(gen.takes).toHaveLength(3);
    expect(gen.backend).toBe("mock");
    expect(gen.cost_class).toBe("free");
    expect(gen.summary).toContain("B10-S2");
    expect(JSON.stringify(gen).length).toBeLessThanOrEqual(1500);
  });
});

describe("J1b — “…the David Ross close up, shot 37”", () => {
  it("comes back ambiguous and nothing runs", async () => {
    const f = makeFakeContext();

    const found = asOk(await findShots.execute(
      { query: "the David Ross close up, shot 37" }, f.ctx));
    expect(found.confidence).toBe("ambiguous");
    expect((found.matches as { sid: string; why?: string }[]).map((m) => m.sid))
      .toEqual(["B10-S2", "B11-S4"]);

    // Even if the agent tries to generate on the raw phrase, the guard holds.
    const gen = asErr(await generateTakes.execute(
      { shot: "the David Ross close up, shot 37", lane: "still", count: 3 }, f.ctx));
    expect(gen.error).toBe("ambiguous_shot");
    expect((gen.candidates as { sid: string }[]).map((c) => c.sid))
      .toEqual(["B10-S2", "B11-S4"]);
    expect(gen.hint).toMatch(/ask the director/i);

    expect(f.rec.nav).toEqual([]);
    expect(f.rec.calls()).toEqual([]);
    expect(f.rec.steps).toEqual([]);
  });
});

describe("J2 — “Keep the first second of the newest one and freeze the rest.”", () => {
  it("selects the newest motion take, then freezes after 1s", async () => {
    const f = makeFakeContext();

    const sel = asOk(await selectTake.execute(
      { shot: "B10-S2", take: "newest motion" }, f.ctx));
    expect(sel.selected).toBe("renders/B10-S2/motion/a.mp4");
    expect(sel.is_clip).toBe(true);

    const froze = asOk(await freezeTail.execute(
      { shot: "B10-S2", live_seconds: 1 }, f.ctx));

    const calls = f.rec.calls();
    expect(calls).toContain("setTab(motion)");
    expect(calls).toContain("setLive(1)");
    expect(calls.indexOf("setLive(1)")).toBeLessThan(calls.indexOf("submitFreeze()"));

    const anchors = f.rec.anchors();
    expect(anchors).toContain(ANCHORS.shotTake);
    expect(anchors).toContain(shotTabAnchor("motion"));
    expect(anchors).toContain(ANCHORS.motionLive);
    expect(anchors).toContain(ANCHORS.motionFreeze);

    expect(froze.source).toBe("renders/B10-S2/motion/a.mp4");
    expect(froze.live_seconds).toBe(1);
    expect(froze.take).toBeTruthy();
    expect(froze.status).toBe("done");
  });
});

describe("J4 — “Cut act 1 at 720.”", () => {
  it("cuts act1 and then waits for the job", async () => {
    const f = makeFakeContext({
      settle: (ids) => ids.map((job) => ({ job, status: "running" as const })),
    });

    const cut = asOk(await cutFilm.execute({ scope: "act1", res: "720" }, f.ctx));
    expect(f.rec.nav).toEqual([`${APP_BASE}/p/next-year/film?scope=act1&res=720`]);
    expect(f.rec.calls()).toEqual(["setScope(act1)", "setRes(720)", "cutFilm()", "refresh()"]);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.filmScope, ANCHORS.filmRes, ANCHORS.filmCut]));
    expect(cut.job).toBe("job-cut-1");
    expect(cut.hint).toMatch(/wait_for_jobs/);

    // Second turn: the cut lands.
    const g = makeFakeContext({
      settle: (ids) => ids.map((job) => ({
        job, status: "done" as const,
        result: { animatic: "renders/animatic/act1_720.mp4", total: 92.4 },
        takes: [{ path: "renders/animatic/act1_720.mp4", kind: "animatic" }],
      })),
    });
    const waited = asOk(await waitForJobs.execute(
      { jobs: [cut.job as string], timeout_s: 30 }, g.ctx));
    expect(waited.takes).toEqual(["renders/animatic/act1_720.mp4"]);
    expect(waited.summary).toMatch(/1 of 1 finished/);
  });
});

describe("J6 — “Make this take the keeper and use it in the timeline.”", () => {
  it("stars the still, then points the timeline at it", async () => {
    const f = makeFakeContext();
    const path = "renders/B10-S2/i2i/warm.png";

    const kept = asOk(await setKeeper.execute({ shot: "B10-S2", take: path }, f.ctx));
    expect(f.rec.calls()).toContain(`setKeeper(${path})`);
    expect(f.rec.anchors()).toContain(ANCHORS.takeKeeper);
    expect(kept.keeper).toBe(path);
    expect(kept.previous_keeper).toBe("renders/B10-S2/stills/keeper.png");

    const plays = asOk(await setTimelineSource.execute({ shot: "B10-S2", take: path }, f.ctx));
    expect(f.rec.calls()).toContain(`setSource(${path})`);
    expect(f.rec.anchors()).toContain(ANCHORS.takeSource);
    expect(plays.plays).toBe(path);
    expect(plays.hint).toMatch(/cut_film/);

    // ★ pulses before ⬆ — the order the human sees.
    const anchors = f.rec.anchors();
    expect(anchors.indexOf(ANCHORS.takeKeeper))
      .toBeLessThan(anchors.indexOf(ANCHORS.takeSource));
  });
});
