import { useEffect } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { api, setToken } from "./api";
import AccessGate from "./components/AccessGate";
import { ANCHORS } from "./agent/contract";
import Palette from "./agent/Palette";
import { AgentChip, AgentTrail } from "./agent/presence";
import ScreeningRoom from "./components/ScreeningRoom";
import { usePoll, useToast } from "./hooks";
import { ROUTES, chatPath, filmPath, timelinePath } from "./routes";

/**
 * Addendum A: a judge's link is one click — `?token=<t>` is stored and stripped from the URL
 * before anything fetches. Runs at module load (before the first render) because child effects
 * fire before parent effects, and the pages start polling in theirs.
 */
(function intakeToken() {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("token");
    if (!t) return;
    setToken(t);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch { /* never block boot on this */ }
})();

function SystemChips() {
  const { data } = usePoll<any>("/api/system", 5000);
  if (!data) return null;
  const running = data.jobs?.running || 0;
  const queued = data.jobs?.queued || 0;
  return (
    <div className="row">
      <span className="chip">
        <span className={`dot ${running ? "busy" : "ok"}`} />
        {running ? `${running} running` : "idle"}
        {queued ? ` · ${queued} queued` : ""}
      </span>
      {data.paused && <span className="chip" style={{ color: "var(--bad)" }}>
        ⏸ paused</span>}
      <button
        className="small"
        data-action={ANCHORS.pause}
        title="Pause/resume all generation (the pause sentinel, as an API)"
        onClick={() => api("/api/system/pause", { paused: !data.paused })}>
        {data.paused ? "▶ resume" : "⏸ pause"}
      </button>
    </div>
  );
}

export default function App() {
  const { pid } = useParams();
  const toast = useToast();
  // Remember the last project so its links stay in the sidebar even on global
  // routes (Jobs/Settings) — no dead-ending, no reload to get back.
  useEffect(() => {
    if (pid) localStorage.setItem("cutroom_last_pid", pid);
  }, [pid]);
  const projectPid = pid || localStorage.getItem("cutroom_last_pid") || "";
  return (
    <div className="app">
      <nav className="sidebar">
        <Link className="brand" to="/" aria-label="Genga Studio">
          <img src="/genga-wordmark.svg" alt="Genga Studio" width={496} height={84} />
        </Link>
        <NavLink to={ROUTES.projects} end data-action={ANCHORS.navProjects}>Projects</NavLink>
        {projectPid && <>
          <NavLink to={filmPath(projectPid)} end
                   data-action={ANCHORS.navFilm}>Film Editor</NavLink>
          <NavLink to={timelinePath(projectPid)}
                   data-action={ANCHORS.navTimeline}>Timeline</NavLink>
          <NavLink to={chatPath(projectPid)}
                   data-action={ANCHORS.navChat}>Director chat</NavLink>
        </>}
        <NavLink to={ROUTES.jobs} data-action={ANCHORS.navJobs}>Jobs</NavLink>
        <NavLink to={ROUTES.settings} data-action={ANCHORS.navSettings}>Settings</NavLink>
        <div className="spacer" />
        <div className="muted small" style={{ padding: 8 }}>
          {pid ? <>project: <b>{pid}</b></> : "no project selected"}
        </div>
        <div className="muted small" style={{ padding: "0 8px 8px" }}>
          press <b>⌘K</b> for everything
        </div>
      </nav>
      <div className="main">
        <div className="topbar">
          <span className="title">{pid || "Genga Studio"}</span>
          <div style={{ flex: 1 }} />
          <AgentChip />
          <SystemChips />
        </div>
        <div className="content">
          <AccessGate><Outlet /></AccessGate>
        </div>
      </div>
      {toast && (
        <div className="toast">
          {toast.text}{" "}
          {toast.job && <Link to={ROUTES.jobs}>view job →</Link>}
        </div>
      )}
      <AgentTrail />
      <Palette />
      {/* The screening room, mounted once: any route can put a cut on the big
          screen, and `?screen=<rel>&t=<seconds>` is a link into it. */}
      <ScreeningRoom />
    </div>
  );
}
