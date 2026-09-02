import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, mediaUrl, thumbUrl } from "../api";
import {
  ANCHORS,
  type CuePlacement, type CueRecord, type FilmShotLite,
} from "../agent/contract";
import { usePageHandles } from "../agent/pageHandles";
import { pick, useQueryState } from "../agent/urlState";
import Player from "../components/Player";
import { pushToast, useAsync, useJobWatch, usePoll } from "../hooks";
import type { FilmEntry, Take } from "../types";

/** FILM EDITOR — the arrangement room. Grab what exists, order and time it,
 * pick what plays, prep the next shot for focused work, cut the film.
 * Granular per-shot work lives in the Shot Editor.
 *
 * sel / view / scope / res live in the query string, so "act 1 at 1080, B10-S2 selected"
 * is a link the agent layer can navigate to (docs/WEBMCP-PLAN.md §3.3). */

const VIEWS = ["board", "strip"] as const;
const SCOPES = ["full", "act1", "act2", "act3", "act4"] as const;
const RESES = ["720", "1080"] as const;

export default function FilmEditorPage() {
  const { pid } = useParams() as { pid: string };
  const nav = useNavigate();
  const { data: film, refresh } =
    usePoll<FilmEntry[]>(`/api/projects/${pid}/film`, 12000);
  const { data: animatics, refresh: refreshCuts } =
    usePoll<Take[]>(`/api/projects/${pid}/takes?kind=animatic&limit=10`, 0);
  const { data: cueSheet, refresh: refreshCues } =
    usePoll<{ music: CueRecord[]; sfx: CueRecord[] }>(
      `/api/projects/${pid}/cues`, 0);
  const [q, setQ] = useQueryState();
  const sel = q.get("sel");
  const view = pick(q, "view", VIEWS, "board");
  const scope = pick(q, "scope", SCOPES, "full");
  const res = pick(q, "res", RESES, "720");
  const setSel = (s: string | null) => setQ({ sel: s });
  const setView = (v: (typeof VIEWS)[number]) => setQ({ view: v });
  const setScope = (s: string) => setQ({ scope: s });
  const setRes = (r: "720" | "1080") => setQ({ res: r });
  const [playingCut, setPlayingCut] = useState<string | null>(null);
  const [cutJob, setCutJob] = useState<string | null>(null);
  const { busy, error, run } = useAsync();

  useJobWatch(cutJob, (ok) => {
    setCutJob(null);
    pushToast({ text: ok ? "✓ the cut is ready" : "✗ cut failed (see Jobs)" });
    refreshCuts();
  });

  const selected = film?.find((s) => s.sid === sel);
  const total = (film || []).reduce((a, s) => a + (s.seconds || 0), 0);

  const setOverride = (sid: string, patch: any) =>
    api(`/api/projects/${pid}/shots/${sid}/override`, patch).then(() => refresh());
  const fire = (p: Promise<unknown>) => { void p.catch(() => {}); };

  /** The same handler "🎞 cut the film" calls. */
  const cutFilm = async () => {
    const d = await run(
      () => api<{ job: string }>(`/api/projects/${pid}/animatic`, { res, scope }),
      (v: any) => { setCutJob(v.job); pushToast({ text: "cutting…", job: v.job }); });
    if (!d?.job) throw new Error("the cut did not queue — see the error above");
    return d;
  };

  /** The whole cue sheet, music then SFX, in film order. */
  const cues: CueRecord[] = useMemo(() => {
    const rows = [...(cueSheet?.music || []), ...(cueSheet?.sfx || [])];
    return rows.sort((a, b) => (a.at ?? 1e9) - (b.at ?? 1e9));
  }, [cueSheet]);

  const addCue = async (c: CuePlacement): Promise<CueRecord> => {
    const d = await api<{ cue: CueRecord; at: number | null }>(
      `/api/projects/${pid}/cues`, c);
    refreshCues();
    return { ...d.cue, at: d.at };
  };
  const removeCue = async (id: string) => {
    await api(`/api/projects/${pid}/cues/${id}/delete`, {});
    refreshCues();
  };

  const shotsLite: FilmShotLite[] = useMemo(() => (film || []).map((s, i) => ({
    sid: s.sid, ordinal: i + 1, beat: s.beat, act: s.act, type: s.type,
    seconds: s.seconds, keeper: s.keeper ?? null, active_source: s.active_source ?? null,
  })), [film]);

  usePageHandles({
    kind: "film", pid,
    getState: () => ({ selected: sel, scope, res, shots: shotsLite, cues }),
    selectShot: setSel,
    setScope,
    setRes,
    cutFilm,
    setOverride,
    addCue,
    removeCue,
    // Bump every poll, then give the refetches a beat so a caller (an agent tool that just
    // cut the film) sees the new animatic in the Cuts gallery when it returns.
    refresh: async () => {
      refresh(); refreshCuts(); refreshCues();
      await new Promise((r) => setTimeout(r, 700));
    },
  });

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Film Editor
          <span className="muted"> · {film?.length || 0} shots ·
            {" "}{Math.floor(total / 60)}m{Math.round(total % 60)}s</span></h2>
        <div className="row">
          <button className="small" data-action="film.view" onClick={() =>
            setView(view === "board" ? "strip" : "board")}>
            {view === "board" ? "▤ strip only" : "▦ board"}</button>
          <select value={scope} data-action={ANCHORS.filmScope}
                  onChange={(e) => setScope(e.target.value)}>
            <option value="full">whole film</option>
            {[1, 2, 3, 4].map((a) => (
              <option key={a} value={`act${a}`}>act {a}</option>))}
          </select>
          <select value={res} data-action={ANCHORS.filmRes}
                  onChange={(e) => setRes(e.target.value as "720" | "1080")}>
            <option value="720">720p preview</option>
            <option value="1080">1080p final</option>
          </select>
          <button className="primary" disabled={busy || !!cutJob}
            data-action={ANCHORS.filmCut}
            onClick={() => fire(cutFilm())}>
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
               data-action={ANCHORS.filmShot} data-sid={s.sid}
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
              <button className="primary" data-action={ANCHORS.quickOpen}
                      data-sid={selected.sid}>open Shot Editor →</button></Link>
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ width: 320, flexShrink: 0 }}>
              <Player pid={pid} rel={selected.active_source} />
            </div>
            <div className="col" style={{ flex: 1 }}>
              <div className="row">
                <label className="field">seconds
                  <input type="number" step="0.1" style={{ width: 76 }}
                         data-action={ANCHORS.quickSeconds} data-sid={selected.sid}
                         defaultValue={selected.seconds}
                         onBlur={(e) => fire(setOverride(selected.sid,
                           { seconds: parseFloat(e.target.value) }))} /></label>
                <label className="field">VO offset
                  <input type="number" step="0.1" style={{ width: 76 }}
                         data-action={ANCHORS.quickVoOffset} data-sid={selected.sid}
                         defaultValue={selected.override.vo_offset || 0}
                         onBlur={(e) => fire(setOverride(selected.sid,
                           { vo_offset: parseFloat(e.target.value) }))} /></label>
                <label className="field">mute VO
                  <input type="checkbox"
                         data-action={ANCHORS.quickMute} data-sid={selected.sid}
                         defaultChecked={!!selected.override.mute_vo}
                         onChange={(e) => fire(setOverride(selected.sid,
                           { mute_vo: e.target.checked || null }))} /></label>
                {selected.override.source && (
                  <button className="small" onClick={() =>
                    fire(setOverride(selected.sid, { source: null }))}>
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
                         data-action={ANCHORS.quickSource} data-path={p}
                         style={{ height: 54, borderRadius: 4,
                                  cursor: "pointer",
                                  border: selected.active_source === p
                                    ? "2px solid var(--accent)"
                                    : "2px solid transparent" }}
                         title={p}
                         onClick={() => fire(setOverride(selected.sid,
                                                         { source: p }))} />
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
                       data-action={ANCHORS.filmShot} data-sid={s.sid}
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
                   data-action="film.cut.play" data-path={a.path}
                   onClick={() => setPlayingCut(a.path)} alt={a.path} />
            )}
            <div className="muted small">{a.path.split("/").pop()}
              {a.meta?.total ? ` · ${Math.round(a.meta.total)}s` : ""}</div>
          </div>
        ))}
        {(animatics || []).length === 0 && (
          <div className="muted">no cuts yet — press “cut the film”</div>)}
      </div>

      {/* --------------------------------------------------- cue strip */}
      <h3>Cues <span className="muted small">— the audio bed the cut mixes
        in; gain is dB, 0 is unity</span></h3>
      <div className="col" data-action={ANCHORS.filmCues}>
        {cues.map((c) => (
          <div className="row" key={c.id}
               style={{ borderBottom: "1px solid var(--line)", padding: "2px 0" }}>
            <code className="small" style={{ width: 56, textAlign: "right" }}>
              {c.at == null ? "—" : `${Math.floor(c.at / 60)}:${
                String(Math.floor(c.at % 60)).padStart(2, "0")}`}</code>
            <span className="badge cel">{c.kind}</span>
            <code className="small" style={{ flex: 1 }}>
              {c.path.split("/").pop()}</code>
            {c.shot && (
              <button className="small" title="the shot this cue rides"
                data-action={ANCHORS.filmShot} data-sid={c.shot}
                onClick={() => setSel(c.shot!)}>{c.shot}</button>)}
            <span className="muted small">
              {c.duration ? `${c.duration}s · ` : ""}{c.gain}dB
              {c.exists === false ? " · missing" : ""}</span>
            <button className="small" title="remove this cue"
              data-action={ANCHORS.filmCueRemove} data-id={c.id}
              onClick={() => fire(removeCue(c.id))}>✕</button>
          </div>
        ))}
        {cues.length === 0 && (
          <div className="muted">no cues — score a stretch from any shot’s
            Audio tab, or ask the agent for music</div>)}
      </div>
    </div>
  );
}
