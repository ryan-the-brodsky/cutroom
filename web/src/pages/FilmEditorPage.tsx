import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, mediaUrl, thumbUrl } from "../api";
import Player from "../components/Player";
import { pushToast, useAsync, useJobWatch, usePoll } from "../hooks";
import type { FilmEntry, Take } from "../types";

/** FILM EDITOR — the arrangement room. Grab what exists, order and time it,
 * pick what plays, prep the next shot for focused work, cut the film.
 * Granular per-shot work lives in the Shot Editor. */
export default function FilmEditorPage() {
  const { pid } = useParams() as { pid: string };
  const nav = useNavigate();
  const { data: film, refresh } =
    usePoll<FilmEntry[]>(`/api/projects/${pid}/film`, 12000);
  const { data: animatics, refresh: refreshCuts } =
    usePoll<Take[]>(`/api/projects/${pid}/takes?kind=animatic&limit=10`, 0);
  const [sel, setSel] = useState<string | null>(null);
  const [res, setRes] = useState("720");
  const [scope, setScope] = useState("full");
  const [playingCut, setPlayingCut] = useState<string | null>(null);
  const [cutJob, setCutJob] = useState<string | null>(null);
  const [view, setView] = useState<"board" | "strip">("board");
  const { busy, error, run } = useAsync();

  useJobWatch(cutJob, (ok) => {
    setCutJob(null);
    pushToast({ text: ok ? "✓ the cut is ready" : "✗ cut failed (see Jobs)" });
    refreshCuts();
  });

  const selected = film?.find((s) => s.sid === sel);
  const total = (film || []).reduce((a, s) => a + (s.seconds || 0), 0);

  const setOverride = (sid: string, patch: any) =>
    api(`/api/projects/${pid}/shots/${sid}/override`, patch).then(refresh);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Film Editor
          <span className="muted"> · {film?.length || 0} shots ·
            {" "}{Math.floor(total / 60)}m{Math.round(total % 60)}s</span></h2>
        <div className="row">
          <button className="small" onClick={() =>
            setView(view === "board" ? "strip" : "board")}>
            {view === "board" ? "▤ strip only" : "▦ board"}</button>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="full">whole film</option>
            {[1, 2, 3, 4].map((a) => (
              <option key={a} value={`act${a}`}>act {a}</option>))}
          </select>
          <select value={res} onChange={(e) => setRes(e.target.value)}>
            <option value="720">720p preview</option>
            <option value="1080">1080p final</option>
          </select>
          <button className="primary" disabled={busy || !!cutJob}
            onClick={() => run(
              () => api(`/api/projects/${pid}/animatic`, { res, scope }),
              (d: any) => { setCutJob(d.job);
                            pushToast({ text: "cutting…", job: d.job }); })}>
            {cutJob ? "⏳ cutting…" : "🎞 cut the film"}
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      {/* ---------------------------------------------------- the strip */}
      <div className="timeline">
        {(film || []).map((s) => (
          <div key={s.sid}
               className={`tl-cell ${sel === s.sid ? "selected" : ""}`}
               style={{ width: Math.max(56, s.seconds * 16) }}
               onClick={() => setSel(s.sid)}
               onDoubleClick={() => nav(`/p/${pid}/shot/${s.sid}`)}
               title={`${s.sid} · ${s.seconds}s — double-click to edit`}>
            {s.active_source && (
              <img src={thumbUrl(pid, s.active_source, 160)} alt=""
                   loading="lazy" />)}
            <span className="sid">{s.sid}</span>
            <span className="ticks">
              {s.keeper && <span className="tick green" />}
              {s.motion.length > 0 && <span className="tick blue" />}
              {(s.comps?.length || 0) > 0 && <span className="tick violet" />}
              <span className={`tick ${s.vo.length ? "" : "grey"}`}
                    style={s.vo.length ? { background: "var(--accent)" } : {}} />
            </span>
          </div>
        ))}
      </div>

      {/* ------------------------------------------- selected-shot panel */}
      {selected && (
        <div className="card" style={{ margin: "8px 0" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <b>{selected.sid}</b>
              <span className="muted small">{selected.type} ·
                {" "}{selected.register}</span>
              {selected.override.source &&
                <span className="badge cel">source override</span>}
            </div>
            <Link to={`/p/${pid}/shot/${selected.sid}`}>
              <button className="primary">open Shot Editor →</button></Link>
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ width: 320, flexShrink: 0 }}>
              <Player pid={pid} rel={selected.active_source} />
            </div>
            <div className="col" style={{ flex: 1 }}>
              <div className="row">
                <label className="field">seconds
                  <input type="number" step="0.1" style={{ width: 76 }}
                         defaultValue={selected.seconds}
                         onBlur={(e) => setOverride(selected.sid,
                           { seconds: parseFloat(e.target.value) })} /></label>
                <label className="field">VO offset
                  <input type="number" step="0.1" style={{ width: 76 }}
                         defaultValue={selected.override.vo_offset || 0}
                         onBlur={(e) => setOverride(selected.sid,
                           { vo_offset: parseFloat(e.target.value) })} /></label>
                <label className="field">mute VO
                  <input type="checkbox"
                         defaultChecked={!!selected.override.mute_vo}
                         onChange={(e) => setOverride(selected.sid,
                           { mute_vo: e.target.checked || null })} /></label>
                {selected.override.source && (
                  <button className="small" onClick={() =>
                    setOverride(selected.sid, { source: null })}>
                    clear override</button>)}
              </div>
              <div className="muted small">what plays — click a take:</div>
              <div className="row" style={{ overflowX: "auto",
                                            flexWrap: "nowrap" }}>
                {[...selected.motion, ...selected.fx,
                  ...(selected.keeper ? [selected.keeper] : []),
                  ...selected.stills.slice(0, 4)]
                  .filter((v, i, a) => a.indexOf(v) === i).slice(0, 10)
                  .map((p) => (
                    <img key={p} src={thumbUrl(pid, p, 160)}
                         style={{ height: 54, borderRadius: 4,
                                  cursor: "pointer",
                                  border: selected.active_source === p
                                    ? "2px solid var(--accent)"
                                    : "2px solid transparent" }}
                         title={p}
                         onClick={() => setOverride(selected.sid,
                                                    { source: p })} />
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------- board */}
      {view === "board" && (() => {
        const acts = new Map<number, FilmEntry[]>();
        for (const s of film || []) {
          if (!acts.has(s.act)) acts.set(s.act, []);
          acts.get(s.act)!.push(s);
        }
        return [...acts.entries()].sort(([a], [b]) => a - b).map(
          ([act, shots]) => (
            <div key={act}>
              <h3>Act {act}</h3>
              <div className="grid cards">
                {shots.map((s) => (
                  <div key={s.sid} className="card"
                       style={{ cursor: "pointer", borderColor:
                         sel === s.sid ? "var(--accent)" : undefined }}
                       onClick={() => setSel(s.sid)}
                       onDoubleClick={() => nav(`/p/${pid}/shot/${s.sid}`)}>
                    {s.active_source ? (
                      <img className="thumb"
                           src={thumbUrl(pid, s.active_source)}
                           alt={s.sid} loading="lazy" />
                    ) : (
                      <div className="thumb" style={{ display: "flex",
                        alignItems: "center", justifyContent: "center",
                        color: "var(--dim)" }}>no take</div>
                    )}
                    <div className="row"
                         style={{ justifyContent: "space-between" }}>
                      <h4>{s.sid}</h4>
                      <span className="muted">{s.seconds}s</span>
                    </div>
                    <div className="row">
                      {s.keeper && <span className="badge keeper">K</span>}
                      {s.motion.length > 0 &&
                        <span className="badge motion">M</span>}
                      {(s.comps?.length || 0) > 0 &&
                        <span className="badge cel">CEL</span>}
                      {s.vo.length > 0 && <span className="badge vo">VO</span>}
                      <span className="muted small"
                            style={{ marginLeft: "auto" }}>{s.type}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ));
      })()}

      {/* -------------------------------------------------------- cuts */}
      <h3>Cuts</h3>
      <div className="grid cards">
        {(animatics || []).map((a) => (
          <div className="card" key={a.id}>
            {playingCut === a.path ? (
              <video src={mediaUrl(pid, a.path)} controls autoPlay
                     style={{ width: "100%", borderRadius: 5 }} />
            ) : (
              <img className="thumb" src={thumbUrl(pid, a.path)}
                   style={{ cursor: "pointer" }}
                   onClick={() => setPlayingCut(a.path)} alt={a.path} />
            )}
            <div className="muted small">{a.path.split("/").pop()}
              {a.meta?.total ? ` · ${Math.round(a.meta.total)}s` : ""}</div>
          </div>
        ))}
        {(animatics || []).length === 0 && (
          <div className="muted">no cuts yet — press “cut the film”</div>)}
      </div>
    </div>
  );
}
