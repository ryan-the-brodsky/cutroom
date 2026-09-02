/**
 * Motion budget planner — plan_motion / apply_motion_plan.
 *
 * The director has a number ("about three dollars of animation") and a film
 * with sixty shots. These two tools turn that number into an ordered list of
 * shots worth animating, and then spend it.
 *
 * Doctrine (2026-09-02): a clip plays in FULL for the backend profile's
 * default length. Freezing is a repair tool for a clip that drifts, not a
 * default, so nothing here plans a freeze.
 *
 * Owned by workstream N. See docs/BACKENDS.md "Motion profiles".
 */
import type { ActionContext, ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { deps, type BackendChoice } from "./deps";
import { FILM_ROUTE, cut, lookupShot } from "./util";
import { generateTakes } from "./generate";

// ---------------------------------------------------------------- profile

/** The subset of a backend's `motion_profile` the planner reasons about. */
export interface MotionProfile {
  seconds_default?: number;
  seconds_max?: number;
  seconds_options?: number[];
  live_seconds_default?: number;
  live_seconds_max?: number;
  fps?: number;
  frames_options?: number[];
  resolutions?: string[];
  cost_per_clip_usd?: number;
  cost_per_second_usd?: number;
  note?: string;
}

export const DEFAULT_PROFILE: MotionProfile = {
  seconds_default: 2, seconds_max: 5, live_seconds_default: 1, fps: 24,
  cost_per_clip_usd: 0,
};

export function clampSeconds(p: MotionProfile, seconds: number): number {
  const max = p.seconds_max ?? 5;
  let v = Math.max(0.1, Math.min(seconds, max));
  const opts = p.seconds_options;
  if (Array.isArray(opts) && opts.length) {
    v = opts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), opts[0]);
  }
  return Math.round(v * 1000) / 1000;
}

/** Seconds -> a frame count this backend actually accepts. */
export function framesForSeconds(p: MotionProfile, seconds: number): number {
  const fps = Math.max(1, Math.round(p.fps ?? 24));
  const want = Math.max(1, Math.round(clampSeconds(p, seconds) * fps));
  const opts = p.frames_options;
  if (Array.isArray(opts) && opts.length) {
    return opts.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a), opts[0]);
  }
  return Math.max(9, Math.round((want - 1) / 8) * 8 + 1);   // LTX wants 8k+1
}

/** Dollars for one clip at this profile. */
export function clipCost(p: MotionProfile, seconds: number, fallback = 0): number {
  if (typeof p.cost_per_second_usd === "number") {
    return Math.round(p.cost_per_second_usd * clampSeconds(p, seconds) * 10000) / 10000;
  }
  if (typeof p.cost_per_clip_usd === "number") return p.cost_per_clip_usd;
  return fallback;
}

/** Read the motion lane's profile off `GET /api/backends`. */
export async function motionProfile(
  ctx: ActionContext, backendId: string | null,
): Promise<MotionProfile> {
  if (!backendId) return { ...DEFAULT_PROFILE };
  try {
    const rows = await ctx.api<{ id: string; options?: Record<string, unknown>;
                                 motion_profile?: MotionProfile }[]>("/api/backends");
    const row = (rows || []).find((b) => b.id === backendId);
    const p = row?.motion_profile
      ?? (row?.options?.motion_profile as MotionProfile | undefined);
    return p ? { ...DEFAULT_PROFILE, ...p } : { ...DEFAULT_PROFILE };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/**
 * Which model to reach for per register. Filled in from the bake-off in
 * docs/research/motion-bakeoff/RESULTS.md; the default stays whatever
 * CUTROOM_FAL_MOTION_MODEL is set to, and this is only a hint in the output.
 */
export const MODEL_HINTS: Record<string, string> = {
  effects: "fal-ai/wan/v2.2-a14b/image-to-video/turbo",
  dialogue: "fal-ai/wan/v2.2-a14b/image-to-video/turbo",
  wide: "fal-ai/wan/v2.2-a14b/image-to-video/turbo",
};

// ---------------------------------------------------------------- ranking

export interface PlanShot {
  sid: string;
  act?: number;
  beat?: string;
  type?: string;
  register?: string;
  seconds?: number;
  motion_prompt?: string | null;
  keeper?: string | null;
  stills?: string[];
  motion?: string[];
  fx?: string[];
}

export type Prefer = "hero" | "motion_prompt" | "longest" | "climax";

export interface Ranked {
  shot: string;
  score: number;
  why: string;
  seconds: number;
  skipped?: string;
}

const W = { hero: 3, motion_prompt: 2.5, longest: 2, climax: 1.5, has_motion: -4 };

/**
 * Rank shots by how much a motion clip would buy the film.
 *
 * HERO shots first, then shots the director actually wrote a motion prompt
 * for, then the longest shots (a 6 s hold gains more from movement than a 1 s
 * cut), then later acts as climaxes. Shots that already have a clip drop to
 * the bottom; shots with no plate to animate are skipped outright.
 * `prefer` doubles the weight of the criteria it names.
 */
export function rankShots(
  rows: PlanShot[], opts: { prefer?: Prefer[]; seconds?: number; profile?: MotionProfile } = {},
): Ranked[] {
  const prof = opts.profile ?? DEFAULT_PROFILE;
  const prefer = new Set(opts.prefer || []);
  const w = (k: keyof typeof W) => W[k] * (prefer.has(k as Prefer) ? 2 : 1);
  const maxSeconds = Math.max(1, ...rows.map((r) => Number(r.seconds) || 0));
  const maxAct = Math.max(1, ...rows.map((r) => Number(r.act) || 0));

  const out: Ranked[] = [];
  for (const r of rows) {
    const seconds = clampSeconds(prof, opts.seconds ?? prof.seconds_default ?? 2);
    const plate = r.keeper || r.stills?.[0] || null;
    if (!plate) {
      out.push({ shot: r.sid, score: -Infinity, seconds, why: "",
                 skipped: "no plate — set a keeper still first" });
      continue;
    }
    const hasMotion = Boolean((r.motion?.length || 0) + (r.fx?.length || 0));
    const isHero = /HERO/i.test(r.type || "");
    const hasPrompt = Boolean((r.motion_prompt || "").trim());
    const dur = Number(r.seconds) || 0;
    const act = Number(r.act) || 0;

    let score = 0;
    const why: string[] = [];
    if (isHero) { score += w("hero"); why.push("HERO"); }
    if (hasPrompt) { score += w("motion_prompt"); why.push("has a motion prompt"); }
    score += w("longest") * (dur / maxSeconds);
    if (dur >= maxSeconds * 0.75) why.push(`${dur}s on screen`);
    score += w("climax") * (act / maxAct);
    if (act >= maxAct && maxAct > 1) why.push("climax act");
    if (hasMotion) { score += w("has_motion"); why.push("already has a clip"); }

    out.push({
      shot: r.sid, score: Math.round(score * 1000) / 1000, seconds,
      why: why.length ? why.join(", ") : `act ${act || 1}, ${dur || "?"}s`,
    });
  }
  return out
    .filter((r) => !r.skipped)
    .sort((a, b) => b.score - a.score || a.shot.localeCompare(b.shot))
    .concat(out.filter((r) => r.skipped));
}

export interface PlanItem { shot: string; seconds: number; est_usd: number; why: string }
export interface FittedPlan {
  items: PlanItem[];
  total_usd: number;
  budget_usd: number;
  left: number;
  dropped: number;
}

/** Take ranked shots in order while they fit the budget. */
export function fitBudget(
  ranked: Ranked[], opts: { budget_usd: number; profile?: MotionProfile;
                            max_shots?: number; unit_usd?: number },
): FittedPlan {
  const prof = opts.profile ?? DEFAULT_PROFILE;
  const budget = Math.max(0, Number(opts.budget_usd) || 0);
  const cap = Math.max(1, Math.min(opts.max_shots ?? 24, 60));
  const items: PlanItem[] = [];
  let total = 0;
  let dropped = 0;
  for (const r of ranked) {
    if (r.skipped) { dropped += 1; continue; }
    if (items.length >= cap) { dropped += 1; continue; }
    const est = clipCost(prof, r.seconds, opts.unit_usd ?? 0);
    if (total + est > budget + 1e-9) { dropped += 1; continue; }
    items.push({ shot: r.shot, seconds: r.seconds,
                 est_usd: Math.round(est * 10000) / 10000, why: r.why });
    total += est;
  }
  return {
    items,
    total_usd: Math.round(total * 10000) / 10000,
    budget_usd: Math.round(budget * 100) / 100,
    left: Math.round((budget - total) * 10000) / 10000,
    dropped,
  };
}

// ---------------------------------------------------------------- shared

async function resolveLane(ctx: ActionContext, pid: string, backend?: string) {
  let choice: BackendChoice;
  try { choice = await deps.classifyBackend(pid, "motion", backend, ctx.api); }
  catch { choice = { backend: backend || null, cost_class: "free" }; }
  const profile = await motionProfile(ctx, choice.backend);
  return { choice, profile };
}

export async function readSpend(ctx: ActionContext, pid: string) {
  try {
    return await ctx.api<{ total_usd: number; by_lane: Record<string, { usd: number }>;
                           takes: number }>(`/api/projects/${pid}/spend`);
  } catch { return null; }
}

const PREFER: Prefer[] = ["hero", "motion_prompt", "longest", "climax"];

interface PlanArgs {
  project?: string;
  budget_usd: number;
  seconds_per_clip?: number;
  prefer?: Prefer[];
  max_shots?: number;
  backend?: string;
}

// ---------------------------------------------------------------- plan_motion

export const planMotion: ActionDef<PlanArgs> = {
  name: "plan_motion",
  title: "Plan a motion budget",
  description:
    "Plan how to spend a dollar budget on animating this film. Ranks every shot " +
    "by how much movement would buy it — HERO shots, shots the director wrote a " +
    "motion prompt for, the longest holds, and later acts as climaxes, with shots " +
    "that already have a clip pushed down — then returns the ordered list that " +
    "fits the budget at the motion backend's own price and clip length. Reads " +
    "only; apply_motion_plan spends it. Reports what the project has cost so far.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project id. Defaults to the project on screen." },
      budget_usd: { type: "number", description: "Dollars to spend on motion, e.g. 4. The plan stops when the next clip would pass it." },
      seconds_per_clip: { type: "number", description: "Clip length in seconds. Defaults to the backend's own default and is clamped to what it supports." },
      prefer: { type: "array", items: { type: "string", enum: PREFER }, description: "Criteria to weight double: hero, motion_prompt, longest, climax." },
      max_shots: { type: "integer", description: "Cap the plan at this many shots even if the budget allows more." },
      backend: { type: "string", description: "Price the plan against a specific backend id instead of the project's motion default." },
    },
    required: ["budget_usd"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmShot, label: "Film Editor → the strip" },
  group: "Film Editor",
  keywords: ["plan", "budget", "motion", "animate", "spend", "money", "cost", "which shots"],
  howTo:
    "Walk the strip in the Film Editor and pick the shots worth animating by eye, " +
    "then check Settings → Backends for the motion backend's per-clip price.",
  summarize: (a) => `Plan $${Number(a?.budget_usd ?? 0).toFixed(2)} of motion`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = args?.project || ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project, or pass `project`." });
    const budget = Number(args?.budget_usd);
    if (!Number.isFinite(budget) || budget <= 0) {
      return err("needs_budget", { hint: "Pass budget_usd, e.g. 4 for four dollars of animation." });
    }

    let rows: PlanShot[];
    try { rows = await ctx.api<PlanShot[]>(`/api/projects/${pid}/film`); }
    catch (e) { return err("film_unavailable", { hint: cut((e as Error)?.message, 140) }); }
    if (!rows?.length) return err("empty_film", { hint: "This project has no shots yet." });

    const { choice, profile } = await resolveLane(ctx, pid, args?.backend);
    const unit = choice.cost_usd;
    const ranked = rankShots(rows, {
      prefer: (args?.prefer || []).filter((p) => PREFER.includes(p)),
      seconds: args?.seconds_per_clip,
      profile,
    });
    const plan = fitBudget(ranked, {
      budget_usd: budget, profile, max_shots: args?.max_shots, unit_usd: unit,
    });
    const spend = await readSpend(ctx, pid);

    const perClip = clipCost(profile, plan.items[0]?.seconds ?? profile.seconds_default ?? 2, unit ?? 0);
    const noPlate = ranked.filter((r) => r.skipped).length;
    return ok(
      `${plan.items.length} shot${plan.items.length === 1 ? "" : "s"} for ` +
      `$${plan.total_usd.toFixed(2)} of $${plan.budget_usd.toFixed(2)} on ${choice.backend || "the lane default"}`,
      {
        backend: choice.backend,
        cost_class: choice.cost_class,
        per_clip_usd: perClip,
        clip_seconds: plan.items[0]?.seconds ?? profile.seconds_default,
        profile: {
          seconds_default: profile.seconds_default,
          seconds_max: profile.seconds_max,
          fps: profile.fps,
          holds_seconds: profile.live_seconds_default,
        },
        items: plan.items.map((i) => ({ ...i, why: cut(i.why, 64) })),
        total_usd: plan.total_usd,
        budget_usd: plan.budget_usd,
        left: plan.left,
        ...(noPlate ? { no_plate: noPlate } : {}),
        ...(spend ? { spent_so_far_usd: spend.total_usd } : {}),
        model_hint: `use ${MODEL_HINTS.effects} for effects bursts`,
        hint: plan.items.length
          ? "Call apply_motion_plan with the same arguments and confirm_cost:true to run it."
          : "Nothing fits — raise budget_usd, or set keeper stills so shots have a plate.",
      },
    );
  },
};

// ---------------------------------------------------------------- apply

interface ApplyArgs extends PlanArgs {
  plan?: PlanItem[];
  confirm_cost?: boolean;
}

export const applyMotionPlan: ActionDef<ApplyArgs> = {
  name: "apply_motion_plan",
  title: "Run a motion plan",
  description:
    "Spend a motion budget: animate each shot of a plan_motion plan in order, on " +
    "screen, one clip per shot, stopping the moment the next clip would pass the " +
    "budget. Pass the plan back verbatim, or the same arguments to re-plan and run " +
    "in one turn. Paid backends need confirm_cost. Returns the jobs and takes per " +
    "shot with the running total; clips play in full at the backend's clip length.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project id. Defaults to the project on screen." },
      plan: {
        type: "array",
        description: "The items from plan_motion, in order. Omit to re-plan from budget_usd.",
        items: {
          type: "object",
          properties: {
            shot: { type: "string", description: "The shot sid." },
            seconds: { type: "number", description: "Clip length in seconds." },
            est_usd: { type: "number", description: "Estimated dollars for this clip." },
            why: { type: "string", description: "Why this shot earned a clip." },
          },
          required: ["shot"],
        },
      },
      budget_usd: { type: "number", description: "Dollars to spend. Required when no plan is passed; also the hard stop while running." },
      seconds_per_clip: { type: "number", description: "Clip length in seconds. Defaults to the backend's own default." },
      prefer: { type: "array", items: { type: "string", enum: PREFER }, description: "Criteria to weight double: hero, motion_prompt, longest, climax." },
      max_shots: { type: "integer", description: "Cap the run at this many shots." },
      backend: { type: "string", description: "Force a backend id instead of the project's motion default." },
      confirm_cost: { type: "boolean", description: "Set true to approve a paid backend. Required whenever the motion lane bills money." },
    },
    required: ["budget_usd"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmShot, label: "Film Editor → the strip" },
  group: "Film Editor",
  keywords: ["apply", "run", "plan", "budget", "animate", "motion", "spend", "batch"],
  howTo:
    "Open each shot in turn, press Generate → animate and submit one clip — this " +
    "does the same walk in budget order and stops when the money runs out.",
  summarize: (a) => `Spend $${Number(a?.budget_usd ?? 0).toFixed(2)} animating shots`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = args?.project || ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project, or pass `project`." });
    const budget = Number(args?.budget_usd);
    if (!Number.isFinite(budget) || budget <= 0) {
      return err("needs_budget", { hint: "Pass budget_usd — the run stops when it is reached." });
    }

    const { choice, profile } = await resolveLane(ctx, pid, args?.backend);
    if (choice.cost_class === "paid" && args?.confirm_cost !== true) {
      return err("needs_confirmation", {
        backend: choice.backend,
        cost_class: "paid",
        estimate: `up to $${budget.toFixed(2)} on ${choice.backend}`,
        hint: "re-call with confirm_cost:true, or pass backend:\"mock\" to rehearse for free",
      });
    }

    // Re-plan when the caller passed only a budget.
    let items: PlanItem[] = Array.isArray(args?.plan) ? args!.plan! : [];
    if (!items.length) {
      let rows: PlanShot[];
      try { rows = await ctx.api<PlanShot[]>(`/api/projects/${pid}/film`); }
      catch (e) { return err("film_unavailable", { hint: cut((e as Error)?.message, 140) }); }
      const ranked = rankShots(rows, {
        prefer: (args?.prefer || []).filter((p) => PREFER.includes(p)),
        seconds: args?.seconds_per_clip, profile,
      });
      items = fitBudget(ranked, {
        budget_usd: budget, profile, max_shots: args?.max_shots,
        unit_usd: choice.cost_usd,
      }).items;
    }
    if (!items.length) {
      return err("empty_plan", {
        hint: "Nothing fits the budget — raise budget_usd, or set keeper stills so shots have a plate.",
      });
    }

    const done: { shot: string; jobs: string[]; takes: number; est_usd: number }[] = [];
    const failed: { shot: string; error: string }[] = [];
    let spent = 0;
    let stopped: string | undefined;

    for (const item of items) {
      if (ctx.signal?.aborted) { stopped = "cancelled"; break; }
      const seconds = clampSeconds(profile, Number(item.seconds) || (profile.seconds_default ?? 2));
      const est = clipCost(profile, seconds, choice.cost_usd ?? 0);
      if (spent + est > budget + 1e-9) { stopped = "budget reached"; break; }

      // Same code path a director's "animate this shot" takes.
      let res: ToolResult;
      try {
        res = await generateTakes.execute({
          shot: item.shot, lane: "animate", count: 1, seconds,
          ...(args?.backend ? { backend: args.backend } : {}),
          confirm_cost: args?.confirm_cost === true,
        }, ctx);
      } catch (e) {
        failed.push({ shot: item.shot, error: cut((e as Error)?.message, 70) });
        continue;
      }
      if (!res.ok) {
        const e = res as { error: string; hint?: string; detail?: string };
        // A 402 from the demo spend cap is the end of the run, not one failure.
        const text = `${e.error} ${e.hint ?? ""}`.toLowerCase();
        failed.push({ shot: item.shot, error: cut(e.error, 40) });
        if (/budget|402|exhaust/.test(text)) { stopped = "server spend cap (402)"; break; }
        continue;
      }
      const r = res as unknown as { jobs?: string[]; takes?: { path: string }[] };
      const jobs = r.jobs || [];
      let takes = r.takes?.length || 0;
      if (jobs.length && takes === 0) {
        try {
          const settled = await deps.settleJobs(jobs, {
            settleMs: 60_000, signal: ctx.signal, api: ctx.api,
          });
          takes = settled.flatMap((s) => s.takes || []).length;
        } catch { /* queued regardless */ }
      }
      spent += est;
      done.push({ shot: item.shot, jobs, takes, est_usd: Math.round(est * 10000) / 10000 });
    }

    const spendNow = await readSpend(ctx, pid);
    if (!done.length) {
      return err("nothing_ran", {
        hint: failed[0]?.error || "Every shot was refused — check plates and the backend.",
        failed: failed.slice(0, 3),
      });
    }
    return ok(
      `Animated ${done.length} shot${done.length === 1 ? "" : "s"} for ` +
      `$${spent.toFixed(2)} of $${budget.toFixed(2)} on ${choice.backend || "the lane default"}` +
      (stopped ? ` — stopped: ${stopped}` : ""),
      {
        backend: choice.backend,
        shots: done.map((d) => ({ shot: d.shot, jobs: d.jobs.slice(0, 2),
                                  takes: d.takes, est_usd: d.est_usd })),
        spent_usd: Math.round(spent * 10000) / 10000,
        budget_usd: Math.round(budget * 100) / 100,
        left: Math.round((budget - spent) * 10000) / 10000,
        ...(stopped ? { stopped } : {}),
        ...(failed.length ? { failed: failed.slice(0, 3) } : {}),
        ...(spendNow ? { project_total_usd: spendNow.total_usd } : {}),
      },
    );
  },
};

/** Re-export for the shot resolver used by tests. */
export const _internals = { lookupShot };
