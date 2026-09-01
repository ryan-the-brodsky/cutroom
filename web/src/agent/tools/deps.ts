/**
 * Runtime indirection for the two services workstream A owns (`jobs.ts`,
 * `guard.ts`) plus the registry listing used by `list_features` / `show_me`.
 *
 * Tools never import A's modules directly. They call `deps.settleJobs(...)`,
 * `deps.classifyBackend(...)`, `deps.allActions()`. The defaults here are real,
 * self-contained implementations over the public API, so the tool layer works
 * on its own; A replaces them at runtime with `installDeps({...})` (and
 * `tryAdoptRealDeps()` picks them up automatically when the modules exist).
 *
 * Owned by workstream C. See docs/WEBMCP-PLAN.md §6.C.
 */
import type { ActionDef } from "../contract";

// ---------------------------------------------------------------- shapes

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | string;

export interface SettledTake {
  path: string;
  kind: string;
  thumb?: string;
}

export interface SettledJob {
  job: string;
  status: JobStatus;
  result?: unknown;
  error?: string;
  takes?: SettledTake[];
}

export interface SettleOpts {
  settleMs?: number;
  signal?: AbortSignal;
  /** Only used by the fallback implementation; A's settleJobs ignores it. */
  api?: <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T>;
}

export type CostClass = "free" | "paid";

/**
 * Structurally compatible with workstream A's `guard.ts` BackendChoice, which
 * carries more fields and allows a null backend when no backend serves the lane.
 */
export interface BackendChoice {
  backend: string | null;
  model?: string | null;
  type?: string | null;
  lane?: string;
  cost_class: CostClass;
  cost_usd?: number;
  enabled?: boolean;
  source?: string;
  reason?: string;
}

export interface AgentDeps {
  settleJobs(ids: string[], opts?: SettleOpts): Promise<SettledJob[]>;
  classifyBackend(
    pid: string,
    lane: string,
    explicit?: string,
    api?: <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T>,
  ): Promise<BackendChoice>;
  /** The full registry, for list_features / show_me. */
  allActions(): ActionDef<never>[];
}

// ---------------------------------------------------------------- fallbacks

/** Backends that bill money. Mirrors §3.7 / Addendum A. */
const PAID = new Set([
  "fal", "replicate", "openai-images", "openai-image", "openrouter-image",
  "openrouter", "elevenlabs", "eleven-labs", "anthropic", "runway", "luma",
]);
/** Rough per-unit prices used when the backend has no `options.cost_usd`. */
const DEFAULT_COST: Record<string, number> = {
  fal: 0.2, replicate: 0.1, "openai-images": 0.04, "openrouter-image": 0.04,
  openrouter: 0.01, elevenlabs: 0.02, "eleven-labs": 0.02,
};

export function isPaidBackend(id: string, type?: string): boolean {
  const probe = `${id} ${type ?? ""}`.toLowerCase();
  if (/\bmock\b/.test(probe) || /comfy/.test(probe) || /local/.test(probe)) return false;
  for (const p of PAID) if (probe.includes(p)) return true;
  return false;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

const TERMINAL = new Set(["done", "error", "failed", "cancelled", "canceled"]);

/** Pull the take paths a finished job produced out of its result blob. */
export function takesFromResult(result: unknown): SettledTake[] {
  const out: SettledTake[] = [];
  const seen = new Set<string>();
  const push = (p: unknown, kind: string) => {
    if (typeof p !== "string" || !p || seen.has(p)) return;
    seen.add(p);
    out.push({ path: p, kind });
  };
  const r = (result ?? {}) as Record<string, unknown>;
  const kindOf = (p: string) => (/\.(mp4|webm|mov)$/i.test(p) ? "motion"
    : /\.(wav|mp3|m4a|flac|ogg)$/i.test(p) ? "audio" : "still");
  for (const t of (Array.isArray(r.takes) ? r.takes : [])) {
    if (typeof t === "string") push(t, kindOf(t));
    else if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      if (typeof o.path === "string") push(o.path, String(o.kind ?? kindOf(o.path)));
    }
  }
  for (const key of ["take", "composite", "output", "path", "clip", "animatic"]) {
    const v = r[key];
    if (typeof v === "string") push(v, kindOf(v));
  }
  return out.slice(0, 6);
}

/** Poll `GET /api/jobs/{id}` until every job is terminal or `settleMs` elapses. */
const fallbackSettleJobs: AgentDeps["settleJobs"] = async (ids, opts = {}) => {
  const unique = [...new Set(ids.filter(Boolean))];
  const state = new Map<string, SettledJob>(
    unique.map((j) => [j, { job: j, status: "queued" as JobStatus }]),
  );
  const call = opts.api;
  if (!call || unique.length === 0) return [...state.values()];
  const deadline = Date.now() + (opts.settleMs ?? 8000);
  let delay = 250;
  for (;;) {
    await Promise.all(unique.map(async (id) => {
      const cur = state.get(id)!;
      if (TERMINAL.has(cur.status)) return;
      try {
        const j = await call<Record<string, unknown>>(`/api/jobs/${id}`);
        const status = String(j.status ?? "running");
        const next: SettledJob = { job: id, status };
        if (j.error) next.error = String(j.error).slice(0, 200);
        if (TERMINAL.has(status)) {
          next.result = j.result;
          const takes = takesFromResult(j.result);
          if (takes.length) next.takes = takes;
        }
        state.set(id, next);
      } catch { /* keep the last known status */ }
    }));
    const done = [...state.values()].every((s) => TERMINAL.has(s.status));
    if (done || Date.now() >= deadline || opts.signal?.aborted) break;
    await sleep(Math.min(delay, Math.max(50, deadline - Date.now())), opts.signal);
    delay = Math.min(delay * 1.5, 1500);
  }
  return [...state.values()];
};

/** Resolve the backend a lane will actually use, and whether it costs money. */
const fallbackClassifyBackend: AgentDeps["classifyBackend"] =
  async (pid, lane, explicit, call) => {
    const unknown: BackendChoice = { backend: explicit || "default", cost_class: "free" };
    if (!call) return explicit ? { backend: explicit, cost_class: isPaidBackend(explicit) ? "paid" : "free" } : unknown;
    let chosen = explicit || "";
    let model: string | null = null;
    try {
      if (!chosen) {
        const lanes = await call<Record<string, { backend?: string; model?: string }>>(
          `/api/projects/${pid}/lanes`);
        const cfg = lanes?.[lane];
        if (cfg?.backend) { chosen = cfg.backend; model = cfg.model ?? null; }
      }
      const registry = await call<Record<string, { id: string; type: string; enabled: boolean }[]>>(
        "/api/lanes");
      const serving = registry?.[lane] || [];
      if (!chosen) chosen = (serving.find((b) => b.enabled) || serving[0])?.id || "";
      const info = serving.find((b) => b.id === chosen);
      if (!chosen) return unknown;
      const paid = isPaidBackend(chosen, info?.type);
      const out: BackendChoice = {
        backend: chosen, model, cost_class: paid ? "paid" : "free",
      };
      if (paid) out.cost_usd = DEFAULT_COST[chosen] ?? DEFAULT_COST[info?.type ?? ""] ?? 0.05;
      return out;
    } catch {
      if (!chosen) return unknown;
      const paid = isPaidBackend(chosen);
      return { backend: chosen, model, cost_class: paid ? "paid" : "free",
               ...(paid ? { cost_usd: DEFAULT_COST[chosen] ?? 0.05 } : {}) };
    }
  };

// ---------------------------------------------------------------- the object

export const deps: AgentDeps = {
  settleJobs: fallbackSettleJobs,
  classifyBackend: fallbackClassifyBackend,
  allActions: () => [],
};

/** A (or a test) swaps in real implementations. */
export function installDeps(patch: Partial<AgentDeps>): void {
  Object.assign(deps, patch);
}

/** Restore the self-contained defaults (tests). */
export function resetDeps(): void {
  deps.settleJobs = fallbackSettleJobs;
  deps.classifyBackend = fallbackClassifyBackend;
}

/**
 * Best-effort adoption of A's `../jobs` and `../guard` when they exist.
 * Uses `import.meta.glob`, which resolves to `{}` (never a build error) while
 * those files are still being written. Safe to call more than once.
 */
export async function tryAdoptRealDeps(): Promise<void> {
  const glob = (import.meta as unknown as { glob?: (p: string) => Record<string, () => Promise<unknown>> }).glob;
  if (typeof glob !== "function") return;
  const load = async (pattern: string): Promise<Record<string, unknown> | null> => {
    try {
      const mods = glob(pattern);
      const first = Object.values(mods)[0];
      return first ? ((await first()) as Record<string, unknown>) : null;
    } catch { return null; }
  };
  const [jobsMod, guardMod] = await Promise.all([load("../jobs.ts"), load("../guard.ts")]);
  if (typeof jobsMod?.settleJobs === "function") {
    deps.settleJobs = jobsMod.settleJobs as AgentDeps["settleJobs"];
  }
  if (typeof guardMod?.classifyBackend === "function") {
    deps.classifyBackend = guardMod.classifyBackend as AgentDeps["classifyBackend"];
  }
}
