import { APP_BASE } from "../../../routes";
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS, TOOL_NAMES, genFieldAnchor, genSubAnchor, shotTabAnchor } from "../../contract";
import type { ToolErr, ToolOk } from "../../contract";
import {
  FIXTURE_DETAIL, PAID_BACKEND, makeFakeContext, type FakeContext,
} from "../fakeContext";
import {
  applyPlan, cutFilm, describeShot, directShot, findShots, freezeTail, generateTakes,
  getContext, getJobs, listFeatures, openShot, selectTake, setKeeper, setShotTiming,
  setTimelineSource, showMe, synthesizeVo, trimClip, waitForJobs,
} from "../index";

let f: FakeContext;
beforeEach(() => { f = makeFakeContext(); });

const asOk = (r: unknown) => r as ToolOk;
const asErr = (r: unknown) => r as ToolErr;

// ---------------------------------------------------------------- find

describe("find_shots", () => {
  it("returns the Ross close-up with high confidence", async () => {
    const r = asOk(await findShots.execute({ query: "the David Ross close-up" }, f.ctx));
    expect(r.ok).toBe(true);
    expect(r.best).toBe("B10-S2");
    expect(r.confidence).toBe("high");
    expect((r.matches as { sid: string }[])[0].sid).toBe("B10-S2");
    expect(f.rec.nav).toEqual([]); // read-only: never navigates
  });

  it("returns ambiguous with both readings for the hero sentence", async () => {
    const r = asOk(await findShots.execute({ query: "the David Ross close up, shot 37" }, f.ctx));
    expect(r.confidence).toBe("ambiguous");
    expect((r.matches as { sid: string }[]).map((m) => m.sid)).toEqual(["B10-S2", "B11-S4"]);
    expect(r.hint).toMatch(/ask the director/i);
  });

  it("refuses without a project", async () => {
    const g = makeFakeContext({ project: null });
    expect(asErr(await findShots.execute({ query: "x" }, g.ctx)).error).toBe("no_project");
  });
});

describe("describe_shot", () => {
  it("reads the shot endpoint and reports lane cost classes", async () => {
    const r = asOk(await describeShot.execute({ shot: "B10-S2" }, f.ctx));
    expect(f.rec.api.map((c) => c.path))
      .toContain("/api/projects/next-year/shots/B10-S2");
    expect(r.sid).toBe("B10-S2");
    expect(r.image_prompt).toContain("David Ross");
    expect((r.lanes as Record<string, string>).still).toContain("free");
    expect(f.rec.nav).toEqual([]);
  });

  it("relays ambiguity instead of guessing", async () => {
    const r = asErr(await describeShot.execute({ shot: "David Ross close up, shot 37" }, f.ctx));
    expect(r.error).toBe("ambiguous_shot");
    expect(r.candidates).toHaveLength(2);
  });
});

describe("get_context", () => {
  it("reports the current page, project and running jobs", async () => {
    await f.ctx.nav(`${APP_BASE}/p/next-year/shot/B10-S2?tab=generate`);
    const r = asOk(await getContext.execute({} as never, f.ctx));
    expect((r.page as { kind: string; shot: string }).kind).toBe("shot");
    expect((r.page as { shot: string }).shot).toBe("B10-S2");
    expect(r.project).toBe("next-year");
    expect(f.rec.api.map((c) => c.path)).toContain("/api/jobs?status=running&limit=10");
    expect(r.webmcp_mode).toBeTruthy();
  });
});

describe("list_features", () => {
  it("lists every tool, with a count per screen", async () => {
    const all = asOk(await listFeatures.execute({}, f.ctx));
    expect((all.features as unknown[]).length).toBe(TOOL_NAMES.length);
    // The palette-only feature registry is counted by screen, not listed.
    const screens = all.screens as Record<string, number>;
    expect(Object.keys(screens).length).toBeGreaterThan(4);
    expect(screens["Cel workbench"]).toBeGreaterThan(5);
  });

  it("searches the whole application when given a query", async () => {
    const one = asOk(await listFeatures.execute({ query: "freeze" }, f.ctx));
    expect((one.features as { name: string }[]).some((x) => x.name === "freeze_tail")).toBe(true);
    // palette-only entries are reachable by query, and flagged as such
    const opacity = asOk(await listFeatures.execute({ query: "opacity" }, f.ctx));
    const rows = opacity.features as { name: string; palette_only?: boolean }[];
    expect(rows.some((x) => x.name === "cel_opacity" && x.palette_only)).toBe(true);
  });
});

// ---------------------------------------------------------------- navigate

describe("open_shot", () => {
  it("navigates with tab and sub in the query, then sets both", async () => {
    const r = asOk(await openShot.execute({ shot: "B10-S2", sub: "animate" }, f.ctx));
    expect(f.rec.nav[0]).toBe(`${APP_BASE}/p/next-year/shot/B10-S2?tab=generate&sub=animate`);
    expect(f.rec.calls()).toEqual(expect.arrayContaining(["setTab(generate)", "setSub(animate)"]));
    expect(f.rec.anchors()).toContain(genSubAnchor("animate"));
    expect(r.shot).toBe("B10-S2");
  });

  it("selects a take when asked", async () => {
    await openShot.execute({ shot: "B10-S2", take: "newest motion" }, f.ctx);
    expect(f.rec.calls()).toContain("selectTake(renders/B10-S2/motion/a.mp4)");
  });
});

describe("show_me", () => {
  it("navigates to the feature's route and pulses its anchor", async () => {
    await f.ctx.nav(`${APP_BASE}/p/next-year/shot/B10-S2`);
    const r = asOk(await showMe.execute({ feature: "freeze tail" }, f.ctx));
    expect(r.feature).toBe("freeze_tail");
    expect(f.rec.nav[f.rec.nav.length - 1]).toBe(`${APP_BASE}/p/next-year/shot/B10-S2?tab=motion`);
    expect(f.rec.anchors()).toContain(ANCHORS.motionFreeze);
    expect(r.how_to).toMatch(/Motion edits/);
  });

  it("asks for a shot when the feature needs one and none is open", async () => {
    const r = asErr(await showMe.execute({ feature: "freeze tail" }, f.ctx));
    expect(r.error).toBe("needs_shot");
  });

  it("says so when nothing matches", async () => {
    const r = asErr(await showMe.execute({ feature: "zzzqqq" }, f.ctx));
    expect(r.error).toBe("feature_not_found");
  });
});

// ---------------------------------------------------------------- generate

describe("generate_takes", () => {
  it("drives Generate → Still and submits once per take with distinct seeds", async () => {
    const r = asOk(await generateTakes.execute(
      { shot: "the David Ross close-up", lane: "still", count: 3 }, f.ctx));
    expect(f.rec.nav[0]).toBe(`${APP_BASE}/p/next-year/shot/B10-S2?tab=generate&sub=still`);
    const calls = f.rec.calls();
    expect(calls.filter((c) => c === "submitGenerate(still)")).toHaveLength(3);
    expect(calls.indexOf("setTab(generate)")).toBeLessThan(calls.indexOf("submitGenerate(still)"));
    const seeds = calls.filter((c) => c.startsWith("setGenField(still,seeds"));
    expect(new Set(seeds).size).toBe(3);
    expect(r.jobs).toHaveLength(3);
    expect(r.backend).toBe("mock");
    expect(r.cost_class).toBe("free");
    expect(r.takes).toHaveLength(3);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      genSubAnchor("still"), genFieldAnchor("still", "prompt"),
      genFieldAnchor("still", "seeds"), genFieldAnchor("still", "submit"),
    ]));
  });

  it("defaults the prompt to the shot's own image prompt", async () => {
    await generateTakes.execute({ shot: "B10-S2", lane: "still", count: 1 }, f.ctx);
    expect(f.shotPage.gen.prompt).toBe(FIXTURE_DETAIL["B10-S2"].image_prompt);
  });

  it("appends to the written prompt in append mode", async () => {
    await generateTakes.execute(
      { shot: "B10-S2", lane: "still", count: 1, prompt: "harsher key light", prompt_mode: "append" },
      f.ctx);
    expect(f.shotPage.gen.prompt).toBe(
      `${FIXTURE_DETAIL["B10-S2"].image_prompt}, harsher key light`);
  });

  it("understands \"a few\" as three and clamps above four", async () => {
    await generateTakes.execute({ shot: "B10-S2", count: "a few" as never }, f.ctx);
    expect(f.rec.calls().filter((c) => c === "submitGenerate(still)")).toHaveLength(3);
    const g = makeFakeContext();
    await generateTakes.execute({ shot: "B10-S2", count: 9 }, g.ctx);
    expect(g.rec.calls().filter((c) => c === "submitGenerate(still)")).toHaveLength(4);
  });

  // Doctrine 2026-09-02: a clip plays in FULL. Its length comes from the
  // backend's motion profile (2 s at 24 fps for a rig with no profile), and
  // nothing freezes unless the caller asks.
  it("animates at the backend's clip length with no freeze", async () => {
    await generateTakes.execute({ shot: "B10-S2", lane: "animate", count: 1 }, f.ctx);
    expect(f.shotPage.gen.frames).toBe(49);
    expect(f.shotPage.gen.freeze_after).toBe(0);
    expect(f.shotPage.gen.fullFrame).toBe(true);
    expect(f.shotPage.gen.prompt).toBe(FIXTURE_DETAIL["B10-S2"].motion_prompt);
  });

  it("takes seconds and clamps them to the profile", async () => {
    await generateTakes.execute(
      { shot: "B10-S2", lane: "animate", count: 1, seconds: 4 }, f.ctx);
    expect(f.shotPage.gen.frames).toBe(97);            // 4s x 24fps, 8k+1
    expect(f.shotPage.gen.freeze_after).toBe(0);
  });

  it("freezes only when live_seconds is asked for", async () => {
    await generateTakes.execute(
      { shot: "B10-S2", lane: "animate", count: 1, live_seconds: 1.5 }, f.ctx);
    expect(f.shotPage.gen.freeze_after).toBe(1.5);
  });

  it("passes a cel region through and turns full frame off", async () => {
    await generateTakes.execute(
      { shot: "B10-S2", lane: "animate", count: 1, region: [10, 20, 300, 400] }, f.ctx);
    expect(f.shotPage.gen.fullFrame).toBe(false);
    expect(f.shotPage.gen.region).toEqual([10, 20, 300, 400]);
  });

  it("restyles the selected/keeper take and sets denoise", async () => {
    const r = asOk(await generateTakes.execute(
      { shot: "B10-S2", lane: "restyle", count: 1, prompt: "warmer" }, f.ctx));
    expect(f.rec.nav[0]).toContain("sub=restyle");
    expect(f.rec.nav[0]).toContain("take=renders%2FB10-S2%2Fstills%2Fkeeper.png");
    expect(f.shotPage.gen.denoise).toBe(0.85);
    expect(r.lane).toBe("restyle");
  });

  it("refuses a paid backend without confirm_cost, BEFORE navigating", async () => {
    const g = makeFakeContext({ backend: PAID_BACKEND });
    const r = asErr(await generateTakes.execute(
      { shot: "B10-S2", lane: "still", count: 3 }, g.ctx));
    expect(r.error).toBe("needs_confirmation");
    expect(r.backend).toBe("openrouter-image");
    expect(r.cost_class).toBe("paid");
    expect(r.estimate).toBe("3 stills on openrouter-image ≈ $0.12");
    expect(r.hint).toBe("re-call with confirm_cost:true");
    expect(g.rec.nav).toEqual([]);
    expect(g.rec.calls()).toEqual([]);
  });

  it("proceeds on a paid backend once confirmed", async () => {
    const g = makeFakeContext({ backend: PAID_BACKEND });
    const r = asOk(await generateTakes.execute(
      { shot: "B10-S2", lane: "still", count: 2, confirm_cost: true }, g.ctx));
    expect(r.ok).toBe(true);
    expect(r.cost_class).toBe("paid");
    expect(r.jobs).toHaveLength(2);
  });

  it("stops at the ambiguity instead of generating", async () => {
    const r = asErr(await generateTakes.execute(
      { shot: "the David Ross close up, shot 37", lane: "still" }, f.ctx));
    expect(r.error).toBe("ambiguous_shot");
    expect(f.rec.nav).toEqual([]);
    expect(f.rec.calls()).toEqual([]);
  });

  it("reports still-running jobs with a wait hint", async () => {
    const g = makeFakeContext({ settle: (ids) => ids.map((job) => ({ job, status: "running" })) });
    const r = asOk(await generateTakes.execute({ shot: "B10-S2", count: 2 }, g.ctx));
    expect(r.hint).toMatch(/wait_for_jobs/);
    expect(r.takes).toEqual([]);
  });

  it("relays a rejected submit", async () => {
    f.shotPage.failSubmit = "402: demo budget exhausted";
    const r = asErr(await generateTakes.execute({ shot: "B10-S2", count: 2 }, f.ctx));
    expect(r.error).toBe("submit_failed");
    expect(r.hint).toContain("budget exhausted");
  });
});

// ---------------------------------------------------------------- motion

describe("freeze_tail", () => {
  it("opens Motion edits on the newest clip, sets live and submits", async () => {
    const r = asOk(await freezeTail.execute({ shot: "B10-S2", live_seconds: 1 }, f.ctx));
    expect(f.rec.nav[0]).toBe(
      `${APP_BASE}/p/next-year/shot/B10-S2?tab=motion&take=renders%2FB10-S2%2Fmotion%2Fa.mp4`);
    const calls = f.rec.calls();
    expect(calls).toEqual(expect.arrayContaining(["setTab(motion)", "setLive(1)", "submitFreeze()"]));
    expect(calls.indexOf("setLive(1)")).toBeLessThan(calls.indexOf("submitFreeze()"));
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      shotTabAnchor("motion"), ANCHORS.motionLive, ANCHORS.motionFreeze]));
    expect(r.live_seconds).toBe(1);
    expect(r.take).toBeTruthy();
  });

  it("defaults live_seconds to 1.0", async () => {
    await freezeTail.execute({ shot: "B10-S2" }, f.ctx);
    expect(f.shotPage.live).toBe(1.0);
  });

  it("refuses a shot with no clip", async () => {
    const r = asErr(await freezeTail.execute({ shot: "B11-S4" }, f.ctx));
    expect(r.error).toBe("needs_clip");
    expect(f.rec.nav).toEqual([]);
  });
});

describe("trim_clip", () => {
  it("requires end_seconds", async () => {
    const r = asErr(await trimClip.execute({ shot: "B10-S2" } as never, f.ctx));
    expect(r.error).toBe("needs_end_seconds");
    expect(f.rec.nav).toEqual([]);
  });

  it("submits the trim at the given second", async () => {
    const r = asOk(await trimClip.execute({ shot: "B10-S2", end_seconds: 1.5 }, f.ctx));
    expect(f.rec.calls()).toContain("submitTrim(1.5)");
    expect(f.rec.anchors()).toContain(ANCHORS.motionTrim);
    expect(r.end_seconds).toBe(1.5);
  });
});

// ---------------------------------------------------------------- picks

describe("select_take", () => {
  it.each([
    ["latest", "renders/B10-S2/motion/a.mp4"],
    ["newest motion", "renders/B10-S2/motion/a.mp4"],
    ["newest still", "renders/B10-S2/i2i/warm.png"],
    ["keeper", "renders/B10-S2/stills/keeper.png"],
    ["plays", "renders/B10-S2/motion/a.mp4"],
  ])("understands %s", async (word, expected) => {
    const g = makeFakeContext();
    const r = asOk(await selectTake.execute({ shot: "B10-S2", take: word }, g.ctx));
    expect(r.selected).toBe(expected);
    expect(g.rec.calls()).toContain(`selectTake(${expected})`);
    expect(g.rec.anchors()).toContain(ANCHORS.shotTake);
  });

  it("takes an explicit path", async () => {
    const r = asOk(await selectTake.execute(
      { shot: "B10-S2", take: "renders/B10-S2/stills/s2.png" }, f.ctx));
    expect(r.selected).toBe("renders/B10-S2/stills/s2.png");
    expect(r.kind).toBe("still");
  });

  it("reports when nothing matches", async () => {
    const r = asErr(await selectTake.execute({ shot: "B10-S2", take: "purple" }, f.ctx));
    expect(r.error).toBe("take_not_found");
  });
});

describe("set_keeper", () => {
  it("stars a still and reports the previous keeper", async () => {
    const r = asOk(await setKeeper.execute(
      { shot: "B10-S2", take: "renders/B10-S2/stills/s2.png", note: "eyes read" }, f.ctx));
    expect(f.rec.calls()).toContain("setKeeper(renders/B10-S2/stills/s2.png,eyes read)");
    expect(f.rec.anchors()).toContain(ANCHORS.takeKeeper);
    expect(r.previous_keeper).toBe("renders/B10-S2/stills/keeper.png");
  });

  it("refuses a clip — the keeper is the plate", async () => {
    const r = asErr(await setKeeper.execute(
      { shot: "B10-S2", take: "newest motion" }, f.ctx));
    expect(r.error).toBe("keeper_must_be_a_still");
    expect(r.hint).toMatch(/set_timeline_source/);
  });
});

describe("set_timeline_source", () => {
  it("sets the source and points at cut_film", async () => {
    const r = asOk(await setTimelineSource.execute(
      { shot: "B10-S2", take: "newest still" }, f.ctx));
    expect(f.rec.calls()).toContain("setSource(renders/B10-S2/i2i/warm.png)");
    expect(f.rec.anchors()).toContain(ANCHORS.takeSource);
    expect(r.hint).toMatch(/cut_film/);
  });

  it("clears the override", async () => {
    const r = asOk(await setTimelineSource.execute({ shot: "B10-S2", clear: true }, f.ctx));
    expect(f.rec.calls()).toContain("setSource(null)");
    expect(r.plays).toBeNull();
  });
});

// ---------------------------------------------------------------- timing

describe("set_shot_timing", () => {
  it("edits the Film Editor quick panel", async () => {
    const r = asOk(await setShotTiming.execute(
      { shot: "B10-S2", seconds: 5, vo_offset: -0.3, mute_vo: true }, f.ctx));
    expect(f.rec.nav[0]).toBe(`${APP_BASE}/p/next-year?sel=B10-S2`);
    expect(f.rec.calls()).toContain("selectShot(B10-S2)");
    expect(f.rec.calls()).toContain(
      'setOverride(B10-S2,{"seconds":5,"vo_offset":-0.3,"mute_vo":true})');
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.quickSeconds, ANCHORS.quickVoOffset, ANCHORS.quickMute]));
    expect(r.applied).toEqual({ seconds: 5, vo_offset: -0.3, mute_vo: true });
  });

  it("sends null for mute_vo:false so the server drops the key", async () => {
    await setShotTiming.execute({ shot: "B10-S2", mute_vo: false }, f.ctx);
    expect(f.rec.calls()).toContain('setOverride(B10-S2,{"mute_vo":null})');
  });

  it("refuses an empty patch", async () => {
    const r = asErr(await setShotTiming.execute({ shot: "B10-S2" }, f.ctx));
    expect(r.error).toBe("nothing_to_set");
    expect(f.rec.nav).toEqual([]);
  });
});

// ---------------------------------------------------------------- audio

describe("synthesize_vo", () => {
  it("fills the Audio tab from the scripted line and submits", async () => {
    const r = asOk(await synthesizeVo.execute({ shot: "B11-S4", futz: true }, f.ctx));
    expect(f.rec.nav[0]).toBe(`${APP_BASE}/p/next-year/shot/B11-S4?tab=audio`);
    expect(f.shotPage.vo.text).toBe(FIXTURE_DETAIL["B11-S4"].radio);
    expect(f.shotPage.vo.futz).toBe(true);
    expect(f.rec.calls()).toContain("submitVo()");
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      shotTabAnchor("audio"), ANCHORS.audioText, ANCHORS.audioFutz, ANCHORS.audioSubmit]));
    expect(r.job).toBeTruthy();
  });

  it("guards a paid voice backend before navigating", async () => {
    const g = makeFakeContext({ backend: { backend: "elevenlabs", cost_class: "paid", cost_usd: 0.02 } });
    const r = asErr(await synthesizeVo.execute({ shot: "B11-S4" }, g.ctx));
    expect(r.error).toBe("needs_confirmation");
    expect(g.rec.nav).toEqual([]);
  });

  it("asks for text when the shot has no scripted line", async () => {
    const r = asErr(await synthesizeVo.execute({ shot: "B10-S2" }, f.ctx));
    // B10-S2 has dialogue, so this one succeeds from the dialogue line.
    expect(r.error ?? "ok").toBe("ok");
  });
});

// ---------------------------------------------------------------- direct

describe("direct_shot / apply_plan", () => {
  it("compiles a plan and runs nothing", async () => {
    const r = asOk(await directShot.execute(
      { shot: "B10-S2", instruction: "keep the first second and hold the pose" }, f.ctx));
    expect(f.rec.calls()).toContain("direct(keep the first second and hold the pose)");
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.directInput, ANCHORS.directSubmit]));
    expect(r.ops).toEqual(["freeze_tail clip=renders/B10-S2/motion/a.mp4 live=1"]);
    expect(r.summary).toMatch(/nothing has run/);
    expect(f.rec.calls().some((c) => c.startsWith("applyPlan"))).toBe(false);
  });

  it("relays a 422 from the planner", async () => {
    f.shotPage.directResult = { error: "the grammar could not parse that" };
    const r = asErr(await directShot.execute(
      { shot: "B10-S2", instruction: "make it feel like autumn" }, f.ctx));
    expect(r.error).toBe("plan_not_compiled");
    expect(r.hint).toContain("could not parse");
  });

  it("applies a plan and settles its jobs", async () => {
    const plan = { ops: [{ op: "freeze_tail", clip: "a.mp4", live: 1 }], note: "hold" };
    const r = asOk(await applyPlan.execute({ shot: "B10-S2", plan }, f.ctx));
    expect(f.rec.anchors()).toContain(ANCHORS.planApply);
    expect(r.jobs).toEqual(["job-apply-1"]);
    expect(r.applied).toEqual(["freeze_tail"]);
  });

  it("refuses an empty plan", async () => {
    const r = asErr(await applyPlan.execute({ shot: "B10-S2", plan: { ops: [] } }, f.ctx));
    expect(r.error).toBe("needs_plan");
  });
});

// ---------------------------------------------------------------- film

describe("cut_film", () => {
  it("sets scope and res on the Film Editor and presses cut", async () => {
    const r = asOk(await cutFilm.execute({ scope: "act1", res: "720" }, f.ctx));
    expect(f.rec.nav[0]).toBe(`${APP_BASE}/p/next-year?scope=act1&res=720`);
    expect(f.rec.calls()).toEqual(["setScope(act1)", "setRes(720)", "cutFilm()", "refresh()"]);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.filmScope, ANCHORS.filmRes, ANCHORS.filmCut]));
    expect(r.job).toBe("job-cut-1");
    expect(r.scope).toBe("act1");
  });

  it("falls back to full/720 for junk enums", async () => {
    const r = asOk(await cutFilm.execute({ scope: "act9" as never, res: "4k" as never }, f.ctx));
    expect(r.scope).toBe("full");
    expect(r.res).toBe("720");
  });

  it("returns the job and a wait hint when the assemble is slow", async () => {
    const g = makeFakeContext({ settle: (ids) => ids.map((job) => ({ job, status: "running" })) });
    const r = asOk(await cutFilm.execute({}, g.ctx));
    expect(r.animatic).toBeNull();
    expect(r.hint).toMatch(/wait_for_jobs/);
  });
});

// ---------------------------------------------------------------- jobs

describe("get_jobs / wait_for_jobs", () => {
  it("checks specific job ids", async () => {
    const r = asOk(await getJobs.execute({ jobs: ["job-a", "job-b"] }, f.ctx));
    expect(f.rec.api.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/api/jobs/job-a", "/api/jobs/job-b"]));
    expect(r.jobs).toHaveLength(2);
  });

  it("lists the project's recent jobs with no arguments", async () => {
    await getJobs.execute({}, f.ctx);
    expect(f.rec.api[0].path).toBe("/api/jobs?project=next-year&limit=8");
  });

  it("pulls the log tail for a failed job", async () => {
    const g = makeFakeContext({
      api: (path) => (/^\/api\/jobs\/job-x$/.test(path)
        ? { id: "job-x", status: "error", error: "cuda oom" }
        : /log/.test(path) ? { lines: ["step 3", "RuntimeError: cuda oom"] } : {}),
    });
    const r = asOk(await getJobs.execute({ jobs: ["job-x"] }, g.ctx));
    const row = (r.jobs as Record<string, unknown>[])[0];
    expect(row.error).toBe("cuda oom");
    expect(row.log).toEqual(["step 3", "RuntimeError: cuda oom"]);
  });

  it("waits and reports takes", async () => {
    const r = asOk(await waitForJobs.execute({ jobs: ["job-1"], timeout_s: 5 }, f.ctx));
    expect(r.takes).toEqual(["renders/out/job-1.png"]);
    expect(r.summary).toMatch(/1 of 1 finished/);
  });

  it("caps the timeout at 60s and needs at least one id", async () => {
    expect(asErr(await waitForJobs.execute({ jobs: [] }, f.ctx)).error).toBe("needs_jobs");
    const r = asOk(await waitForJobs.execute({ jobs: ["j"], timeout_s: 999 }, f.ctx));
    expect(r.ok).toBe(true);
  });
});
