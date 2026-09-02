/**
 * The ActionContext every tool receives.
 *
 * `nav()` is the important one: it navigates the real router and does not resolve until the
 * target route's page handles have registered, so a tool can set a tab the instant it returns.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.1.
 */
import { api as rawApi } from "../api";
import type { FilmEntry } from "../types";
import type {
  ActionContext, Confidence, Resolution, ResolvedShot, ShotResolver, Speed,
} from "./contract";
import { pageHandles, waitForHandles } from "./pageHandles";
import { getSpeed, trail } from "./presence";

export interface RouterLike { navigate(to: string, opts?: { replace?: boolean }): unknown }

let router: RouterLike | null = null;
export function setRouter(r: RouterLike | null) { router = r; }

// ------------------------------------------------------------------ project

const LAST_PID = "cutroom_last_pid";

/** The :pid in the URL, else the last project the human opened. */
export function currentProject(): string | null {
  try {
    const m = window.location.pathname.match(/^\/p\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
    return localStorage.getItem(LAST_PID) || null;
  } catch { return null; }
}

// ------------------------------------------------------------------ resolver injection

/**
 * Workstream B owns `resolve.ts`. Until it lands (or if its import fails) a minimal
 * sid/ordinal/beat resolver keeps `open_shot` and the palette working.
 */
let resolver: ShotResolver | null = null;
export function setResolver(r: ShotResolver | null) { resolver = r; }
export function getResolver(): ShotResolver { return resolver ?? fallbackResolver; }

const filmCache = new Map<string, Promise<FilmEntry[]>>();
function film(pid: string, force = false): Promise<FilmEntry[]> {
  if (force) filmCache.delete(pid);
  let p = filmCache.get(pid);
  if (!p) {
    p = rawApi<FilmEntry[]>(`/api/projects/${pid}/film`)
      .catch((e) => { filmCache.delete(pid); throw e; });
    filmCache.set(pid, p);
  }
  return p;
}

function lite(s: FilmEntry, i: number): ResolvedShot {
  return {
    sid: s.sid, ordinal: i + 1, beat: s.beat, act: s.act ?? null, type: s.type,
    seconds: s.seconds ?? null,
    summary: (s.image_prompt || "").slice(0, 90),
    characters: (s.dialogue || []).map((d) => d.character).filter(Boolean),
    has_keeper: Boolean(s.keeper),
    has_motion: (s.motion?.length || 0) > 0 || (s.fx?.length || 0) > 0,
    plays: s.active_source ?? null,
  };
}

export const fallbackResolver: ShotResolver = {
  async index(pid, opts) { return (await film(pid, opts?.force)).map(lite); },
  async resolve(pid, query) {
    const shots = await this.index(pid);
    const q = String(query || "").trim();
    const none: Resolution = { best: null, candidates: [], confidence: "none" };
    if (!q) return none;
    const norm = q.toLowerCase().replace(/\s+/g, "-");
    const exact = shots.find((s) => s.sid.toLowerCase() === norm);
    if (exact) return { best: exact, candidates: [{ ...exact, score: 1, why: "exact sid" }], confidence: "exact" };
    const ord = q.match(/^#?(?:shot\s*)?(\d{1,3})$/i);
    if (ord) {
      const hit = shots[Number(ord[1]) - 1];
      if (hit) return { best: hit, candidates: [{ ...hit, score: 1, why: `#${ord[1]} in film order` }], confidence: "high" };
    }
    const beat = q.match(/^(?:beat\s*)?(b\d{1,2})$/i);
    const pool = beat
      ? shots.filter((s) => s.beat?.toLowerCase() === beat[1].toLowerCase())
      : shots.filter((s) => `${s.sid} ${s.summary} ${s.type}`.toLowerCase().includes(q.toLowerCase()));
    if (!pool.length) return none;
    const candidates = pool.slice(0, 8).map((s) => ({ ...s, score: 0.5, why: "text match" }));
    const confidence: Confidence = pool.length === 1 ? "high" : "ambiguous";
    return { best: pool[0], candidates, confidence };
  },
};

// ------------------------------------------------------------------ navigation

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SHOT_ROUTE = /^\/p\/([^/?#]+)\/shot\/([^/?#]+)/;
const FILM_ROUTE = /^\/p\/([^/?#]+)\/?(?:[?#]|$)/;

/**
 * Navigate and wait for the destination to be usable.
 * Routes with page handles resolve when those handles register; everything else gets 300 ms.
 */
export async function navigateTo(to: string): Promise<void> {
  const path = to.split(/[?#]/)[0];
  const already = typeof window !== "undefined" &&
    window.location.pathname + window.location.search === to;
  if (router) router.navigate(to);
  else if (typeof window !== "undefined") window.history.pushState({}, "", to);

  const shot = path.match(SHOT_ROUTE);
  if (shot) {
    await waitForHandles("shot", { sid: decodeURIComponent(shot[2]) }, 5000);
    await sleep(0);
    return;
  }
  if (FILM_ROUTE.test(path)) {
    await waitForHandles("film", undefined, 5000);
    await sleep(0);
    return;
  }
  if (path === "/" || path === "") {
    // The Projects page registers handles too, so create_project can press the
    // real create button. Falling back to a beat keeps older routes working.
    try {
      await waitForHandles("projects", undefined, 3000);
      await sleep(0);
      return;
    } catch { /* no handles there: treat it like any other route */ }
  }
  await sleep(already ? 0 : 300);
}

// ------------------------------------------------------------------ the context

export interface MakeContextOpts {
  signal?: AbortSignal;
  resolver?: ShotResolver;
  router?: RouterLike | null;
  speed?: Speed;
}

let shared: ActionContext | null = null;

/**
 * The one context the whole app shares (bridge, palette, debug hook).
 * Built lazily so the palette works even if `installAgentLayer` has not run yet.
 */
export function agentContext(): ActionContext {
  return shared ?? makeContext();
}

/** Build the shared ActionContext. Live values (project, speed) are getters. */
export function makeContext(opts: MakeContextOpts = {}): ActionContext {
  if (opts.router !== undefined) setRouter(opts.router);
  if (opts.resolver) setResolver(opts.resolver);
  const signal = opts.signal ?? new AbortController().signal;
  const ctx: ActionContext = {
    signal,
    get project() { return currentProject(); },
    nav: navigateTo,
    page: pageHandles,
    api: <T = unknown>(path: string, body?: unknown, method?: string) =>
      rawApi<T>(path, body, method),
    get resolve() { return getResolver(); },
    trail,
    get speed() { return opts.speed ?? getSpeed(); },
  } as ActionContext;
  shared = ctx;
  return ctx;
}
