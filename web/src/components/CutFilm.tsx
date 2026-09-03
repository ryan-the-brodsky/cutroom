/**
 * CUT THE FILM — one button, one job, and the job made visible.
 *
 * Cutting the film is a DB-backed job, not a local render: POST
 * `/api/projects/{pid}/animatic` returns `{job}`, a worker assembles the shots
 * with ffmpeg, and a Take of kind "animatic" lands when it finishes. Before this
 * component the button fired that POST and said nothing, so a cut that took
 * thirty seconds — or died on "No space left on device" — looked exactly like a
 * dead button. Everything here exists to close that gap: queued → cutting 0:42 →
 * cut ready · open, or a red line with ffmpeg's own last word and the log.
 *
 * `useCutFilm` owns the whole round trip, and it is the SAME path the WebMCP
 * `cut_film` tool takes: the Film Editor registers `start` as its `cutFilm()`
 * page handle, so an agent-driven cut lights this status up exactly like a human
 * click does.
 *
 * The job id is remembered per project in localStorage, so a reload mid-cut
 * picks the poll back up instead of losing the film.
 *
 * `FilmStaleness` is the other half of "cut to see it": the Timeline's live
 * preview is the film as it stands RIGHT NOW; this button is what freezes
 * that into a file. `GET .../film/status` says whether the two have drifted
 * apart, and this renders it as a small "changes since the last cut · N"
 * next to the button — on both the Timeline and the Film Editor, since both
 * render `<CutFilm>`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { appPath } from "../routes";
import * as screen from "../screen/store";
import type { Job } from "../types";

export interface FilmStatus {
  last_cut_at: number | null;
  last_change_at: number | null;
  stale: boolean;
  changes: string[];
  changes_count: number;
}

/** What the assemble endpoint accepts: the whole film, or one act. */
export const CUT_SCOPES = ["full", "act1", "act2", "act3", "act4"] as const;
export type CutScope = (typeof CUT_SCOPES)[number];
export type CutRes = "720" | "1080";

export interface CutParams { scope?: string; res?: string }
export interface CutResult { path: string; seconds: number | null }

export type CutPhase = "idle" | "queued" | "running" | "done" | "failed" | "cancelled";

export interface CutFilmState {
  pid: string;
  phase: CutPhase;
  job: string | null;
  /** Seconds this cut has been away — the "cutting… 0:42" readout. */
  elapsed: number;
  submitting: boolean;
  /** The submit itself was rejected (422 no shots, 401, offline…). */
  error: string | null;
  /** The last meaningful line of a failed job's log. */
  failLine: string | null;
  log: string[];
  logOpen: boolean;
  cut: CutResult | null;
  start(over?: CutParams): Promise<{ job: string }>;
  /** Put the finished cut on the big screen (the same room the Cuts gallery uses). */
  openCut(): void;
  toggleLog(): void;
  dismiss(): void;
}

const POLL_MS = 2000;
/** Older than this and a remembered job is history, not status. */
const REMEMBER_MS = 30 * 60 * 1000;
const storeKey = (pid: string) => `cutroom_cut_job:${pid}`;
const isLive = (p: CutPhase) => p === "queued" || p === "running";

/** mm:ss, the way every other readout in the studio prints time. */
export const mmss = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${
    String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

/**
 * The one line a director needs off a failed cut. ffmpeg's real complaint is at
 * the very end of the log ("No space left on device"), under a pile of repeats;
 * a job that died before ffmpeg ran has only `error`.
 */
export function failureLine(lines: string[], error?: string | null): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] || "").trim();
    if (!l || /^last message repeated/i.test(l)) continue;
    return l;
  }
  const parts = String(error || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** The take path a finished assemble job names (`take` today; older shapes too). */
function takeOf(result: Record<string, unknown> | null | undefined): string | null {
  const r = result || {};
  for (const k of ["take", "animatic", "path"]) {
    const v = r[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export function useCutFilm(opts: {
  pid: string;
  /** Read fresh on every submit, so the selects beside the button always win. */
  params?: CutParams;
  /** Fired once when the job settles — refresh the Cuts gallery here. */
  onDone?: (ok: boolean, job: Job | null) => void;
  /** Poll interval; the default is the only one the app uses (tests shorten it). */
  pollMs?: number;
}): CutFilmState {
  const { pid, pollMs = POLL_MS } = opts;
  const paramsRef = useRef<CutParams>(opts.params || {});
  paramsRef.current = opts.params || {};
  const onDoneRef = useRef(opts.onDone);
  onDoneRef.current = opts.onDone;

  const [job, setJob] = useState<string | null>(null);
  const [phase, setPhase] = useState<CutPhase>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failLine, setFailLine] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [cut, setCut] = useState<CutResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** Browser-clock ms, so the readout never depends on server/browser skew. */
  const startedAt = useRef<number | null>(null);
  const logOpenRef = useRef(false);
  logOpenRef.current = logOpen;

  const forget = useCallback(() => {
    try { localStorage.removeItem(storeKey(pid)); } catch { /* private mode */ }
  }, [pid]);
  const remember = useCallback((id: string) => {
    try {
      localStorage.setItem(storeKey(pid),
                           JSON.stringify({ job: id, at: Date.now() }));
    } catch { /* private mode */ }
  }, [pid]);

  // Pick a cut back up across a reload (and reset cleanly when the project changes).
  useEffect(() => {
    setJob(null); setPhase("idle"); setCut(null); setFailLine(null);
    setLog([]); setLogOpen(false); setError(null); setElapsed(0);
    startedAt.current = null;
    let raw: string | null = null;
    try { raw = localStorage.getItem(storeKey(pid)); } catch { /* ignore */ }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { job?: string; at?: number };
      if (!saved?.job || Date.now() - (saved.at || 0) > REMEMBER_MS) {
        forget();
        return;
      }
      startedAt.current = saved.at || Date.now();
      setJob(saved.job);
      setPhase("queued");
    } catch { forget(); }
  }, [pid, forget]);

  // The poll. GET /api/jobs/{id} every couple of seconds until it settles —
  // plainer than the SSE watch and it survives a reload, a sleeping laptop and
  // a proxy that buffers event streams.
  useEffect(() => {
    if (!job) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const readLog = async (): Promise<string[]> => {
      try {
        const d = await api<{ lines: string[] }>(`/api/jobs/${job}/log?tail=200`);
        const lines = d.lines || [];
        if (alive) setLog(lines);
        return lines;
      } catch { return []; }
    };

    const tick = async () => {
      let j: Job;
      try {
        j = await api<Job>(`/api/jobs/${job}`);
      } catch {
        // A job the server no longer knows is not a cut in flight. Stop rather
        // than poll a 404 forever.
        if (alive) { setPhase("idle"); setJob(null); forget(); }
        return;
      }
      if (!alive) return;
      if (startedAt.current == null) {
        const at = j.started_at || j.created_at || 0;
        startedAt.current = at ? at * 1000 : Date.now();
      }
      const settled = j.started_at && j.finished_at
        ? j.finished_at - j.started_at : null;
      const status = String(j.status || "");

      if (status === "done") {
        const path = takeOf(j.result);
        const total = (j.result || {}).total;
        setCut(path ? { path, seconds: typeof total === "number" ? total : null }
                    : null);
        if (settled != null) setElapsed(settled);
        setPhase("done");
        if (logOpenRef.current) void readLog();
        onDoneRef.current?.(true, j);
        return;                                   // settled: stop polling
      }
      if (status === "failed" || status === "error" || status === "cancelled") {
        const lines = await readLog();
        if (!alive) return;
        setFailLine(failureLine(lines, j.error));
        if (settled != null) setElapsed(settled);
        setPhase(status === "cancelled" ? "cancelled" : "failed");
        onDoneRef.current?.(false, j);
        return;
      }
      setPhase(status === "running" ? "running" : "queued");
      if (logOpenRef.current) void readLog();
      timer = setTimeout(tick, pollMs);
    };

    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [job, forget, pollMs]);

  // Elapsed ticks once a second so the readout moves between polls.
  useEffect(() => {
    if (!isLive(phase)) return;
    const t = setInterval(() => {
      const from = startedAt.current;
      if (from) setElapsed(Math.max(0, (Date.now() - from) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  const start = useCallback(async (over?: CutParams): Promise<{ job: string }> => {
    const p = { ...paramsRef.current, ...(over || {}) };
    setSubmitting(true);
    setError(null); setFailLine(null); setLog([]); setLogOpen(false);
    setCut(null); setElapsed(0);
    try {
      const d = await api<{ job: string }>(`/api/projects/${pid}/animatic`, {
        res: String(p.res || "720"), scope: String(p.scope || "full"),
      });
      if (!d?.job) throw new Error("the cut did not queue — no job came back");
      startedAt.current = Date.now();
      remember(d.job);
      setJob(d.job);
      setPhase("queued");
      return d;
    } catch (e) {
      setPhase("idle");
      setJob(null);
      setError((e as Error)?.message || String(e));
      throw e;                    // the cut_film tool reports the rejection
    } finally {
      setSubmitting(false);
    }
  }, [pid, remember]);

  const openCut = useCallback(() => {
    if (!cut) return;
    screen.open(cut.path, {
      pid, seconds: cut.seconds,
      label: cut.path.split("/").pop() || cut.path,
    });
  }, [cut, pid]);

  const toggleLog = useCallback(() => {
    setLogOpen((was) => {
      if (!was && job) {
        void api<{ lines: string[] }>(`/api/jobs/${job}/log?tail=200`)
          .then((d) => setLog(d.lines || []))
          .catch(() => { /* the line beside the button already said enough */ });
      }
      return !was;
    });
  }, [job]);

  const dismiss = useCallback(() => {
    setPhase("idle"); setJob(null); setCut(null); setFailLine(null);
    setError(null); setLog([]); setLogOpen(false); setElapsed(0);
    startedAt.current = null;
    forget();
  }, [forget]);

  return {
    pid, phase, job, elapsed, submitting, error, failLine, log, logOpen, cut,
    start, openCut, toggleLog, dismiss,
  };
}

// ---------------------------------------------------------------- the button

export interface CutFilmProps {
  cut: CutFilmState;
  /** The page's own `data-action` for this button (film.cut / timeline.render). */
  anchor: string;
  label?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * The button and its status, as siblings — drop it straight into a `.row` so the
 * status sits beside the button rather than in a corner of the screen.
 */
export default function CutFilm({ cut, anchor, label, title, disabled }: CutFilmProps) {
  const busy = cut.submitting || isLive(cut.phase);
  return (
    <>
      <button
        className="primary"
        data-action={anchor}
        data-testid="cut-film"
        disabled={busy || disabled}
        title={title || "assemble the film as it stands into a watchable cut"}
        onClick={() => { void cut.start().catch(() => { /* shown inline */ }); }}
      >
        {busy ? "⏳ cutting…" : (label || "🎞 cut the film")}
      </button>
      <FilmStaleness pid={cut.pid} justCut={cut.phase === "done"} />
      <CutFilmStatus cut={cut} />
    </>
  );
}

/**
 * "changes since the last cut · N" — the Timeline preview is always live;
 * this says whether the FILM FILE (what `cut_film` last made, what the
 * screening room and the public page play) has fallen behind it. Silent
 * once it agrees there is nothing new — a director should never have to
 * wonder why the button is shouting at them for no reason.
 */
export function FilmStaleness({ pid, justCut }: { pid: string; justCut?: boolean }) {
  const { data, refresh } = usePoll<FilmStatus>(
    `/api/projects/${pid}/film/status`, 15000, { refetchOnFocus: true });
  // A cut just settled — the file this indicator is judged against changed,
  // so do not wait out the poll interval to say so.
  useEffect(() => { if (justCut) refresh(); }, [justCut, refresh]);

  if (!data?.stale || !data.changes_count) return null;
  const tooltip = data.changes.length
    ? `Since the last cut:\n${data.changes.join("\n")}`
    : "The film has changed since it was last cut.";
  return (
    <span className="muted small" data-testid="film-staleness" title={tooltip}>
      changes since the last cut · {data.changes_count}
    </span>
  );
}

/** The inline readout. Renders nothing at all until there is something to say. */
export function CutFilmStatus({ cut }: { cut: CutFilmState }) {
  const { phase } = cut;
  const queued = cut.submitting || phase === "queued";
  if (phase === "idle" && !cut.error && !cut.submitting) return null;

  return (
    <span
      data-testid="cut-status"
      data-phase={cut.submitting ? "queued" : phase}
      style={{ position: "relative", display: "inline-flex", alignItems: "center",
               gap: 6, maxWidth: "min(560px, 60vw)" }}
    >
      {queued && <span className="small status-queued">queued</span>}

      {!cut.submitting && phase === "running" && (
        <span className="small status-running">
          cutting… {mmss(cut.elapsed)}
        </span>
      )}

      {!cut.submitting && phase === "done" && (
        <span className="small status-done" style={{ whiteSpace: "nowrap" }}>
          cut ready{" "}
          {cut.cut ? (
            <>
              ·{" "}
              <button
                className="small" data-testid="cut-open"
                style={{ padding: "1px 7px" }}
                title={cut.cut.seconds
                  ? `watch it — ${mmss(cut.cut.seconds)}` : "watch it"}
                onClick={cut.openCut}
              >open</button>
            </>
          ) : null}
        </span>
      )}

      {!cut.submitting && phase === "cancelled" && (
        <span className="small status-cancelled">cut cancelled</span>)}

      {!cut.submitting && phase === "failed" && (
        <span className="small status-failed"
              style={{ display: "inline-flex", alignItems: "center", gap: 6,
                       minWidth: 0 }}>
          <b>cut failed</b>
          {cut.failLine && (
            <span title={cut.failLine}
                  style={{ overflow: "hidden", textOverflow: "ellipsis",
                           whiteSpace: "nowrap", maxWidth: 320, opacity: 0.9 }}>
              {cut.failLine}
            </span>
          )}
        </span>
      )}

      {cut.error && (
        <span className="small status-failed" title={cut.error}
              style={{ overflow: "hidden", textOverflow: "ellipsis",
                       whiteSpace: "nowrap", maxWidth: 360 }}>
          cut refused — {cut.error}
        </span>
      )}

      {cut.job && (
        <button className="small" data-testid="cut-log"
                style={{ padding: "1px 7px" }}
                title="the assembler's own output"
                onClick={cut.toggleLog}>
          {cut.logOpen ? "hide log" : "log"}
        </button>
      )}

      {(phase === "done" || phase === "failed" || phase === "cancelled"
        || !!cut.error) && (
        <button className="small" title="clear this"
                style={{ padding: "1px 6px" }}
                onClick={cut.dismiss}>✕</button>
      )}

      {cut.logOpen && (
        <div
          style={{ position: "absolute", top: "calc(100% + 6px)", right: 0,
                   zIndex: 60, width: "min(620px, 78vw)", textAlign: "left",
                   background: "var(--bg2)", border: "1px solid var(--line)",
                   borderRadius: "var(--r-sm)", padding: 8,
                   boxShadow: "var(--sh-2)" }}
        >
          <div className="row" style={{ justifyContent: "space-between",
                                        marginBottom: 6 }}>
            <span className="muted small">job {cut.job}</span>
            <a className="small" href={appPath("/jobs")}>all jobs ↗</a>
          </div>
          <div className="log" style={{ maxHeight: 240 }}>
            {cut.log.length ? cut.log.join("\n") : "(no output yet)"}
          </div>
        </div>
      )}
    </span>
  );
}
