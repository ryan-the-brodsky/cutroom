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

// ---------------------------------------------------------------- registry

/** One record from `GET /api/motion-models`. */
export interface MotionModel {
  id: string;
  key: string;
  label: string;
  rank: number;
  note?: string;
  cost?: { per_clip_usd?: number; per_second_usd?: number; resolution?: string };
  seconds_max?: number;
  fps?: number;
  strengths?: string[];
  limits?: string[];
  failure_modes?: string;
  fallback?: string;
  registers?: Register[];
  enabled?: boolean;
}

export type Register = "dialogue_closeup" | "wide_tableau" | "effects_burst"
  | "legible_text";

/**
 * Mirrors the server registry so the planner still works offline. The live
 * list from `GET /api/motion-models` always wins.
 */
export const FALLBACK_REGISTRY: MotionModel[] = [
  { id: "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video", key: "seedance",
    label: "Seedance 1.0 pro fast", rank: 1, note: "best when budget allows",
    cost: { per_second_usd: 0.0216, resolution: "720p" }, seconds_max: 12, fps: 24,
    failure_modes: "may replace dark close-ups with a brighter room; grade drifts warm on wides",
    fallback: "wan",
    registers: ["legible_text", "effects_burst", "wide_tableau"], enabled: true },
  { id: "fal-ai/wan/v2.2-a14b/image-to-video/turbo", key: "wan",
    label: "Wan 2.2 A14B turbo", rank: 2,
    note: "cheap fallback, best plate fidelity in dark close-ups",
    cost: { per_clip_usd: 0.05, resolution: "480p" }, seconds_max: 5, fps: 16,
    failure_modes: "small motion amplitude; drops fine text after ~2s",
    fallback: "seedance",
    registers: ["dialogue_closeup", "wide_tableau"], enabled: true },
];

/** The sentence every motion tool carries. */
export const UNFAITHFUL_DOCTRINE =
  "Faithfulness problems are usually the model, not the prompt: switch to the " +
  "registry's fallback and rerun before rewriting the sentence.";

export async function motionModels(ctx: ActionContext): Promise<MotionModel[]> {
  try {
    const r = await ctx.api<{ models: MotionModel[] }>("/api/motion-models");
    const rows = (r?.models || []).filter((m) => m.enabled !== false);
    return rows.length ? rows.slice().sort((a, b) => a.rank - b.rank)
      : FALLBACK_REGISTRY;
  } catch { return FALLBACK_REGISTRY; }
}

export function modelCost(m: MotionModel, seconds: number): number {
  const secs = Math.max(0.1, Math.min(seconds, m.seconds_max ?? 5));
  if (typeof m.cost?.per_second_usd === "number") {
    return Math.round(m.cost.per_second_usd * secs * 10000) / 10000;
  }
  return m.cost?.per_clip_usd ?? 0;
}

export function findModel(models: MotionModel[], ref?: string | null) {
  if (!ref) return null;
  return models.find((m) => m.key === ref || m.id === ref) ?? null;
}

/**
 * The highest-ranked model that fits the money left. A register a model was
 * *measured* to win gets first refusal, which is how a dark close-up lands on
 * Wan even when Seedance is affordable. Mirrors `pick_model` on the server.
 */
export function pickModel(
  models: MotionModel[], remainingUsd: number, seconds: number,
  register?: Register | null,
): { model: MotionModel | null; why: string } {
  if (!models.length) return { model: null, why: "no motion model is enabled" };
  const byRank = (a: MotionModel, b: MotionModel) => a.rank - b.rank;
  const wins = register ? models.filter((m) => m.registers?.includes(register)) : [];
  const rest = models.filter((m) => !wins.includes(m));
  const ordered = [...wins].sort(byRank).concat([...rest].sort(byRank));

  for (const m of ordered) {
    const usd = modelCost(m, seconds);
    if (usd > remainingUsd + 1e-9) continue;
    const why = wins.includes(m) || m.rank === 1
      ? `${m.label} — ${m.note ?? ""}`.replace(/ — $/, "")
      : `${m.label} — fits the $${remainingUsd.toFixed(2)} left`;
    return { model: m, why: `${why} ($${usd.toFixed(3)})` };
  }
  const cheapest = Math.min(...models.map((m) => modelCost(m, seconds)));
  return { model: null, why: `$${remainingUsd.toFixed(2)} left will not buy a ` +
    `clip (cheapest is $${cheapest.toFixed(3)})` };
}

/**
 * What to rerun on when a take does not match its plate. Faithfulness is a
 * model property, not a prompt problem.
 */
export function unfaithfulHint(
  models: MotionModel[], ref?: string | null, register?: string | null,
): string | undefined {
  const m = findModel(models, ref);
  const fb = findModel(models, m?.fallback);
  if (!m || !fb) return undefined;
  const symptom = m.failure_modes || "the clip drifted off the plate";
  const where = register ? ` for ${register.replace(/_/g, " ")}` : "";
  return `If the plate was not respected (${symptom}), rerun${where} with ` +
    `model:"${fb.key}" (${fb.note ?? fb.label}).`;
}

/**
 * The register a shot reads as, for model choice. HERO shots that are short or
 * described as close are dialogue close-ups (where Wan won); anything naming a
 * screen, text or a terminal needs the model that holds legible detail.
 */
export function registerOf(shot: PlanShot): Register {
  const text = `${shot.register ?? ""} ${shot.type ?? ""} ${shot.motion_prompt ?? ""}`
    .toLowerCase();
  // prefixes, not whole words: "monitors", "glyphs", "beams" all count
  if (/\b(screen|text|monitor|terminal|glyph|code|sign|caption)/.test(text)) return "legible_text";
  if (/\b(burst|flash|explos|impact|sweep|beam|spark)/.test(text)) return "effects_burst";
  if (/\b(close|face|eyes|hand|blink|jaw|mouth)/.test(text)) return "dialogue_closeup";
  if (/HERO/i.test(shot.type ?? "") && (shot.seconds ?? 9) <= 5) return "dialogue_closeup";
  return "wide_tableau";
}

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
  /** Which register this shot reads as — drives the model choice. */
  register?: Register;
  skipped?: string;
  shot_seconds?: number;       // the scripted length of the shot
  seconds_explicit?: boolean;  // caller asked for a clip length
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
                 shot_seconds: Number(r.seconds) || 0, seconds_explicit: opts.seconds != null,
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
      shot_seconds: dur, seconds_explicit: opts.seconds != null,
      register: registerOf(r),
      why: why.length ? why.join(", ") : `act ${act || 1}, ${dur || "?"}s`,
    });
  }
  return out
    .filter((r) => !r.skipped)
    .sort((a, b) => b.score - a.score || a.shot.localeCompare(b.shot))
    .concat(out.filter((r) => r.skipped));
}

export interface PlanItem {
  shot: string; seconds: number; est_usd: number; why: string;
  /** Registry key ("seedance"/"wan") chosen for this shot. */
  model?: string;
  /** One line: why this model, at this price, for this shot. */
  model_why?: string;
  register?: Register;
}
export interface FittedPlan {
  items: PlanItem[];
  total_usd: number;
  budget_usd: number;
  left: number;
  dropped: number;
}

/**
 * Take ranked shots in order while they fit the budget.
 *
 * With a registry in hand each shot also gets a MODEL: the highest-ranked one
 * that still fits what is left, with the register it was measured to win
 * getting first refusal. So a comfortable budget buys Seedance, a thin one
 * degrades to Wan rather than dropping shots, and a dark close-up takes Wan
 * either way. Without a registry it falls back to the lane's flat price.
 */
export function fitBudget(
  ranked: Ranked[], opts: { budget_usd: number; profile?: MotionProfile;
                            max_shots?: number; unit_usd?: number;
                            models?: MotionModel[] },
): FittedPlan {
  const prof = opts.profile ?? DEFAULT_PROFILE;
  const budget = Math.max(0, Number(opts.budget_usd) || 0);
  const cap = Math.max(1, Math.min(opts.max_shots ?? 24, 60));
  const models = opts.models ?? [];
  const items: PlanItem[] = [];
  let total = 0;
  let dropped = 0;
  for (const r of ranked) {
    if (r.skipped) { dropped += 1; continue; }
    if (items.length >= cap) { dropped += 1; continue; }
    if (models.length) {
      // Cover the shot: a 9 s shot gets a 9 s clip when the model can make one,
      // unless the caller fixed the clip length. A short clip in a long shot is a hold.
      const wantSeconds = (r.seconds_explicit || !r.shot_seconds)
        ? r.seconds
        : Math.max(2, Math.min(r.shot_seconds, Number(models[0]?.seconds_max) || r.seconds, 12));
      const picked = pickModel(models, budget - total, wantSeconds, r.register);
      if (!picked.model) { dropped += 1; continue; }
      const secs = Math.min(wantSeconds, Number(picked.model.seconds_max) || wantSeconds);
      const est = modelCost(picked.model, secs);
      items.push({ shot: r.shot, seconds: Math.round(secs * 10) / 10,
                   est_usd: Math.round(est * 10000) / 10000, why: r.why,
                   model: picked.model.key, model_why: picked.why,
                   ...(r.register ? { register: r.register } : {}) });
      total += est;
      continue;
    }
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
    "by how much movement would buy it — HERO shots, shots with a motion prompt, " +
    "the longest holds, later acts as climaxes, shots that already have a clip " +
    "pushed down — then fits the budget, picking a model per shot from the " +
    "registry of cost and use cases. Reads only. Faithfulness problems are " +
    "usually the model, not the prompt: switch to the fallback and rerun.",
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
    // The registry only applies to backends that can serve more than one model.
    const models = choice.type === "fal" || choice.backend === "fal"
      ? await motionModels(ctx) : [];
    const ranked = rankShots(rows, {
      prefer: (args?.prefer || []).filter((p) => PREFER.includes(p)),
      seconds: args?.seconds_per_clip,
      profile,
    });
    const plan = fitBudget(ranked, {
      budget_usd: budget, profile, max_shots: args?.max_shots, unit_usd: unit,
      models,
    });
    const spend = await readSpend(ctx, pid);

    const perClip = clipCost(profile, plan.items[0]?.seconds ?? profile.seconds_default ?? 2, unit ?? 0);
    const noPlate = ranked.filter((r) => r.skipped).length;
    const used = [...new Set(plan.items.map((i) => i.model).filter(Boolean))];
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
        items: plan.items.map((i) => ({
          shot: i.shot, seconds: i.seconds, est_usd: i.est_usd,
          why: cut(i.why, 56),
          ...(i.model ? { model: i.model, model_why: cut(i.model_why, 60) } : {}),
        })),
        total_usd: plan.total_usd,
        budget_usd: plan.budget_usd,
        left: plan.left,
        ...(noPlate ? { no_plate: noPlate } : {}),
        ...(spend ? { spent_so_far_usd: spend.total_usd } : {}),
        ...(models.length
          ? { models: models.map((m) => ({
                key: m.key, usd: modelCost(m, plan.items[0]?.seconds ?? 5),
                good_at: (m.registers || []).join("/"), note: cut(m.note, 44),
              })) }
          : {}),
        ...(used.length ? { models_used: used } : {}),
        doctrine: UNFAITHFUL_DOCTRINE,
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
    const models = choice.type === "fal" || choice.backend === "fal"
      ? await motionModels(ctx) : [];
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
        unit_usd: choice.cost_usd, models,
      }).items;
    }
    if (!items.length) {
      return err("empty_plan", {
        hint: "Nothing fits the budget — raise budget_usd, or set keeper stills so shots have a plate.",
      });
    }

    const done: { shot: string; jobs: string[]; takes: number; est_usd: number;
                  model?: string }[] = [];
    const failed: { shot: string; error: string }[] = [];
    let spent = 0;
    let stopped: string | undefined;

    for (const item of items) {
      if (ctx.signal?.aborted) { stopped = "cancelled"; break; }
      // Pick the model first, then clamp against THAT model's ceiling: the backend's
      // default profile (Wan, 5 s) must not shorten a 9 s Seedance clip.
      const want = Number(item.seconds) || (profile.seconds_default ?? 2);
      const chosen = findModel(models, item.model)
        ?? (models.length ? pickModel(models, budget - spent, want, item.register).model : null);
      const seconds = chosen && chosen.seconds_max
        ? Math.round(Math.max(0.1, Math.min(want, chosen.seconds_max)) * 10) / 10
        : clampSeconds(profile, want);
      const est = chosen ? modelCost(chosen, seconds)
        : clipCost(profile, seconds, choice.cost_usd ?? 0);
      if (spent + est > budget + 1e-9) { stopped = "budget reached"; break; }

      // Same code path a director's "animate this shot" takes.
      let res: ToolResult;
      try {
        res = await generateTakes.execute({
          shot: item.shot, lane: "animate", count: 1, seconds,
          ...(chosen ? { model: chosen.key } : {}),
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
      done.push({ shot: item.shot, jobs, takes,
                  est_usd: Math.round(est * 10000) / 10000,
                  ...(chosen ? { model: chosen.key } : {}) });
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
                                  takes: d.takes, est_usd: d.est_usd,
                                  ...(d.model ? { model: d.model } : {}) })),
        ...(unfaithfulHint(models, done[0]?.model)
          ? { next_if_unfaithful: unfaithfulHint(models, done[0]?.model) } : {}),
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
