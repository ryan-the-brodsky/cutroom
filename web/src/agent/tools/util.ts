/**
 * Shared helpers for the tool implementations (workstream C).
 * Routes, shot resolution, take pickers, compaction. No tool defs live here.
 */
import type {
  ActionContext, Candidate, GenSub, ResolvedShot, ShotPageHandles, ShotTab,
  TakeLite, ToolErr,
} from "../contract";
import { err } from "../contract";
import type { BackendChoice } from "./deps";
import { ROUTES, filmPath, shotPath } from "../../routes";

// ---------------------------------------------------------------- routes

export const SHOT_ROUTE = ROUTES.shot;
export const FILM_ROUTE = ROUTES.film;
export const JOBS_ROUTE = ROUTES.jobs;

const qs = (query?: Record<string, string | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const shotUrl = (pid: string, sid: string, query?: Record<string, string | undefined>) =>
  `${shotPath(pid, sid)}${qs(query)}`;

export const filmUrl = (pid: string, query?: Record<string, string | undefined>) =>
  `${filmPath(pid)}${qs(query)}`;

// ---------------------------------------------------------------- text

export const cut = (s: unknown, n: number): string => {
  const t = typeof s === "string" ? s.trim() : s == null ? "" : String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const basename = (p: string): string => p.split("/").pop() || p;

export const IS_CLIP = (p: string | null | undefined): boolean =>
  !!p && /\.(mp4|webm|mov)$/i.test(p);
export const IS_IMAGE = (p: string | null | undefined): boolean =>
  !!p && /\.(png|jpe?g|webp)$/i.test(p);
export const IS_AUDIO = (p: string | null | undefined): boolean =>
  !!p && /\.(wav|mp3|m4a|flac|ogg)$/i.test(p);

export const kindOf = (p: string): string =>
  IS_CLIP(p) ? "motion" : IS_AUDIO(p) ? "vo" : "still";

/** 1–4, tolerating "a few" / "a couple" / "three" / "3" the way a director talks. */
const WORD_COUNTS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, another: 1,
  couple: 2, "a couple": 2, pair: 2, two: 2, both: 2,
  few: 3, "a few": 3, three: 3, some: 3,
  several: 4, four: 4, bunch: 4, "a bunch": 4, more: 3, lots: 4, many: 4,
};

export function normalizeCount(raw: unknown, fallback = 3, max = 4): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.min(max, Math.round(raw)));
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    const n = Number(s);
    if (s !== "" && Number.isFinite(n)) return Math.max(1, Math.min(max, Math.round(n)));
    if (s in WORD_COUNTS) return Math.min(max, WORD_COUNTS[s]);
    for (const [word, v] of Object.entries(WORD_COUNTS)) {
      if (word.length > 2 && s.includes(word)) return Math.min(max, v);
    }
  }
  return fallback;
}

export function numOr(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function maybeNum(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

let seedCursor = 0;
/** Distinct, reproducible-ish seeds; `count` of them, never repeating. */
export function freshSeeds(count: number, given?: unknown): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const supplied = Array.isArray(given) ? given
    : typeof given === "string" ? given.split(/[,\s]+/).filter(Boolean) : [];
  for (const g of supplied) {
    const n = Number(g);
    if (Number.isFinite(n) && !seen.has(n)) { seen.add(n); out.push(n); }
    if (out.length >= count) return out;
  }
  while (out.length < count) {
    const n = (Math.floor(Math.random() * 2_000_000_000) + (seedCursor++)) % 2_147_483_647;
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// ---------------------------------------------------------------- shot resolution

export interface ShotHit { pid: string; shot: ResolvedShot }
export type ShotLookup = { ok: true; pid: string; shot: ResolvedShot } | { ok: false; res: ToolErr };

export const compactCandidate = (c: Candidate | ResolvedShot) => ({
  sid: c.sid,
  ordinal: c.ordinal,
  beat: c.beat,
  type: c.type,
  summary: cut(c.summary, 70),
  ...("why" in c && c.why ? { why: cut(c.why, 50) } : {}),
});

/**
 * The gate every mutating tool passes through: exact/high proceeds, ambiguous
 * returns candidates for the agent to ask about, none returns a hint.
 */
export async function lookupShot(ctx: ActionContext, query: unknown): Promise<ShotLookup> {
  const pid = ctx.project;
  if (!pid) {
    return { ok: false, res: err("no_project", {
      hint: "Open a project first, or call get_context to see where you are.",
    }) };
  }
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    return { ok: false, res: err("needs_shot", {
      hint: "Name the shot — a sid like B10-S2, its number in the film, or a description.",
    }) };
  }
  let r;
  try {
    r = await ctx.resolve.resolve(pid, q);
  } catch (e) {
    return { ok: false, res: err("resolve_failed", { hint: cut((e as Error)?.message, 140) }) };
  }
  if ((r.confidence === "exact" || r.confidence === "high") && r.best) {
    return { ok: true, pid, shot: r.best };
  }
  if (r.confidence === "ambiguous") {
    const candidates = (r.candidates || []).slice(0, 6).map(compactCandidate);
    return { ok: false, res: err("ambiguous_shot", {
      candidates,
      hint: `"${cut(q, 40)}" matches ${candidates.length} shots — ask the director which one, then re-call with that sid.`,
    }) };
  }
  return { ok: false, res: err("shot_not_found", {
    candidates: (r.candidates || []).slice(0, 4).map(compactCandidate),
    hint: `No shot matches "${cut(q, 40)}". Try find_shots, or a sid like B10-S2.`,
  }) };
}

// ---------------------------------------------------------------- shot detail (API)

export interface ShotDetail {
  sid: string; beat?: string; act?: number; type?: string; register?: string;
  seconds?: number; image_prompt?: string; negative?: string;
  motion_prompt?: string | null; radio?: string | null;
  dialogue?: { character: string; line: string }[];
  keeper?: string | null; active_source?: string | null;
  override?: Record<string, unknown>;
  stills?: string[]; i2i?: string[]; motion?: string[]; fx?: string[];
  crops?: string[]; vo?: string[];
  takes?: { path: string; kind: string; created_at?: number; seed?: number | null; meta?: Record<string, unknown> }[];
  comps?: { cid: string; layers: unknown[] }[];
}

export const fetchShot = (ctx: ActionContext, pid: string, sid: string) =>
  ctx.api<ShotDetail>(`/api/projects/${pid}/shots/${sid}`);

/** The plate a motion/comp job needs: the curated keeper, else the first still. */
export const plateOf = (shot: ShotDetail): string | null =>
  shot.keeper || shot.stills?.[0] || null;

// ---------------------------------------------------------------- take picking

export interface TakeRow { path: string; kind: string; created_at?: number }

/** Newest-first take rows for a shot, from the takes table (authoritative order). */
export async function listTakes(ctx: ActionContext, pid: string, sid: string): Promise<TakeRow[]> {
  try {
    const rows = await ctx.api<TakeRow[]>(
      `/api/projects/${pid}/takes?shot=${encodeURIComponent(sid)}&limit=60`);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch { /* fall through to the film entry */ }
  return [];
}

const STILL_KINDS = new Set(["still", "i2i", "crop"]);
const MOTION_KINDS = new Set(["motion", "fx", "chain", "comp", "panel"]);
const INTERMEDIATE_KINDS = new Set(["crop", "matte", "ref"]);   // never "the newest clip"

/**
 * Resolve `take` the way a director says it: a path, a filename, or one of
 * "latest" / "newest still" / "newest motion" / "keeper" / "plays".
 */
export async function pickTake(
  ctx: ActionContext, pid: string, shot: ShotDetail, want: unknown,
  opts: { prefer?: "clip" | "image"; selected?: string | null } = {},
): Promise<{ path: string; kind: string } | null> {
  const all = () => {
    const rows: TakeRow[] = [];
    const add = (paths: string[] | undefined, kind: string) =>
      (paths || []).forEach((p) => rows.push({ path: p, kind }));
    add(shot.motion, "motion"); add(shot.fx, "fx");
    add(shot.i2i, "i2i"); add(shot.stills, "still"); add(shot.crops, "crop");
    return rows;
  };
  const rows = (await listTakes(ctx, pid, shot.sid)).filter((r) => r.path);
  const pool = rows.length ? rows : all();
  const newest = (pred: (r: TakeRow) => boolean) => pool.find(pred) || null;

  const word = typeof want === "string" ? want.trim().toLowerCase() : "";

  if (word && !word.includes("/") && !word.includes(".")) {
    if (/keeper|plate|star/.test(word)) {
      return shot.keeper ? { path: shot.keeper, kind: "still" } : null;
    }
    if (/plays|playing|timeline|source|active/.test(word)) {
      return shot.active_source
        ? { path: shot.active_source, kind: kindOf(shot.active_source) } : null;
    }
    if (/motion|clip|animat|video|move/.test(word)) {
      const hit = newest((r) => !INTERMEDIATE_KINDS.has(r.kind) && (MOTION_KINDS.has(r.kind) || IS_CLIP(r.path)));
      return hit ? { path: hit.path, kind: hit.kind } : null;
    }
    if (/still|image|frame|plate|restyle|i2i/.test(word)) {
      const hit = newest((r) => STILL_KINDS.has(r.kind) || IS_IMAGE(r.path));
      return hit ? { path: hit.path, kind: hit.kind } : null;
    }
    if (/latest|newest|last|recent|this|it/.test(word)) {
      const hit = opts.prefer === "clip"
        ? newest((r) => IS_CLIP(r.path) && !INTERMEDIATE_KINDS.has(r.kind)) || pool[0]
        : opts.prefer === "image"
          ? newest((r) => IS_IMAGE(r.path)) || pool[0]
          : pool[0];
      return hit ? { path: hit.path, kind: hit.kind } : null;
    }
  }

  if (typeof want === "string" && want) {
    const exact = pool.find((r) => r.path === want);
    if (exact) return { path: exact.path, kind: exact.kind };
    const tail = pool.find((r) => basename(r.path) === basename(want));
    if (tail) return { path: tail.path, kind: tail.kind };
    // Unknown but path-shaped: let the server be the judge.
    if (want.includes("/") || want.includes(".")) return { path: want, kind: kindOf(want) };
    return null;
  }

  // No preference given: the current selection, then the sensible default.
  if (opts.selected) return { path: opts.selected, kind: kindOf(opts.selected) };
  if (opts.prefer === "clip") {
    const hit = newest((r) => IS_CLIP(r.path));
    return hit ? { path: hit.path, kind: hit.kind } : null;
  }
  if (opts.prefer === "image") {
    const hit = shot.keeper ? { path: shot.keeper, kind: "still" }
      : newest((r) => IS_IMAGE(r.path));
    return hit ? { path: hit.path, kind: hit.kind } : null;
  }
  const hit = shot.active_source ? { path: shot.active_source, kind: kindOf(shot.active_source) }
    : pool[0] ? { path: pool[0].path, kind: pool[0].kind } : null;
  return hit;
}

// ---------------------------------------------------------------- page arrival

/** Navigate to the shot editor and wait for its handles. Trail step included. */
export async function openShotPage(
  ctx: ActionContext, tool: string, pid: string, sid: string,
  query: { tab?: ShotTab; sub?: GenSub; take?: string; kind?: string } = {},
): Promise<{ ok: true; page: ShotPageHandles } | { ok: false; res: ToolErr }> {
  const url = shotUrl(pid, sid, query as Record<string, string | undefined>);
  try {
    await ctx.nav(url);
    const page = await ctx.page.waitFor("shot", { sid });
    await ctx.trail.step({ tool, title: `Open Shot Editor — ${sid}`, detail: url });
    return { ok: true, page };
  } catch (e) {
    return { ok: false, res: err("page_did_not_mount", {
      hint: `Could not open ${url}: ${cut((e as Error)?.message, 100)}. Try open_shot first.`,
    }) };
  }
}

/** Navigate to the film editor and wait for its handles. */
export async function openFilmPage(
  ctx: ActionContext, tool: string, pid: string,
  query: Record<string, string | undefined> = {},
) {
  const url = filmUrl(pid, query);
  try {
    await ctx.nav(url);
    const page = await ctx.page.waitFor("film");
    await ctx.trail.step({ tool, title: "Open Film Editor", detail: url });
    return { ok: true as const, page };
  } catch (e) {
    return { ok: false as const, res: err("page_did_not_mount", {
      hint: `Could not open ${url}: ${cut((e as Error)?.message, 100)}.`,
    }) };
  }
}

/** Read page state without throwing when a page hands back nothing useful. */
export function safeState(page: ShotPageHandles): {
  tab: ShotTab; sub: GenSub; selected: string | null;
  activeSource: string | null; keeper: string | null; takes: TakeLite[];
} {
  try {
    const s = page.getState();
    return {
      tab: s.tab, sub: s.sub, selected: s.selected ?? null,
      activeSource: s.activeSource ?? null, keeper: s.keeper ?? null,
      takes: s.takes || [],
    };
  } catch {
    return { tab: "compose", sub: "still", selected: null, activeSource: null,
             keeper: null, takes: [] };
  }
}

// ---------------------------------------------------------------- cost & doctrine guard

/**
 * §3.7: no backend, a disabled backend, or a paid backend without approval all
 * stop the tool BEFORE it moves the view. Returns null when it is safe to go.
 */
export function costGate(
  choice: BackendChoice, count: number, noun: string, confirmed: boolean,
): ToolErr | null {
  const id = choice.backend;
  if (!id) {
    return err("no_backend", {
      hint: choice.reason ||
        `No backend is enabled for the ${choice.lane ?? "requested"} lane — enable one in Settings, or pass backend:"mock".`,
    });
  }
  if (choice.enabled === false) {
    return err("backend_disabled", {
      backend: id,
      hint: choice.reason || `${id} is disabled — enable it in Settings, or name a different backend.`,
    });
  }
  if (choice.cost_class === "paid" && !confirmed) {
    const unit = choice.cost_usd;
    const total = unit !== undefined ? `≈ $${(unit * count).toFixed(2)}` : "an unknown amount";
    return err("needs_confirmation", {
      backend: id,
      cost_class: "paid",
      ...(unit !== undefined ? { cost_usd: unit } : {}),
      estimate: `${count} ${noun}${count === 1 ? "" : "s"} on ${id} ${total}`,
      hint: "re-call with confirm_cost:true",
    });
  }
  return null;
}

/** Turn any thrown thing into a descriptive error envelope. */
export const asError = (e: unknown, error: string, hint?: string): ToolErr => {
  const msg = cut((e as { message?: string })?.message ?? String(e), 220);
  return err(error, { hint: hint ? `${hint} (${msg})` : msg || undefined });
};
