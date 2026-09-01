import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

// Stale-while-revalidate cache shared across mounts, so navigating away and
// back shows the last-known data instantly while it revalidates in the
// background — no "reload from scratch" when switching views.
const _pollCache = new Map<string, unknown>();

export function usePoll<T = any>(path: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(
    () => (path && _pollCache.has(path) ? (_pollCache.get(path) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
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
