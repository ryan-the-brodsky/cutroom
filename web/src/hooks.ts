import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

// Stale-while-revalidate cache shared across mounts, so navigating away and
// back shows the last-known data instantly while it revalidates in the
// background — no "reload from scratch" when switching views.
const _pollCache = new Map<string, unknown>();

// Every currently-mounted usePoll(path), so a mutation anywhere in the app
// can force an immediate refetch of a path another page is showing right
// now — see `invalidatePoll`. Keyed the same as the cache above.
const _pollBumpers = new Map<string, Set<() => void>>();

/**
 * Forget a cached path and, if any mounted `usePoll(path)` is showing it
 * right now, make it refetch immediately instead of waiting for its next
 * interval tick. For state that a WebMCP tool or a page's own UI can change
 * out from under a DIFFERENT page that is already on screen — e.g. a tool
 * setting the Timeline's source, keeper or a cue while a director is looking
 * at the Timeline in another tab: polling and a focus/visibility refetch
 * (below) will catch it soon regardless, but this closes the gap to "now"
 * for anything sharing the same page.
 */
export function invalidatePoll(path: string): void {
  _pollCache.delete(path);
  _pollBumpers.get(path)?.forEach((bump) => bump());
}

export interface UsePollOpts {
  /** Refetch the instant the tab/window regains focus or visibility — the
   *  case an interval alone answers only after a wait: a page left open for
   *  hours while another tab (or another agent) changed what it shows. */
  refetchOnFocus?: boolean;
}

export function usePoll<T = any>(
  path: string | null, intervalMs = 0, opts?: UsePollOpts,
) {
  const [data, setData] = useState<T | null>(
    () => (path && _pollCache.has(path) ? (_pollCache.get(path) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const refetchOnFocus = opts?.refetchOnFocus ?? false;

  // Register so `invalidatePoll(path)` can bump a mount that is showing this
  // path right now, from anywhere else in the app.
  useEffect(() => {
    if (!path) return;
    let bumpers = _pollBumpers.get(path);
    if (!bumpers) { bumpers = new Set(); _pollBumpers.set(path, bumpers); }
    bumpers.add(refresh);
    return () => {
      bumpers!.delete(refresh);
      if (!bumpers!.size) _pollBumpers.delete(path);
    };
  }, [path, refresh]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let timer: any;
    if (_pollCache.has(path)) setData(_pollCache.get(path) as T); // instant on remount
    const load = async () => {
      try {
        const d = await api<T>(path);
        if (alive) { _pollCache.set(path, d); setData(d); setError(null); }
      } catch (e: any) {
        if (alive) setError(e.message);
      }
      if (alive && intervalMs > 0) timer = setTimeout(load, intervalMs);
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [path, intervalMs, tick]);

  // A tab that has been open for a while — or just backgrounded a moment —
  // is exactly the case a fixed interval answers late. Catch up the instant
  // it is looked at again.
  useEffect(() => {
    if (!path || !refetchOnFocus) return;
    const onFocus = () => refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, refetchOnFocus, refresh]);

  return { data, error, refresh };
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<T>,
                                    onOk?: (v: T) => void) => {
    setBusy(true); setError(null);
    try {
      const v = await fn();
      onOk?.(v);
      return v;
    } catch (e: any) {
      setError(e.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

/** Watch a job over SSE until it finishes; fires onDone once. */
export function useJobWatch(jobId: string | null,
                            onDone: (ok: boolean, result: any) => void) {
  const cb = useRef(onDone);
  cb.current = onDone;
  useEffect(() => {
    if (!jobId) return;
    const ctrl = new AbortController();
    import("./api").then(({ sse }) =>
      sse(`/api/jobs/${jobId}/watch`, undefined, (ev) => {
        if (ev.kind === "status" &&
            ["done", "failed", "cancelled"].includes(ev.status || "")) {
          cb.current(ev.status === "done", ev.result);
          ctrl.abort();
        }
      }, ctrl.signal).catch(() => {}));
    return () => ctrl.abort();
  }, [jobId]);
}

/** True pixel dimensions of a project media file (plates are NOT 1080p). */
export function usePlateDims(pid: string, rel: string | null) {
  const [dims, setDims] = useState<[number, number] | null>(null);
  useEffect(() => {
    setDims(null);
    if (!rel) return;
    api(`/api/projects/${pid}/dims/${rel}`)
      .then((d: any) => setDims([d.width, d.height]))
      .catch(() => setDims([1920, 1080]));
  }, [pid, rel]);
  return dims;
}

/** Global toast for job submissions. */
type Toast = { text: string; job?: string };
const listeners: ((t: Toast) => void)[] = [];
export function pushToast(t: Toast) { listeners.forEach((l) => l(t)); }
export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<any>(null);
  useEffect(() => {
    const l = (t: Toast) => {
      setToast(t);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(null), 5000);
    };
    listeners.push(l);
    return () => { listeners.splice(listeners.indexOf(l), 1); };
  }, []);
  return toast;
}
