/**
 * direct_shot / apply_plan — the film's own natural-language grammar, kept as
 * two steps on purpose: compile a plan the human can read, then apply it.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { deps } from "./deps";
import { SHOT_ROUTE, asError, cut, lookupShot, openShotPage } from "./util";

interface PlanOp { op: string; [k: string]: unknown }
interface EditPlan { ops: PlanOp[]; note?: string }

interface DirectArgs { shot: string; instruction: string }
interface ApplyArgs { shot: string; plan: EditPlan }

/** One line per op, short enough to read in a chat bubble. */
const opLine = (o: PlanOp): string => {
  const args = Object.entries(o)
    .filter(([k, v]) => k !== "op" && v !== null && v !== undefined && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${cut(Array.isArray(v) ? v.join("/") : String(v), 34)}`)
    .join(" ");
  return cut(`${o.op}${args ? ` ${args}` : ""}`, 96);
};

// ---------------------------------------------------------------- direct_shot

export const directShot: ActionDef<DirectArgs> = {
  name: "direct_shot",
  title: "Direct this shot",
  description:
    "Compile a plain-English direction into Genga Studio's own edit plan and show it on " +
    "screen as a preview — \"hold his pose for the rest of the line\", \"restyle this " +
    "warmer\", \"make it two seconds longer\". Types the instruction into the shot's " +
    "Direct box and compiles it; the deterministic grammar goes first and reads the " +
    "real voice-over duration. Clips play in full unless the direction asks for a " +
    "freeze. NOTHING RUNS: it only returns the plan. Show it, then call apply_plan.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      instruction: { type: "string", description: "The direction in plain English, exactly as the director said it." },
    },
    required: ["shot", "instruction"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: SHOT_ROUTE, anchor: ANCHORS.directInput, label: "Shot Editor → ✨ Direct this shot" },
  keywords: ["direct", "instruction", "plan", "say it", "natural language", "grammar", "compile", "preview"],
  howTo:
    "Type the direction into the \"✨ Direct this shot\" box under the monitor and press " +
    "compile — the plan appears as a preview with an apply button; nothing runs until you press it.",
  summarize: (a) => `Direct ${cut(a?.shot, 20)}: “${cut(a?.instruction, 44)}”`,
  async execute(args, ctx): Promise<ToolResult> {
    const instruction = String(args?.instruction ?? "").trim();
    if (!instruction) {
      return err("needs_instruction", { hint: "Pass the direction in plain English." });
    }
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const opened = await openShotPage(ctx, "direct_shot", pid, shot.sid, {});
    if (!opened.ok) return opened.res;
    const page = opened.page;

    await ctx.trail.step({
      tool: "direct_shot", title: "Type the direction", anchor: ANCHORS.directInput,
      detail: cut(instruction, 140),
    });

    let res: { plan?: unknown; error?: string };
    try { res = await page.direct(instruction); }
    catch (e) { return asError(e, "direct_failed", "The Direct box could not compile that"); }

    if (res?.error || !res?.plan) {
      return err("plan_not_compiled", {
        shot: shot.sid,
        hint: cut(res?.error, 200) ||
          "The grammar could not parse that and no planner backend is enabled. Rephrase, or use freeze_tail / trim_clip / set_shot_timing directly.",
      });
    }

    await ctx.trail.step({
      tool: "direct_shot", title: "Plan compiled — preview shown", anchor: ANCHORS.directSubmit,
    });

    const plan = res.plan as EditPlan;
    const ops = Array.isArray(plan?.ops) ? plan.ops.slice(0, 6) : [];
    return ok(
      `${ops.length} op${ops.length === 1 ? "" : "s"} planned for ${shot.sid} — preview only, nothing has run`,
      {
        shot: shot.sid,
        ops: ops.map(opLine),
        note: cut(plan?.note, 140),
        plan: { ops, ...(plan?.note ? { note: cut(plan.note, 140) } : {}) },
        hint: "Show the plan to the director. If they approve, call apply_plan with this exact plan.",
      },
    );
  },
};

// ---------------------------------------------------------------- apply_plan

export const applyPlan: ActionDef<ApplyArgs> = {
  name: "apply_plan",
  title: "Apply the plan",
  description:
    "Run an edit plan that direct_shot compiled, after the director has approved it. " +
    "Presses ▶ apply on the plan preview, so the same ops a human would run execute in " +
    "order: freezes, trims, generations and state changes. Pass the plan object " +
    "direct_shot returned, unchanged. Returns the jobs it submitted and how each op " +
    "landed. Only call this once the human has said yes to the preview.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot the plan belongs to: a sid, its number in the cut, or a description." },
      plan: {
        type: "object",
        description: "The plan object direct_shot returned, unchanged: { ops: [...], note }.",
        properties: {
          ops: { type: "array", items: { type: "object" }, description: "The ops to run, in order." },
          note: { type: "string", description: "The plan's note." },
        },
        required: ["ops"],
      },
    },
    required: ["shot", "plan"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, anchor: ANCHORS.planApply, label: "Shot Editor → plan preview → ▶ apply" },
  keywords: ["apply", "run", "execute", "plan", "confirm", "do it", "go ahead"],
  howTo: "In the plan preview under the Direct box, read the ops and press ▶ apply plan.",
  summarize: (a) => `Apply ${a?.plan?.ops?.length ?? 0} ops to ${cut(a?.shot, 22)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const plan = args?.plan as EditPlan | undefined;
    if (!plan || !Array.isArray(plan.ops) || !plan.ops.length) {
      return err("needs_plan", {
        hint: "Pass the plan object direct_shot returned — { ops: [...] } with at least one op.",
      });
    }
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const opened = await openShotPage(ctx, "apply_plan", pid, shot.sid, {});
    if (!opened.ok) return opened.res;
    const page = opened.page;

    await ctx.trail.step({
      tool: "apply_plan", title: `▶ apply ${plan.ops.length} op${plan.ops.length === 1 ? "" : "s"}`,
      anchor: ANCHORS.planApply,
      detail: plan.ops.map((o) => o.op).join(" → ").slice(0, 140),
    });

    let out: { results: unknown[]; note?: string };
    try { out = await page.applyPlan(plan); }
    catch (e) { return asError(e, "apply_failed", "The plan was rejected"); }

    const results = Array.isArray(out?.results) ? out.results : [];
    const jobs = results
      .map((r) => (r as { job?: string })?.job)
      .filter((j): j is string => typeof j === "string" && !!j);

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    if (jobs.length) {
      try { settled = await deps.settleJobs(jobs, { settleMs: 8000, signal: ctx.signal, api: ctx.api }); }
      catch { /* queued regardless */ }
    }
    const takes = settled.flatMap((s) => s.takes || []).slice(0, 4)
      .map((t) => cut(t.path, 60));
    const running = settled.filter((s) => s.status !== "done" && s.status !== "error").length;
    try { await page.refresh(); } catch { /* fine */ }

    return ok(
      `Applied ${results.length} op${results.length === 1 ? "" : "s"} on ${shot.sid}` +
      (jobs.length ? ` — ${jobs.length} job${jobs.length === 1 ? "" : "s"} submitted` : ""),
      {
        shot: shot.sid,
        applied: plan.ops.slice(0, 6).map((o) => o.op),
        jobs,
        takes,
        note: cut(out?.note ?? plan.note, 140),
        ...(running > 0 ? { hint: "Some jobs are still running — call wait_for_jobs with these ids." } : {}),
      },
    );
  },
};
