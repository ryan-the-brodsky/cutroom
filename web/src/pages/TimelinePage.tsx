import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, mediaUrl, thumbUrl } from "../api";
import { pushToast, useAsync, useJobWatch, usePoll } from "../hooks";
import { PreviewStage } from "../preview/PreviewStage";
import type { PlayerRef } from "../runtime/player";
import {
  type Clip,
  type Timeline,
  clipsOnTrack,
  effectiveSourceEnd,
  framesToSeconds,
  headHandle,
  orderedTracks,
  tailHandle,
} from "../timeline/model";

/** TIMELINE — the film as a real clip model (source in/out + media handles),
 * compiled from shots by the server. This is the foundation the engine lift
 * hangs on: a shot is a unit of production; a clip is a unit of time. */
export default function TimelinePage() {
  const { pid } = useParams() as { pid: string };
  const { data: tl, error } = usePoll<Timeline>(`/api/projects/${pid}/timeline`, 0);
  const [ppf, setPpf] = useState(0.7); // pixels per frame (zoom)
  const [sel, setSel] = useState<Clip | null>(null);
  const [scopeSec, setScopeSec] = useState<number | null>(24);
  const [renderJob, setRenderJob] = useState<string | null>(null);
  const playerRef = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const seek = (f: number) => {
    const clamped = Math.max(0, Math.min(f, (tl?.total_frames ?? 1) - 1));
    playerRef.current?.seekTo(clamped);
    setFrame(clamped);
  };
  const { data: engine } = usePoll<{ available: boolean }>(
    `/api/projects/${pid}/timeline/engine`, 0);
  const { data: renders, refresh: refreshRenders } = usePoll<any[]>(
    `/api/projects/${pid}/takes?kind=animatic&limit=6`, 0);
  const { busy, run } = useAsync();
  useJobWatch(renderJob, (ok) => {
    setRenderJob(null);
    pushToast({ text: ok ? "✓ engine render ready" : "✗ render failed (see Jobs)" });
    refreshRenders();
  });

  const secs = (f: number) => framesToSeconds(f, tl?.fps || 24);
  const mmss = (f: number) => {
    const s = secs(f);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  const ruler = useMemo(() => {
    if (!tl) return [];
    const stepS = 10; // a tick every 10s
    const marks: number[] = [];
    for (let s = 0; s <= tl.duration_seconds; s += stepS) marks.push(s);
    return marks;
  }, [tl]);

  if (error) return <div className="error">timeline failed: {error}</div>;
  if (!tl) return <TimelineSkeleton />;

  const kinds = tl.clips.reduce<Record<string, number>>((a, c) => {
    a[c.kind] = (a[c.kind] || 0) + 1;
    return a;
  }, {});
  const laneW = Math.max(640, tl.total_frames * ppf);

  const clipColor = (c: Clip) =>
    c.kind === "video" ? "#2563eb" :
    c.kind === "image" ? "#7c3aed" :
    c.kind === "audio" ? "#0d9488" : "#475569";

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          Timeline
          <span className="muted"> · {tl.clips.length} clips · {mmss(tl.total_frames)}
            {" "}· {tl.fps}fps · {tl.width}×{tl.height}</span>
        </h2>
        <label className="field">zoom
          <input type="range" min={0.2} max={3} step={0.1} value={ppf}
                 onChange={(e) => setPpf(parseFloat(e.target.value))} />
        </label>
      </div>

      <div className="muted small" style={{ margin: "4px 0 10px" }}>
        The film as real clips — <b style={{ color: "#2563eb" }}>video</b> (with
        source in/out), <b style={{ color: "#7c3aed" }}>stills</b> (true holds),
        <b style={{ color: "#0d9488" }}> VO</b> on the audio track.
        {" "}<span data-testid="kinds">
          {kinds.image || 0} stills · {kinds.video || 0} motion · {kinds.audio || 0} audio
        </span>
      </div>

      {/* ------------------------------------------------- render via engine */}
      <div className="row" style={{ gap: 8, margin: "0 0 10px", alignItems: "center" }}>
        <span className="muted small">render via engine:</span>
        <select value={scopeSec ?? "full"}
                onChange={(e) => setScopeSec(e.target.value === "full"
                  ? null : parseInt(e.target.value))}>
          <option value={12}>first 12s</option>
          <option value={24}>first 24s</option>
          <option value={60}>first 60s</option>
          <option value="full">whole film ({mmss(tl.total_frames)})</option>
        </select>
        <button
          className="primary"
          data-testid="render-btn"
          disabled={busy || !!renderJob || !engine?.available}
          title={engine?.available ? "render through the lifted FreeCut engine"
            : "engine not configured (CUTROOM_ENGINE_DIR)"}
          onClick={() => run(
            () => api(`/api/projects/${pid}/timeline/render`,
                      { scope_sec: scopeSec }),
            (d: any) => { setRenderJob(d.job);
                          pushToast({ text: "engine rendering…", job: d.job }); })}
        >
          {renderJob ? "⏳ rendering…" : "▶ render"}
        </button>
        {!engine?.available && (
          <span className="muted small">engine offline</span>)}
      </div>

      {/* ---------------------------------------------------- live preview */}
      <div className="row" style={{ alignItems: "flex-start", gap: 12,
                                    marginBottom: 10 }}>
        <div style={{ width: 480, flexShrink: 0 }}>
          <PreviewStage ref={playerRef} pid={pid} tl={tl}
                        box={{ width: 480, height: 270 }}
                        onFrameChange={setFrame} />
          <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
            <button className="small" data-testid="play"
                    onClick={() => {
                      playerRef.current?.toggle();
                      setPlaying(playerRef.current?.isPlaying() ?? false);
                    }}>
              {playing ? "⏸" : "▶"}
            </button>
            <button className="small" onClick={() => seek(frame - 1)}>◀</button>
            <button className="small" onClick={() => seek(frame + 1)}>▶</button>
            <input type="range" min={0} max={Math.max(1, tl.total_frames - 1)}
                   value={frame} style={{ flex: 1 }}
                   onChange={(e) => seek(parseInt(e.target.value))} />
            <span className="muted small" data-testid="playhead"
                  style={{ minWidth: 96, textAlign: "right" }}>
              {mmss(frame)} · f{frame}
            </span>
          </div>
        </div>
        <div className="muted small" style={{ flex: 1 }}>
          <b>Live preview</b> — the lifted FreeCut player compositing this
          project's media by URL. Scrub the bar or click the timeline to seek;
          this is the same clip model the engine renders. Audio/VO preview is a
          later pass — video &amp; stills scrub now.
        </div>
      </div>

      {/* ------------------------------------------------ the timeline lanes */}
      <div style={{ overflowX: "auto", border: "1px solid var(--line, #333)",
                    borderRadius: 6, background: "#0b0e13" }}>
        <div style={{ width: laneW, position: "relative" }}>
          {/* playhead */}
          <div style={{ position: "absolute", top: 0, bottom: 0,
                        left: frame * ppf, width: 2, background: "#ef4444",
                        zIndex: 5, pointerEvents: "none" }} />
          {/* ruler (click to seek) */}
          <div style={{ height: 20, position: "relative", cursor: "pointer",
                        borderBottom: "1px solid #222" }}
               onClick={(e) => seek(Math.round(
                 (e.clientX - e.currentTarget.getBoundingClientRect().left) / ppf))}>
            {ruler.map((s) => (
              <div key={s} style={{ position: "absolute", left: s * (tl.fps * ppf),
                                    top: 0, fontSize: 10, color: "#667",
                                    borderLeft: "1px solid #223", paddingLeft: 3 }}>
                {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
              </div>
            ))}
          </div>

          {orderedTracks(tl).map((track) => (
            <div key={track.id} style={{ position: "relative", height: 60,
                                         borderBottom: "1px solid #1a1f28" }}>
              <div style={{ position: "absolute", left: 4, top: 2, fontSize: 10,
                            color: "#889", zIndex: 2 }}>{track.name}</div>
              {clipsOnTrack(tl, track.id).map((c) => {
                const left = c.start * ppf;
                const w = Math.max(3, c.duration * ppf);
                const trimmed =
                  c.kind === "video" &&
                  (headHandle(c) > 0 || (tailHandle(c) ?? 0) > 0);
                return (
                  <div
                    key={c.id}
                    data-testid="clip"
                    data-kind={c.kind}
                    onClick={() => { setSel(c); seek(c.start); }}
                    title={`${c.label} · ${c.kind} · ${c.duration}f`}
                    style={{
                      position: "absolute", left, width: w, top: 16, height: 40,
                      background: clipColor(c),
                      border: sel?.id === c.id ? "2px solid #fff" : "1px solid #0006",
                      borderRadius: 3, overflow: "hidden", cursor: "pointer",
                      color: "#fff", fontSize: 10,
                    }}
                  >
                    {(c.kind === "video" || c.kind === "image") && c.source && w > 24 && (
                      <img src={thumbUrl(pid, c.source, 120)} alt=""
                           loading="lazy"
                           style={{ position: "absolute", inset: 0, width: "100%",
                                    height: "100%", objectFit: "cover",
                                    opacity: 0.55 }} />
                    )}
                    <span style={{ position: "relative", padding: "1px 3px",
                                   display: "inline-block", textShadow: "0 1px 2px #000" }}>
                      {c.label || c.kind}
                      {trimmed && <span title="trimmed source range"> ✂</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* --------------------------------------------- selected clip detail */}
      {sel && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{sel.label || sel.kind}</b>
            <span className="muted small">{sel.kind}</span>
          </div>
          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <div className="col">
              <span className="muted small">timeline</span>
              <span>frame {sel.start}–{sel.start + sel.duration}
                {" "}({secs(sel.start).toFixed(2)}s → {secs(sel.start + sel.duration).toFixed(2)}s)</span>
            </div>
            {sel.source && sel.kind !== "image" && (
              <div className="col">
                <span className="muted small">source in/out</span>
                <span>{sel.source_start ?? 0} → {effectiveSourceEnd(sel)}
                  {sel.source_duration != null && ` of ${sel.source_duration}f`}</span>
              </div>
            )}
            {sel.kind === "video" && sel.source_duration != null && (
              <div className="col">
                <span className="muted small">media handles</span>
                <span>head {headHandle(sel)}f · tail {tailHandle(sel)}f</span>
              </div>
            )}
            {sel.source && (
              <div className="col" style={{ minWidth: 200 }}>
                <span className="muted small">source</span>
                <span style={{ wordBreak: "break-all", fontSize: 11 }}>{sel.source}</span>
              </div>
            )}
          </div>
          {sel.cutroom && Object.keys(sel.cutroom).length > 0 && (
            <div className="muted small" style={{ marginTop: 6 }}>
              lineage: {Object.entries(sel.cutroom)
                .map(([k, v]) => `${k}=${v}`).join(" · ")}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------ engine renders */}
      {(renders?.length ?? 0) > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ margin: "0 0 6px" }}>Engine renders</h3>
          <div className="grid cards" data-testid="renders">
            {(renders || []).filter((r) => r.meta?.engine).map((r) => (
              <div className="card" key={r.id}>
                <video src={mediaUrl(pid, r.path)} controls
                       style={{ width: "100%", borderRadius: 5 }} />
                <div className="muted small">{r.path.split("/").pop()}
                  {r.meta?.total ? ` · ${Math.round(r.meta.total)}s` : ""}
                  {r.meta?.items ? ` · ${r.meta.items} clips` : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Layout-mimicking loading state — only shown on the very first cold compile
 * (the server probes every clip); revisits render instantly from the SWR cache. */
function TimelineSkeleton() {
  return (
    <div>
      <div className="skel" style={{ width: 340, height: 20, marginBottom: 14 }} />
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 480, flexShrink: 0 }}>
          <div className="skel" style={{ width: 480, height: 270 }} />
          <div className="skel" style={{ width: 300, height: 28, marginTop: 6 }} />
        </div>
        <div className="muted small" style={{ flex: 1, paddingTop: 8 }}>
          compiling the film into a timeline… (first load probes every clip;
          it's cached after that)
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {[0, 1, 2].map((r) => (
          <div key={r} className="row" style={{ gap: 4, marginBottom: 4 }}>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="skel"
                   style={{ height: 44, flex: 1, opacity: 1 - r * 0.25 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
