/**
 * Motion edits: freeze_tail and trim_clip — the FIRST-SECOND LAW toolkit.
 * True freezes only; there is no zoom op and there never will be.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok, shotTabAnchor } from "../contract";
import { deps } from "./deps";
import {
  IS_CLIP, SHOT_ROUTE, asError, cut, fetchShot, lookupShot, maybeNum,
  openShotPage, pickTake, safeState,
} from "./util";

interface FreezeArgs { shot: string; take?: string; live_seconds?: number }
interface TrimArgs { shot: string; take?: string; end_seconds: number }

/** Shared: get to the Motion edits tab with a clip selected. */
async function stageClip(
  ctx: Parameters<ActionDef["execute"]>[1], tool: string, shotArg: unknown, takeArg: unknown,
) {
  const found = await lookupShot(ctx, shotArg);
  if (!found.ok) return { ok: false as const, res: found.res };
  const { pid, shot } = found;

  let detail;
  try { detail = await fetchShot(ctx, pid, shot.sid); }
  catch (e) { return { ok: false as const, res: asError(e, "shot_fetch_failed", "Could not read the shot") }; }

  const hit = await pickTake(ctx, pid, detail, takeArg, { prefer: "clip" });
  if (!hit) {
    return { ok: false as const, res: err("needs_clip", {
      hint: `${shot.sid} has no motion clip yet — generate one first (generate_takes lane:"animate").`,
    }) };
  }
  if (!IS_CLIP(hit.path)) {
    return { ok: false as const, res: err("not_a_clip", {
      take: cut(hit.path, 60),
      hint: "Motion edits only work on video takes (.mp4/.webm/.mov). Pass take:\"newest motion\".",
    }) };
  }

  const opened = await openShotPage(ctx, tool, pid, shot.sid, { tab: "motion", take: hit.path });
  if (!opened.ok) return { ok: false as const, res: opened.res };
  const page = opened.page;

  page.setTab("motion");
  page.selectTake(hit.path);
  await ctx.trail.step({
    tool, title: `Motion edits on ${cut(hit.path.split("/").pop(), 30)}`,
    anchor: shotTabAnchor("motion"), detail: hit.path,
  });
  return { ok: true as const, pid, sid: shot.sid, page, clip: hit.path };
}

// ---------------------------------------------------------------- freeze_tail

export const freezeTail: ActionDef<FreezeArgs> = {
  name: "freeze_tail",
  title: "Freeze the tail",
  description:
    "Keep the first moment of a motion clip live and hold the rest as a true " +
    "freeze — the held-cel edit anime uses so a gesture reads and then the pose " +
    "sits. Opens the shot's Motion edits tab, selects the clip, sets how many " +
    "seconds stay live (default 1.0) and presses ❄ freeze tail. This is a real " +
    "frozen frame, never a slow zoom or a drift. Returns the job and, when it " +
    "finishes fast, the new take.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: "Which clip: a path, or \"newest motion\", \"latest\", \"plays\". Defaults to the selected clip." },
      live_seconds: { type: "number", description: "Seconds of live motion kept before the freeze holds. Default 1.0 (the first-second law)." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "motion" },
    anchor: ANCHORS.motionFreeze, label: "Shot Editor → Motion edits → ❄ freeze tail",
  },
  keywords: ["freeze", "hold", "held cel", "first second", "tail", "pose", "stop", "still the rest"],
  howTo:
    "Select a clip in the takes rail, open the Motion edits tab, set \"keep first (s)\" " +
    "and press ❄ freeze tail — the rest of the clip becomes a true frozen frame.",
  summarize: (a) => `Freeze ${cut(a.shot, 24)} after ${maybeNum(a?.live_seconds) ?? 1}s`,
  async execute(args, ctx): Promise<ToolResult> {
    const staged = await stageClip(ctx, "freeze_tail", args?.shot, args?.take);
    if (!staged.ok) return staged.res;
    const { page, clip, sid } = staged;

    const live = maybeNum(args?.live_seconds) ?? 1.0;
    if (live <= 0) return err("bad_live_seconds", { hint: "live_seconds must be greater than 0." });
    page.setLive(live);
    await ctx.trail.step({
      tool: "freeze_tail", title: `Keep the first ${live}s live`, anchor: ANCHORS.motionLive,
    });

    let job: string;
    try { ({ job } = await page.submitFreeze()); }
    catch (e) { return asError(e, "freeze_failed", "The freeze was rejected"); }
    await ctx.trail.step({
      tool: "freeze_tail", title: "❄ freeze tail", anchor: ANCHORS.motionFreeze, job,
    });

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try { settled = await deps.settleJobs([job], { settleMs: 8000, signal: ctx.signal, api: ctx.api }); }
    catch { /* queued regardless */ }
    const s0 = settled[0];
    const take = s0?.takes?.[0]?.path ?? null;
    try { await page.refresh(); } catch { /* fine */ }

    if (s0?.status === "error" || s0?.status === "failed") {
      return err("motion_edit_failed", {
        shot: sid, job, jobs: [job],
        hint: cut(s0.error, 160) || "The job failed — open Jobs for the log.",
      });
    }

    return ok(
      take ? `Froze ${sid} after ${live}s — ${cut(take.split("/").pop(), 40)}`
        : `Freeze queued for ${sid} (first ${live}s stay live)`,
      {
        shot: sid, job, jobs: [job], source: cut(clip, 60), live_seconds: live,
        status: s0?.status ?? "queued",
        take: take ? cut(take, 64) : null,
        selected: safeState(page).selected ? cut(safeState(page).selected!, 60) : null,
        ...(s0?.error ? { error_detail: cut(s0.error, 90) } : {}),
        ...(!take ? { hint: "Still rendering — call wait_for_jobs with this job id." } : {}),
      },
    );
  },
};

// ---------------------------------------------------------------- trim_clip

export const trimClip: ActionDef<TrimArgs> = {
  name: "trim_clip",
  title: "Trim a clip",
  description:
    "Cut a motion clip short, keeping only what happens before a given second. " +
    "Opens the shot's Motion edits tab, selects the clip and presses ✂ so the take " +
    "ends where the action ends — use it when a generated clip drifts or repeats " +
    "after the beat lands. Requires end_seconds. Unlike freeze_tail this shortens " +
    "the take rather than holding a pose. Returns the job and, when it finishes " +
    "fast, the trimmed take.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: "Which clip: a path, or \"newest motion\", \"latest\", \"plays\". Defaults to the selected clip." },
      end_seconds: { type: "number", description: "Keep everything before this second and drop the rest. Required." },
    },
    required: ["shot", "end_seconds"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "motion" },
    anchor: ANCHORS.motionTrim, label: "Shot Editor → Motion edits → ✂ trim",
  },
  keywords: ["trim", "cut short", "shorten", "keep only", "clip length", "end"],
  howTo:
    "Select a clip in the takes rail, open the Motion edits tab, set \"keep first (s)\" " +
    "and press ✂ keep only first Ns.",
  summarize: (a) => `Trim ${cut(a.shot, 24)} to ${maybeNum(a?.end_seconds) ?? "?"}s`,
  async execute(args, ctx): Promise<ToolResult> {
    const end = maybeNum(args?.end_seconds);
    if (end === undefined || end <= 0) {
      return err("needs_end_seconds", {
        hint: "Pass end_seconds — how many seconds of the clip to keep, e.g. 1.5.",
      });
    }
    const staged = await stageClip(ctx, "trim_clip", args?.shot, args?.take);
    if (!staged.ok) return staged.res;
    const { page, clip, sid } = staged;

    page.setLive(end);
    await ctx.trail.step({
      tool: "trim_clip", title: `Keep the first ${end}s`, anchor: ANCHORS.motionLive,
    });

    let job: string;
    try { ({ job } = await page.submitTrim(end)); }
    catch (e) { return asError(e, "trim_failed", "The trim was rejected"); }
    await ctx.trail.step({
      tool: "trim_clip", title: `✂ keep only first ${end}s`, anchor: ANCHORS.motionTrim, job,
    });

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try { settled = await deps.settleJobs([job], { settleMs: 8000, signal: ctx.signal, api: ctx.api }); }
    catch { /* queued regardless */ }
    const s0 = settled[0];
    const take = s0?.takes?.[0]?.path ?? null;
    try { await page.refresh(); } catch { /* fine */ }

    if (s0?.status === "error" || s0?.status === "failed") {
      return err("motion_edit_failed", {
        shot: sid, job, jobs: [job],
        hint: cut(s0.error, 160) || "The job failed — open Jobs for the log.",
      });
    }

    return ok(
      take ? `Trimmed ${sid} to ${end}s — ${cut(take.split("/").pop(), 40)}`
        : `Trim queued for ${sid} (keep the first ${end}s)`,
      {
        shot: sid, job, jobs: [job], source: cut(clip, 60), end_seconds: end,
        status: s0?.status ?? "queued",
        take: take ? cut(take, 64) : null,
        ...(s0?.error ? { error_detail: cut(s0.error, 90) } : {}),
        ...(!take ? { hint: "Still rendering — call wait_for_jobs with this job id." } : {}),
      },
    );
  },
};
