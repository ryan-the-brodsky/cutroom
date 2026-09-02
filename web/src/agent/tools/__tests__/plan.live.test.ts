/**
 * Live check: plan_motion -> apply_motion_plan against a real Genga Studio server
 * with mock lanes, plus GET /api/projects/{pid}/spend.
 *
 * Skipped unless CUTROOM_LIVE_URL is set, so `npm test` stays hermetic:
 *
 *   CUTROOM_LIVE_URL=http://127.0.0.1:8791 CUTROOM_LIVE_PROJECT=scratch \
 *     npx vitest run src/agent/tools/__tests__/plan.live.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeContext } from "../fakeContext";
import { applyMotionPlan, planMotion } from "../plan";
import type { Candidate, Resolution } from "../../contract";

const URL_ = process.env.CUTROOM_LIVE_URL;
const PID = process.env.CUTROOM_LIVE_PROJECT || "scratch";
const run = URL_ ? describe : describe.skip;

interface FilmRow { sid: string; beat?: string; act?: number; type?: string;
                    seconds?: number; keeper?: string | null }

run("live: plan_motion -> apply_motion_plan on mock lanes", () => {
  let film: FilmRow[] = [];

  const liveApi = async (path: string, body?: unknown) => {
    const r = await fetch(`${URL_}${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  };

  // The real shot resolver lives in the app; here a sid resolves to itself.
  const resolve = (query: string): Resolution => {
    const row = film.find((s) => s.sid === query);
    const cand = row && {
      sid: row.sid, ordinal: film.indexOf(row) + 1, beat: row.beat ?? "",
      act: row.act ?? 1, type: row.type ?? "STILL", seconds: row.seconds ?? 4,
      summary: row.sid, characters: [], has_keeper: Boolean(row.keeper),
      has_motion: false, plays: null,
    } as unknown as Candidate;
    return { confidence: cand ? "exact" : "none", best: cand ?? null,
             candidates: cand ? [cand] : [] } as unknown as Resolution;
  };

  const ctxFor = () => {
    const f = makeFakeContext({ project: PID, api: liveApi as never, resolve,
                                speed: "fast" });
    // Drive the real server through the same handle the Generate console calls.
    f.shotPage.submitGenerate = (async () => liveApi(
      `/api/projects/${PID}/generate/motion`,
      { shot: f.shotPage.sid, plate: `renders/stills/${f.shotPage.sid}_k.png`,
        prompt: "one burst: a cursor blinks, then holds", seconds: 2 },
    )) as typeof f.shotPage.submitGenerate;
    return f;
  };

  beforeAll(async () => {
    film = await liveApi(`/api/projects/${PID}/film`) as FilmRow[];
    expect(film.length).toBeGreaterThan(2);
  });

  it("plans a budget against the live motion profile", async () => {
    const f = ctxFor();
    const res = await planMotion.execute({ budget_usd: 0.06 }, f.ctx) as
      Record<string, unknown>;
    expect(res.ok).toBe(true);
    const items = res.items as { shot: string; seconds: number; why: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(res.total_usd as number).toBeLessThanOrEqual(0.06);
    for (const i of items) expect(i.why).not.toMatch(/freez/i);
    expect(res).toHaveProperty("spent_so_far_usd");
    // the switch-model-and-rerun sentence rides on every plan
    expect(String(res.doctrine)).toContain("registry's fallback");
  });

  it("serves the motion model registry", async () => {
    const d = await liveApi("/api/motion-models") as
      { models: { key: string; rank: number; fallback: string }[]; default: string };
    expect(d.models.map((m) => m.key)).toEqual(["seedance", "wan"]);
    expect(d.default).toBe("wan");
    expect(d.models[0].fallback).toBe("wan");
  });

  it("runs the plan and reports jobs, then /spend moves", async () => {
    const before = await liveApi(`/api/projects/${PID}/spend`) as
      { total_usd: number };
    const f = ctxFor();
    const res = await applyMotionPlan.execute(
      { budget_usd: 0.06, confirm_cost: true, max_shots: 2 }, f.ctx) as
      Record<string, unknown>;
    expect(res.ok).toBe(true);
    const shots = res.shots as { shot: string; jobs: string[] }[];
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].jobs.length).toBeGreaterThan(0);
    expect(res.spent_usd as number).toBeLessThanOrEqual(0.06);

    const after = await liveApi(`/api/projects/${PID}/spend`) as
      { total_usd: number; by_lane: Record<string, { calls: number }> };
    expect(after.total_usd).toBeGreaterThanOrEqual(before.total_usd);
    expect(after.by_lane.motion?.calls).toBeGreaterThan(0);
  });
});
