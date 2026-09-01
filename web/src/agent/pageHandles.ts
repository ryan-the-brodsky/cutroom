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
  AnyPageHandles, FilmPageHandles, PageHandles, ShotPageHandles,
} from "./contract";

type Listener = (h: AnyPageHandles | null) => void;

let current: AnyPageHandles | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of [...listeners]) { try { l(current); } catch { /* ignore */ } }
}

export function subscribeHandles(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function currentHandles(): AnyPageHandles | null { return current; }

/** Test seam: install handles without React. Returns an un-installer. */
export function __setHandles(h: AnyPageHandles | null): () => void {
  const prev = current;
  current = h;
  emit();
  return () => { if (current === h) { current = prev; emit(); } };
}

function matches(h: AnyPageHandles | null, kind: string, match?: Record<string, unknown>): boolean {
  if (!h || h.kind !== kind) return false;
  if (kind === "shot" && match && typeof match.sid === "string") {
    return String((h as ShotPageHandles).sid).toLowerCase() === match.sid.toLowerCase();
  }
  return true;
}

/**
 * Resolve once a page of `kind` (and matching identity) has mounted.
 * Rejects after `timeoutMs` — `perform()` turns that into a clean error envelope.
 */
export function waitForHandles(
  kind: "shot" | "film",
  match?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<AnyPageHandles> {
  if (matches(current, kind, match)) return Promise.resolve(current as AnyPageHandles);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      fn();
    };
    const off = subscribeHandles((h) => {
      if (matches(h, kind, match)) finish(() => resolve(h as AnyPageHandles));
    });
    const timer = setTimeout(() => finish(() => reject(new Error(
      `page did not mount: ${kind}${match?.sid ? ` ${match.sid}` : ""} ` +
      `(waited ${timeoutMs}ms)`))), timeoutMs);
  });
}

/** The `PageHandles` façade handed to every tool as `ctx.page`. */
export const pageHandles: PageHandles = {
  current: () => current,
  waitFor: ((kind: "shot" | "film", match?: Record<string, unknown>, timeoutMs?: number) =>
    waitForHandles(kind, match, timeoutMs)) as PageHandles["waitFor"],
};

/**
 * Register this page's handles for as long as it is mounted.
 * Call it unconditionally with a fresh object literal each render — the ref keeps the
 * registered proxy stable while its behaviour tracks the latest render.
 */
export function usePageHandles(handles: ShotPageHandles): void;
export function usePageHandles(handles: FilmPageHandles): void;
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
  const identity = kind === "shot" ? (handles as ShotPageHandles).sid : "";
  useEffect(() => {
    const mine = proxy.current!;
    current = mine;
    emit();
    return () => { if (current === mine) { current = null; emit(); } };
  }, [kind, identity]);
}
