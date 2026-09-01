/**
 * Cost & doctrine guard.
 *
 * The server's fallback is "first enabled backend serving the lane", so an agent that omits
 * `backend` can silently hit a paid API. Before any generation a tool resolves the EFFECTIVE
 * backend here and reports its cost class; paid work needs `confirm_cost: true`.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.7 and Addendum A.
 */
import { api } from "../api";
import type { BackendInfo } from "../types";

export type CostClass = "free" | "paid";

export interface BackendChoice {
  backend: string | null;
  model: string | null;
  type: string | null;
  lane: string;
  cost_class: CostClass;
  cost_usd?: number;
  enabled: boolean;
  source: "explicit" | "project_default" | "first_enabled" | "none";
  reason: string;
}

interface LaneBackend { id: string; label: string; type: string; enabled: boolean; pool?: string | null }
type LaneMap = Record<string, LaneBackend[]>;
type LaneDefaults = Record<string, { backend: string | null; model: string | null }>;

/** Backends that never cost money: the mock rig and anything local. */
const FREE_TYPES = new Set(["mock", "comfyui", "local-comfyui", "local", "ffmpeg"]);
const FREE_IDS = /^(mock|local|local-comfyui|comfyui)/i;

export function isFree(id: string | null, type: string | null): boolean {
  if (!id && !type) return true;
  if (type && FREE_TYPES.has(type)) return true;
  return Boolean(id && FREE_IDS.test(id));
}

// Small TTL cache: a generate tool asks three times in a row for one submission batch.
const TTL = 15_000;
const cache = new Map<string, { t: number; v: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v as Promise<T>;
  const v = load().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), v });
  return v;
}
export function clearGuardCache() { cache.clear(); }

const lanes = () => cached<LaneMap>("lanes", () => api<LaneMap>("/api/lanes"));
const projectLanes = (pid: string) =>
  cached<LaneDefaults>(`plane:${pid}`, () => api<LaneDefaults>(`/api/projects/${pid}/lanes`));
const backends = () => cached<BackendInfo[]>("backends", () => api<BackendInfo[]>("/api/backends"));

/**
 * Resolve which backend a lane will actually use, and what it costs.
 * Mirrors the server's own choice (`handlers.py` "first enabled backend serving the lane").
 */
export async function classifyBackend(pid: string | null, lane: string,
                                      explicit?: string | null): Promise<BackendChoice> {
  const base: BackendChoice = {
    backend: explicit || null, model: null, type: null, lane,
    cost_class: "free", enabled: true, source: explicit ? "explicit" : "none",
    reason: "",
  };
  let laneMap: LaneMap = {};
  let defaults: LaneDefaults = {};
  let all: BackendInfo[] = [];
  try { laneMap = await lanes(); } catch { /* offline: fall through */ }
  try { if (pid) defaults = await projectLanes(pid); } catch { /* none set */ }
  try { all = await backends(); } catch { /* none */ }

  const serving = laneMap[lane] || [];
  const projectDefault = defaults[lane]?.backend || null;
  let id = explicit || projectDefault || serving.find((b) => b.enabled)?.id || null;
  const source: BackendChoice["source"] = explicit ? "explicit"
    : projectDefault ? "project_default"
      : id ? "first_enabled" : "none";

  const info = all.find((b) => b.id === id) || null;
  const laneRow = serving.find((b) => b.id === id) || null;
  const type = info?.type ?? laneRow?.type ?? null;
  const enabled = info ? info.enabled : laneRow ? laneRow.enabled : false;
  const model = (explicit && explicit === projectDefault ? defaults[lane]?.model : null)
    ?? (!explicit ? defaults[lane]?.model ?? null : null);

  const free = isFree(id, type);
  const costRaw = info?.options?.cost_usd;
  const cost_usd = typeof costRaw === "number" ? costRaw
    : typeof costRaw === "string" && Number.isFinite(Number(costRaw)) ? Number(costRaw)
      : undefined;

  if (!id) id = null;
  const reason = !id
    ? `no backend is enabled for the "${lane}" lane`
    : source === "explicit" ? `you named ${id}`
      : source === "project_default" ? `${id} is this project's default for "${lane}"`
        : `${id} is the first enabled backend serving "${lane}"`;

  return {
    ...base,
    backend: id, model: model ?? null, type, lane,
    cost_class: free ? "free" : "paid",
    ...(cost_usd !== undefined ? { cost_usd } : {}),
    enabled, source,
    reason: enabled || !id ? reason : `${reason} — but it is disabled`,
  };
}

/** "3 stills on fal ≈ $0.60" — the sentence the needs-confirmation envelope carries. */
export function costSentence(choice: BackendChoice, count = 1, noun = "job"): string {
  const unit = choice.cost_usd;
  const plural = count === 1 ? noun : `${noun}s`;
  if (choice.cost_class === "free") {
    return `${count} ${plural} on ${choice.backend || "the default backend"} — free (${choice.type || "local"})`;
  }
  const total = unit !== undefined ? ` ≈ $${(unit * count).toFixed(2)}` : " (cost unknown)";
  return `${count} ${plural} on ${choice.backend}${total}`;
}

/**
 * The standard gate. Returns `null` when it is safe to proceed, or the error envelope
 * a tool should return verbatim.
 */
export async function requireConfirmation(
  pid: string | null, lane: string,
  opts: { explicit?: string | null; count?: number; confirm?: boolean; noun?: string } = {},
): Promise<{ choice: BackendChoice; block: Record<string, unknown> | null }> {
  const choice = await classifyBackend(pid, lane, opts.explicit ?? null);
  const count = opts.count ?? 1;
  if (!choice.backend) {
    return {
      choice,
      block: {
        ok: false, error: "no_backend",
        hint: `Enable a backend for the "${lane}" lane in Settings, or pass backend:"mock".`,
        lane,
      },
    };
  }
  if (choice.cost_class === "paid" && !opts.confirm) {
    return {
      choice,
      block: {
        ok: false, error: "needs_confirmation",
        backend: choice.backend, cost_class: choice.cost_class,
        ...(choice.cost_usd !== undefined ? { cost_usd: choice.cost_usd } : {}),
        summary: costSentence(choice, count, opts.noun || "job"),
        hint: "re-call with confirm_cost:true, or pass backend:\"mock\" to preview for free",
      },
    };
  }
  return { choice, block: null };
}
