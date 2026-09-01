import { useEffect } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { api } from "./api";
import { usePoll, useToast } from "./hooks";

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
        title="Pause/resume all generation (the MOTION_PAUSED sentinel, as an API)"
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
        <div className="brand">CUTROOM</div>
        <NavLink to="/" end>Projects</NavLink>
        {projectPid && <>
          <NavLink to={`/p/${projectPid}`} end>Film Editor</NavLink>
          <NavLink to={`/p/${projectPid}/timeline`}>Timeline</NavLink>
          <NavLink to={`/p/${projectPid}/chat`}>Director chat</NavLink>
        </>}
        <NavLink to="/jobs">Jobs</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <div className="spacer" />
        <div className="muted small" style={{ padding: 8 }}>
          {pid ? <>project: <b>{pid}</b></> : "no project selected"}
        </div>
      </nav>
      <div className="main">
        <div className="topbar">
          <span className="title">{pid || "Cutroom"}</span>
          <div style={{ flex: 1 }} />
          <SystemChips />
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
      {toast && (
        <div className="toast">
          {toast.text}{" "}
          {toast.job && <Link to="/jobs">view job →</Link>}
        </div>
      )}
    </div>
  );
}
