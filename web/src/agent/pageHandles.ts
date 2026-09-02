/**
 * Page handles — the imperative surface pages hand the agent layer.
 *
 * A page calls `usePageHandles({ kind: "shot", ... })` on every render; the store keeps a
 * STABLE proxy that forwards to the latest render's closure, so `getState()` always sees live
 * React state and `submitGenerate()` always runs the current handler (the same function the
 * button calls). Tools call handles, never the DOM — inputs that commit on blur would be
 * missed by DOM driving.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.3.
 */
import { useEffect, useRef } from "react";
import type {
  AnyPageHandles, CompPageHandles, FilmPageHandles, PageHandles, ProjectsPageHandles,
  ScreenPageHandles, ShotPageHandles, TimelinePageHandles,
} from "./contract";

type Listener = (h: AnyPageHandles | null) => void;

/**
 * Mounted handles, in mount order. Usually one, but the cel workbench mounts INSIDE the
 * Shot Editor, so "shot" and "comp" are live at the same time. `current()` keeps meaning
 * "the page the human is on" (shot or film); sub-surfaces are asked for by kind.
 */
const mounted: AnyPageHandles[] = [];
const PAGE_KINDS = new Set(["shot", "film", "timeline"]);

const currentPage = (): AnyPageHandles | null => {
  for (let i = mounted.length - 1; i >= 0; i--) {
    if (PAGE_KINDS.has(mounted[i].kind)) return mounted[i];
  }
  return mounted[mounted.length - 1] ?? null;
};

const listeners = new Set<Listener>();

function emit() {
  const cur = currentPage();
  for (const l of [...listeners]) { try { l(cur); } catch { /* ignore */ } }
}

export function subscribeHandles(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function currentHandles(): AnyPageHandles | null { return currentPage(); }

/** Every handle mounted right now, in mount order (tests and get_context). */
export function mountedHandles(): AnyPageHandles[] { return [...mounted]; }

/** Test seam: install handles without React. Returns an un-installer. */
export function __setHandles(h: AnyPageHandles | null): () => void {
  const prev = mounted.splice(0, mounted.length);
  if (h) mounted.push(h);
  emit();
  return () => {
    mounted.splice(0, mounted.length, ...prev);
    emit();
  };
}

function matches(h: AnyPageHandles | null, kind: string, match?: Record<string, unknown>): boolean {
  if (!h || h.kind !== kind) return false;
  if (kind === "shot" && match && typeof match.sid === "string") {
    return String((h as ShotPageHandles).sid).toLowerCase() === match.sid.toLowerCase();
  }
  if (kind === "screen" && match && typeof match.rel === "string") {
    return String((h as ScreenPageHandles).rel) === match.rel;
  }
  if (kind === "comp" && match) {
    const c = h as CompPageHandles;
    if (typeof match.cid === "string" && String(c.cid) !== match.cid) return false;
    if (typeof match.sid === "string" &&
        String(c.sid ?? "").toLowerCase() !== match.sid.toLowerCase()) return false;
  }
  return true;
}

const findMounted = (kind: string, match?: Record<string, unknown>): AnyPageHandles | null =>
  [...mounted].reverse().find((h) => matches(h, kind, match)) ?? null;

/**
 * Resolve once a page of `kind` (and matching identity) has mounted.
 * Rejects after `timeoutMs` — `perform()` turns that into a clean error envelope.
 */
export type HandleKind = "shot" | "film" | "comp" | "projects" | "screen" | "timeline";

export function waitForHandles(
  kind: HandleKind,
  match?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<AnyPageHandles> {
  const hit = findMounted(kind, match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      fn();
    };
    const off = subscribeHandles(() => {
      const h = findMounted(kind, match);
      if (h) finish(() => resolve(h));
    });
    const timer = setTimeout(() => finish(() => reject(new Error(
      `page did not mount: ${kind}${match?.sid ? ` ${match.sid}` : ""}` +
      `${match?.cid ? ` ${match.cid}` : ""} (waited ${timeoutMs}ms)`))), timeoutMs);
  });
}

/** The `PageHandles` façade handed to every tool as `ctx.page`. */
export const pageHandles: PageHandles = {
  current: currentPage,
  waitFor: ((kind: HandleKind,
             match?: Record<string, unknown>, timeoutMs?: number) =>
    waitForHandles(kind, match, timeoutMs)) as PageHandles["waitFor"],
};

/**
 * Register this page's handles for as long as it is mounted.
 * Call it unconditionally with a fresh object literal each render — the ref keeps the
 * registered proxy stable while its behaviour tracks the latest render.
 */
export function usePageHandles(handles: ShotPageHandles): void;
export function usePageHandles(handles: FilmPageHandles): void;
export function usePageHandles(handles: CompPageHandles): void;
export function usePageHandles(handles: ProjectsPageHandles): void;
export function usePageHandles(handles: ScreenPageHandles): void;
export function usePageHandles(handles: TimelinePageHandles): void;
export function usePageHandles(handles: AnyPageHandles): void {
  const live = useRef(handles);
  live.current = handles;
  const proxy = useRef<AnyPageHandles | null>(null);
  if (!proxy.current) {
    proxy.current = new Proxy({} as AnyPageHandles, {
      get(_t, prop: string) {
        const v = (live.current as unknown as Record<string, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(live.current) : v;
      },
      has(_t, prop: string) { return prop in (live.current as object); },
      ownKeys() { return Reflect.ownKeys(live.current as object); },
      getOwnPropertyDescriptor(_t, prop) {
        return { ...Object.getOwnPropertyDescriptor(live.current as object, prop), configurable: true };
      },
    });
  }
  const kind = handles.kind;
  const identity = kind === "shot" ? (handles as ShotPageHandles).sid
    : kind === "comp" ? (handles as CompPageHandles).cid
    : kind === "screen" ? (handles as ScreenPageHandles).rel : "";
  useEffect(() => {
    const mine = proxy.current!;
    mounted.push(mine);
    emit();
    return () => {
      const at = mounted.indexOf(mine);
      if (at >= 0) mounted.splice(at, 1);
      emit();
    };
  }, [kind, identity]);
}
