/**
 * Async is the product: generation returns a job, not a result.
 *
 * `settleJobs` waits a bounded window on the existing SSE `GET /api/jobs/{id}/watch` so the
 * mock backend (<1 s) closes the loop inside one agent turn, while a GPU job returns
 * `status:"running"` plus the hint to call `wait_for_jobs`.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.6.
 */
import { api, sse } from "../api";
import type { Job } from "../types";

/** Matches workstream C's `SettledTake` so `tools/deps.ts` can adopt this module as-is. */
export interface SettledTake { path: string; kind: string; thumb?: string }

export interface JobSettle {
  job: string;
  status: "done" | "failed" | "cancelled" | "running" | "queued" | "unknown";
  result?: Record<string, unknown>;
  error?: string;
  takes?: SettledTake[];
  title?: string;
}

export interface SettleOpts { settleMs?: number; signal?: AbortSignal }

const kindOf = (p: string) => (/\.(mp4|webm|mov)$/i.test(p) ? "motion"
  : /\.(wav|mp3|m4a|flac|ogg)$/i.test(p) ? "audio" : "still");

/** Pull every take a job result might carry, newest-first order preserved. */
export function takesOf(result: unknown): SettledTake[] {
  const r = (result || {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const out: SettledTake[] = [];
  const push = (v: unknown, kind?: string) => {
    if (typeof v === "string" && v && !seen.has(v)) {
      seen.add(v);
      out.push({ path: v, kind: kind || kindOf(v) });
    } else if (Array.isArray(v)) v.forEach((x) => push(x, kind));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.path === "string") push(o.path, typeof o.kind === "string" ? o.kind : undefined);
    }
  };
  push(r.takes); push(r.take); push(r.composite); push(r.path); push(r.output);
  push(r.clip); push(r.animatic);
  return out.slice(0, 6);
}

const FINAL = new Set(["done", "failed", "error", "cancelled", "canceled"]);

/** Watch one job over SSE until it finishes or the window closes. */
function watchOne(id: string, settleMs: number, signal?: AbortSignal): Promise<JobSettle> {
  return new Promise<JobSettle>((resolve) => {
    const ctrl = new AbortController();
    let settled = false;
    const finish = (s: JobSettle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ctrl.abort(); } catch { /* ignore */ }
      resolve(s);
    };
    const timer = setTimeout(() => {
      // Beyond the window: report what the API knows and hand back a hint.
      api<Job>(`/api/jobs/${id}`)
        .then((j) => finish({
          job: id,
          status: (j?.status as JobSettle["status"]) || "running",
          title: j?.title,
          result: j?.result,
          takes: takesOf(j?.result),
        }))
        .catch(() => finish({ job: id, status: "running" }));
    }, settleMs);
    if (signal) {
      signal.addEventListener("abort",
        () => finish({ job: id, status: "running", error: "aborted" }), { once: true });
    }
    sse(`/api/jobs/${id}/watch`, undefined, (ev) => {
      if (ev.kind === "status" && FINAL.has(ev.status || "")) {
        finish({
          job: id,
          status: ev.status as JobSettle["status"],
          result: ev.result,
          error: ev.error,
          takes: takesOf(ev.result),
        });
      }
    }, ctrl.signal).catch(() => {
      if (settled) return;
      // SSE unavailable (proxy, CI): fall back to a single status read.
      api<Job>(`/api/jobs/${id}`)
        .then((j) => finish({
          job: id, status: (j?.status as JobSettle["status"]) || "unknown",
          result: j?.result, takes: takesOf(j?.result), title: j?.title,
        }))
        .catch(() => finish({ job: id, status: "unknown" }));
    });
  });
}

/**
 * Wait up to `settleMs` (default 8 s) for a batch of jobs.
 * Always resolves — a still-running job comes back as `status:"running"`.
 */
export async function settleJobs(ids: string[], opts: SettleOpts = {}): Promise<JobSettle[]> {
  const settleMs = Math.max(0, opts.settleMs ?? 8000);
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return [];
  return Promise.all(wanted.map((id) => watchOne(id, settleMs, opts.signal)));
}

/** True when every job in the batch reached a terminal state. */
export const allSettled = (rows: JobSettle[]) => rows.every((r) => FINAL.has(r.status));

/** A ≤1.5K-friendly one-liner for a settle batch. */
export function settleSummary(rows: JobSettle[]): string {
  const by: Record<string, number> = {};
  rows.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
  return Object.entries(by).map(([k, n]) => `${n} ${k}`).join(", ") || "no jobs";
}
