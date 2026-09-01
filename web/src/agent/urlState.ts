/**
 * Query-param state sync — the prerequisite that makes deep links (and therefore agent
 * navigation) real. `/p/next-year/shot/B10-S2?tab=generate&sub=still` opens exactly that.
 *
 * The base for every write is `window.location.search`, not the hook's React state: the
 * router mutates history synchronously, so two patches in the same tick both survive.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.3.
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export type QueryPatch = Record<string, string | null | undefined>;

export function useQueryState(): [URLSearchParams, (patch: QueryPatch) => void] {
  const [params, setParams] = useSearchParams();
  const patch = useCallback((p: QueryPatch) => {
    setParams(() => {
      const next = new URLSearchParams(
        typeof window === "undefined" ? "" : window.location.search);
      for (const [k, v] of Object.entries(p)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setParams]);
  return [params, patch];
}

/** Read a query param, constrained to a known set of values. */
export function pick<T extends string>(params: URLSearchParams, key: string,
                                       allowed: readonly T[], fallback: T): T {
  const v = params.get(key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Build a path with query params, skipping empties. */
export function withQuery(path: string, q: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

/** Substitute `:pid` / `:sid` in a `Where.route`. Returns null if anything is still unbound. */
export function fillRoute(route: string, vals: Record<string, string | null | undefined>): string | null {
  const out = route.replace(/:([a-z_]+)/gi, (_m, k: string) => vals[k] ?? `:${k}`);
  return out.includes(":") ? null : out;
}
