/**
 * cut_film — assemble the current state (keepers, overrides, timings, VO) into
 * a watchable animatic.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { deps } from "./deps";
import { FILM_ROUTE, asError, cut, openFilmPage } from "./util";

type Scope = "full" | "act1" | "act2" | "act3" | "act4";
type Res = "720" | "1080";

interface CutArgs { scope?: Scope; res?: Res }

const SCOPES: Scope[] = ["full", "act1", "act2", "act3", "act4"];
const RESES: Res[] = ["720", "1080"];

const scopeLabel = (s: Scope) => (s === "full" ? "the whole film" : `act ${s.slice(3)}`);

export const cutFilm: ActionDef<CutArgs> = {
  name: "cut_film",
  title: "Cut the film",
  description:
    "Assemble the film as it currently stands into a watchable cut: every shot's " +
    "chosen source, its duration, its voice-over and offsets, in film order. Sets " +
    "the scope (the whole film or a single act) and the resolution on the Film " +
    "Editor, then presses 🎞 cut the film. Use it after a run of picks or retimes " +
    "so the director can watch the change in context. 720 is the preview, 1080 the " +
    "final. Returns the job and, when it renders fast, the cut's path and duration.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: SCOPES, description: "What to assemble: the whole film, or one act. Default full." },
      res: { type: "string", enum: RESES, description: "Resolution: \"720\" for a preview (default) or \"1080\" for the final." },
    },
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmCut, label: "Film Editor → 🎞 cut the film" },
  keywords: ["cut", "assemble", "animatic", "render", "watch", "the film", "act", "preview", "export"],
  howTo:
    "In the Film Editor, choose the scope and resolution in the two dropdowns at the " +
    "top right, then press 🎞 cut the film — the result lands in the Cuts gallery at the bottom.",
  summarize: (a) => `Cut ${scopeLabel((a?.scope as Scope) || "full")} at ${a?.res || "720"}p`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first, then ask for the cut." });

    const scope: Scope = SCOPES.includes(args?.scope as Scope) ? (args!.scope as Scope) : "full";
    const res: Res = RESES.includes(String(args?.res) as Res) ? (String(args!.res) as Res) : "720";

    const opened = await openFilmPage(ctx, "cut_film", pid, { scope, res });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    page.setScope(scope);
    await ctx.trail.step({
      tool: "cut_film", title: `Scope: ${scopeLabel(scope)}`, anchor: ANCHORS.filmScope,
    });
    page.setRes(res);
    await ctx.trail.step({
      tool: "cut_film", title: `Resolution: ${res}p`, anchor: ANCHORS.filmRes,
    });

    let job: string;
    try { ({ job } = await page.cutFilm()); }
    catch (e) { return asError(e, "cut_failed", "The cut was rejected"); }
    await ctx.trail.step({
      tool: "cut_film", title: "🎞 cut the film", anchor: ANCHORS.filmCut, job,
    });

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try { settled = await deps.settleJobs([job], { settleMs: 8000, signal: ctx.signal, api: ctx.api }); }
    catch { /* queued regardless */ }
    const s0 = settled[0];
    const result = (s0?.result ?? {}) as Record<string, unknown>;
    const path = s0?.takes?.[0]?.path
      ?? (typeof result.animatic === "string" ? result.animatic : null)
      ?? (typeof result.path === "string" ? result.path : null);
    const meta = (result.meta ?? {}) as Record<string, unknown>;
    const duration = typeof result.total === "number" ? result.total
      : typeof meta.total === "number" ? meta.total : null;

    try { await page.refresh(); } catch { /* fine */ }

    if (s0?.status === "error" || s0?.status === "failed") {
      return err("cut_failed", {
        job, jobs: [job], hint: cut(s0.error, 200) || "The assemble job failed — open Jobs for the log.",
      });
    }

    return ok(
      path ? `Cut of ${scopeLabel(scope)} at ${res}p is ready — ${cut(path.split("/").pop(), 40)}`
        : `Cutting ${scopeLabel(scope)} at ${res}p…`,
      {
        job,
        jobs: [job],
        scope,
        res,
        status: s0?.status ?? "queued",
        animatic: path ? cut(path, 70) : null,
        ...(duration ? { seconds: Math.round(duration) } : {}),
        hint: path
          ? "It is in the Cuts gallery at the bottom of the Film Editor — click the thumbnail to play it."
          : "Assembling takes a moment — call wait_for_jobs with this job id, then look in the Cuts gallery.",
      },
    );
  },
};
