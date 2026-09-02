import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ANCHORS, type TimelineClipLite } from "../agent/contract";
import { usePageHandles } from "../agent/pageHandles";
import CutFilm, { type CutScope, useCutFilm } from "../components/CutFilm";
import { mediaUrl, thumbUrl } from "../api";
import { usePoll } from "../hooks";
import { PreviewStage } from "../preview/PreviewStage";
import { mixSummary, useTimelineAudio } from "../preview/timelineAudio";
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
  const fps = tl?.fps || 24;
  const [ppf, setPpf] = useState(0.7); // pixels per frame (zoom)
  const [sel, setSel] = useState<Clip | null>(null);
  // `preview_timeline` sets a preview scope in seconds. Nothing draws it now
  // that the local-engine render row is gone, but the handle stays in the
  // contract, so the setter stays with it.
  const [, setScopeSec] = useState<number | null>(24);
  const [cutScope, setCutScope] = useState<CutScope>("full");
  const playerRef = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const seek = (f: number) => {
    const clamped = Math.max(0, Math.min(f, (tl?.total_frames ?? 1) - 1));
    playerRef.current?.seekTo(clamped);
    setFrame(clamped);
  };
  // Cutting the film is the same DB-backed job here as in the Film Editor —
  // there is no local engine to be offline.
  const cut = useCutFilm({ pid, params: { scope: cutScope, res: "720" } });

  /* ------------------------------------------------------------------ the mix
   * The picture is composited by seeking a <video> per frame; sound cannot work
   * that way, so the VO/music/SFX clips run as their own elements following the
   * same playhead (preview/timelineAudio.ts). Everything the transport does goes
   * through `transport()`, so the button, the mix and the drift loop never
   * disagree — and the first play() happens inside the click that asked for it,
   * which is what the browser's autoplay policy checks. */
  const audioSrc = useCallback((rel: string) => mediaUrl(pid, rel), [pid]);
  const audio = useTimelineAudio(tl, audioSrc);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const lastFrameRef = useRef(0);
  lastFrameRef.current = Math.max(0, (tl?.total_frames ?? 1) - 1);
  const raf = useRef<number | null>(null);
  const nowSeconds = useCallback(() =>
    (playerRef.current?.getCurrentFrame() ?? 0) / (fpsRef.current || 24), []);

  /** Ride the player's own clock: re-sync the mix every frame (so a snap costs at
   * most one frame of drift) and notice the end of the film, which stops the clock
   * a beat before React hears about it — hence the explicit last-frame test, so a
   * held line can never stutter against a playhead that has stopped moving. */
  const pump = useCallback(() => {
    const p = playerRef.current;
    const on = p?.isPlaying() ?? false;
    const running = on && (p?.getCurrentFrame() ?? 0) < lastFrameRef.current;
    audio.sync(nowSeconds(), running);
    if (on) { raf.current = requestAnimationFrame(pump); return; }
    raf.current = null;
    setPlaying(false);
  }, [audio, nowSeconds]);

  const transport = useCallback((on: boolean) => {
    setPlaying(on);
    // `true`: this call is the ask (a press of ▶, or a tool's play), so it is
    // allowed one attempt even if the browser refused the last one.
    audio.sync(nowSeconds(), on, true);
    if (on) {
      if (raf.current == null) raf.current = requestAnimationFrame(pump);
    } else if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, [audio, nowSeconds, pump]);

  // Scrubbing (and any seek) re-cues the mix where it stands, so pressing ▶ next
  // starts every clip at the right place instead of at its head.
  useEffect(() => {
    if (!playing) audio.sync(frame / (fps || 24), false);
  }, [frame, fps, playing, audio]);

  useEffect(() => () => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  const secs = (f: number) => framesToSeconds(f, tl?.fps || 24);
  const mmss = (f: number) => {
    const s = secs(f);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  /* ------------------------------------------------------- the transport, as handles
   * The Timeline had a real transport and no way to ask for it, so an agent told
   * to "play the film from second X" fell back to a thumbnail. These handles are
   * the same playerRef and seek() the buttons use, in seconds rather than frames
   * (a caller should never have to know the fps). Workstream M. */
  const clipsLite = useMemo<TimelineClipLite[]>(() => (tl?.clips || [])
    .filter((c) => c.kind !== "audio")
    .map((c) => ({
      sid: c.cutroom?.shot || c.label || c.id,
      start: framesToSeconds(c.start, fps),
      seconds: framesToSeconds(c.duration, fps),
      kind: c.kind,
    }))
    .sort((a, b) => a.start - b.start), [tl, fps]);

  const seekSeconds = useCallback((t: number) => {
    const f = Math.round(Math.max(0, Number(t) || 0) * fps);
    const clamped = Math.max(0, Math.min(f, (tl?.total_frames ?? 1) - 1));
    playerRef.current?.seekTo(clamped);
    setFrame(clamped);
  }, [fps, tl?.total_frames]);

  usePageHandles({
    kind: "timeline", pid,
    currentTime: () => framesToSeconds(
      playerRef.current?.getCurrentFrame() ?? frame, fps),
    duration: () => framesToSeconds(tl?.total_frames ?? 0, fps),
    seek: seekSeconds,
    play: async () => {
      // Picture always starts; the mix may not, because a tool call is not a
      // click. `audio.blocked` says so on the page, and the ▶ button unblocks it.
      playerRef.current?.play();
      const on = playerRef.current?.isPlaying() ?? false;
      transport(on);
      return on;
    },
    pause: () => { playerRef.current?.pause(); transport(false); },
    toggle: () => {
      playerRef.current?.toggle();
      transport(playerRef.current?.isPlaying() ?? false);
    },
    selectClip: (sid: string) => {
      const want = String(sid || "").toLowerCase();
      const hit = (tl?.clips || []).find(
        (c) => String(c.cutroom?.shot || c.label || "").toLowerCase() === want);
      if (hit) { setSel(hit); seek(hit.start); }
    },
    clips: () => clipsLite,
    setScope: (sec: number | null) => setScopeSec(sec),
  });

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
                 data-action={ANCHORS.timelineZoom}
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

      {/* ---------------------------------------------------- cut the film */}
      <div className="row" style={{ gap: 8, margin: "0 0 10px", alignItems: "center" }}>
        <span className="muted small">cut:</span>
        {/* The assemble endpoint scopes by act, not by seconds — this is the
            same scope the Film Editor sends. */}
        <select value={cutScope} data-action={ANCHORS.timelineScope}
                onChange={(e) => setCutScope(e.target.value as CutScope)}>
          <option value="full">whole film ({mmss(tl.total_frames)})</option>
          {[1, 2, 3, 4].map((a) => (
            <option key={a} value={`act${a}`}>act {a}</option>))}
        </select>
        <CutFilm cut={cut} anchor={ANCHORS.timelineRender} />
        <span style={{ flex: 1 }} />
        <span className="muted small">export:</span>
        <a data-action={ANCHORS.timelineOtio} className="small"
           href={`/api/projects/${pid}/timeline/otio`} target="_blank"
           rel="noreferrer" title="OpenTimelineIO — round-trips into Resolve/Premiere">
          OTIO</a>
        <a data-action={ANCHORS.timelineEdl} className="small"
           href={`/api/projects/${pid}/timeline/edl`} target="_blank"
           rel="noreferrer" title="CMX3600 EDL — the lowest common denominator">
          EDL</a>
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
                    data-action={ANCHORS.timelinePlay}
                    onClick={() => {
                      playerRef.current?.toggle();
                      transport(playerRef.current?.isPlaying() ?? false);
                    }}>
              {playing ? "⏸" : "▶"}
            </button>
            <button className="small" data-testid="mute"
                    data-action={ANCHORS.timelineMute}
                    disabled={!audio.cues.length}
                    title={audio.cues.length
                      ? (audio.muted ? "unmute the preview" : "mute the preview")
                      : "this film has no audio clips yet"}
                    aria-pressed={audio.muted}
                    onClick={() => audio.setMuted(!audio.muted)}>
              {audio.muted || !audio.cues.length ? "🔇" : "🔊"}
            </button>
            <button className="small" data-action={ANCHORS.timelineStepBack}
                    onClick={() => seek(frame - 1)}>◀</button>
            <button className="small" data-action={ANCHORS.timelineStepFwd}
                    onClick={() => seek(frame + 1)}>▶</button>
            <input type="range" min={0} max={Math.max(1, tl.total_frames - 1)}
                   value={frame} style={{ flex: 1 }}
                   data-action={ANCHORS.timelineScrub}
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
          this is the same clip model the cut is assembled from.
          {audio.cues.length ? <>
            {" "}It plays <b>with sound</b>: {mixSummary(audio.cues)} ride the
            playhead — each clip starts where the timeline puts it, stops when the
            playhead leaves, and re-cues when you scrub. 🔊 mutes the lot.
          </> : <>
            {" "}This film has no audio clips yet: synthesize VO or place a music
            or SFX cue and they compile onto A1 / MUSIC / SFX, and play here.
          </>}
          {audio.blocked && (
            <div style={{ color: "var(--bad, #ef4444)", marginTop: 4 }}>
              The browser would not start the sound on its own — press ▶ here to
              let it in.
            </div>)}
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
               data-action={ANCHORS.timelineRuler}
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
                    data-action={ANCHORS.timelineClip}
                    data-id={c.id}
                    data-sid={c.cutroom?.shot || c.label || c.id}
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
