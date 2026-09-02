/**
 * get_jobs / wait_for_jobs — the async half of the product. Generation returns
 * job ids; these two close the loop without blocking a bridge past its timeout.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { deps, takesFromResult } from "./deps";
import { JOBS_ROUTE, cut } from "./util";

interface JobsArgs { jobs?: string[] }
interface WaitArgs { jobs: string[]; timeout_s?: number }

interface JobRow {
  id: string; type?: string; title?: string; status?: string;
  error?: string | null; result?: unknown; finished_at?: number | null;
}

const asIds = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return raw.map((x) => (x && typeof x === "object")
      ? String((x as Record<string, unknown>).job ?? (x as Record<string, unknown>).id ?? "")
      : String(x ?? "")).filter(Boolean).slice(0, 8);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(/[,\s]+/).filter(Boolean).slice(0, 8);
  }
  return [];
};

// ---------------------------------------------------------------- get_jobs

export const getJobs: ActionDef<JobsArgs> = {
  name: "get_jobs",
  title: "Check jobs",
  description:
    "Check on generation jobs without waiting: their status, what they produced " +
    "and, for anything that failed, the tail of the log with the reason. Pass the " +
    "job ids a generation tool returned, or call it with no arguments for the " +
    "project's most recent jobs. Use it when the director asks \"is it done yet?\" " +
    "or after a tool came back with jobs still running. Returns immediately — call " +
    "wait_for_jobs instead when you want to block until they finish.",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array", items: { type: "string" },
        description: "Job ids to check (up to 8). Omit for this project's most recent jobs.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: JOBS_ROUTE, anchor: ANCHORS.navJobs, label: "Jobs" },
  keywords: ["jobs", "status", "done", "running", "queue", "failed", "progress", "log"],
  howTo: "Open Jobs in the sidebar — every job shows its status, and clicking one opens its log.",
  summarize: (a) => (a?.jobs?.length ? `Check ${a.jobs.length} job(s)` : "Check recent jobs"),
  async execute(args, ctx): Promise<ToolResult> {
    const ids = asIds(args?.jobs);
    let rows: JobRow[] = [];
    try {
      if (ids.length) {
        rows = await Promise.all(ids.map(async (id) => {
          try { return await ctx.api<JobRow>(`/api/jobs/${id}`); }
          catch { return { id, status: "unknown" }; }
        }));
      } else {
        const q = ctx.project ? `?project=${encodeURIComponent(ctx.project)}&limit=8` : "?limit=8";
        rows = (await ctx.api<JobRow[]>(`/api/jobs${q}`)).slice(0, 8);
      }
    } catch (e) {
      return err("jobs_unavailable", { hint: cut((e as Error)?.message, 140) });
    }

    const out = await Promise.all(rows.map(async (j) => {
      const takes = takesFromResult(j.result).slice(0, 2).map((t) => cut(t.path, 56));
      const row: Record<string, unknown> = {
        job: j.id, type: j.type, status: j.status, title: cut(j.title, 40),
      };
      if (takes.length) row.takes = takes;
      if (j.status === "error" || j.status === "failed") {
        row.error = cut(j.error, 120);
        try {
          const log = await ctx.api<{ lines: string[] }>(`/api/jobs/${j.id}/log?tail=4`);
          const tail = (log?.lines || []).slice(-2).map((l) => cut(l, 80));
          if (tail.length) row.log = tail;
        } catch { /* the error message is enough */ }
      }
      return row;
    }));

    const running = out.filter((r) => r.status === "running" || r.status === "queued").length;
    const done = out.filter((r) => r.status === "done").length;
    const failed = out.filter((r) => r.status === "error" || r.status === "failed").length;
    return ok(
      `${out.length} job${out.length === 1 ? "" : "s"} — ${done} done, ${running} running, ${failed} failed`,
      {
        jobs: out,
        ...(running
          ? { hint: "Call wait_for_jobs with the running ids to block until they land." }
          : {}),
      },
    );
  },
};

// ---------------------------------------------------------------- wait_for_jobs

export const waitForJobs: ActionDef<WaitArgs> = {
  name: "wait_for_jobs",
  title: "Wait for jobs",
  description:
    "Wait for generation jobs to finish, up to 60 seconds, then report what landed. " +
    "Progress stays visible in the topbar and the Jobs page while you wait. Use it " +
    "after a generation tool returns jobs that are still running, so the next thing " +
    "you say to the director is the actual result rather than a promise. Anything " +
    "still running when the timeout expires comes back as \"running\" — call again " +
    "or check with get_jobs. Returns each job's status and the takes it produced.",
  inputSchema: {
    type: "object",
    properties: {
      jobs: { type: "array", description: "The job ids to wait for (up to 8), as returned by a generation tool (ids, or the job objects a previous wait returned)." },
      timeout_s: { type: "integer", minimum: 1, maximum: 60, default: 30, description: "How long to wait, in seconds. Capped at 60." },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: JOBS_ROUTE, anchor: ANCHORS.navJobs, label: "Jobs" },
  keywords: ["wait", "block", "finish", "settle", "until done", "poll", "jobs"],
  howTo: "Watch the job chip in the topbar, or open Jobs in the sidebar and watch the row turn green.",
  summarize: (a) => `Wait for ${a?.jobs?.length ?? 0} job(s)`,
  async execute(args, ctx): Promise<ToolResult> {
    const ids = asIds(args?.jobs);
    if (!ids.length) {
      return err("needs_jobs", { hint: "Pass the job ids a generation tool returned." });
    }
    const timeout = Math.max(1, Math.min(60, Number(args?.timeout_s) || 30));

    let settled: Awaited<ReturnType<typeof deps.settleJobs>>;
    try {
      settled = await deps.settleJobs(ids, {
        settleMs: timeout * 1000, signal: ctx.signal, api: ctx.api,
      });
    } catch (e) {
      return err("wait_failed", { hint: cut((e as Error)?.message, 140) });
    }

    const rows = settled.map((s) => ({
      job: s.job,
      status: s.status,
      ...(s.takes?.length ? { takes: s.takes.slice(0, 2).map((t) => cut(t.path, 56)) } : {}),
      ...(s.error ? { error: cut(s.error, 100) } : {}),
    }));
    const done = rows.filter((r) => r.status === "done").length;
    const failed = rows.filter((r) => r.status === "error" || r.status === "failed").length;
    const running = rows.length - done - failed;
    const takes = settled.flatMap((s) => s.takes || []).slice(0, 6)
      .map((t) => cut(t.path, 56));

    return ok(
      `${done} of ${rows.length} finished` + (failed ? `, ${failed} failed` : "") +
      (running ? `, ${running} still running after ${timeout}s` : ""),
      {
        jobs: rows,
        takes,
        ...(running
          ? { hint: "Still going — call wait_for_jobs again, or get_jobs for the log." }
          : {}),
      },
    );
  },
};
