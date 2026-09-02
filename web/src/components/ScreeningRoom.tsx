/**
 * THE SCREENING ROOM: the full-screen view a film is actually watched in.
 *
 * Grew out of `Spotlight` (which stays, for the cel workbench's one-off peeks).
 * The difference is that this one knows what it is playing: a cut carries its
 * EDL, so the strip along the bottom is the film's own shot list, the current
 * shot is lit, clicking one seeks, and "open shot ↗" walks you into the editor
 * for the frame you are looking at. A still is screened the same way. It holds
 * for its shot's seconds with a progress bar, so a stills-only animatic plays.
 *
 * It is driven entirely by `screen/store.ts`, so the Cuts gallery, the take rail
 * and the `play_cut` / `play_take` tools all open it the same way, and the room
 * hands its <video> back to the store so a tool can seek and press play.
 *
 * URL state: `?screen=<rel>&t=<seconds>` on any project route, so a deep link
 * opens the room at that second. Closing removes both.
 *
 * Owned by workstream M. See docs/WEBMCP-PLAN.md §4.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { mediaUrl } from "../api";
import { ANCHORS, type Chapter } from "../agent/contract";
import { usePageHandles } from "../agent/pageHandles";
import { useQueryState } from "../agent/urlState";
import * as screen from "../screen/store";
import { chapterAt, fetchChapters, mmss, stepChapter } from "../screen/edl";
import { api } from "../api";

const IS_CLIP = (p: string) => /\.(mp4|webm|mov|m4v)$/i.test(p);
const CHROME = 132;          // px of chrome under the picture (readout + strip)
const STILL_HOLD = 4;        // a still with no known duration

/** Subscribe a component to the screening-room store. */
export function useScreenState(): screen.ScreenState {
  const [s, setS] = useState<screen.ScreenState>(() => screen.screenState());
  useEffect(() => screen.subscribe(setS), []);
  return s;
}

// ------------------------------------------------------------------ the shell

/**
 * Mounted once, in `App`. Owns the URL round-trip and gates the room itself,
 * so the handles below register only while it is really open.
 */
export default function ScreeningRoom() {
  const s = useScreenState();
  const { pid } = useParams();
  const [q, setQ] = useQueryState();
  const param = q.get("screen");
  const paramT = q.get("t");
  const projectPid = s.pid || pid || localStorage.getItem("cutroom_last_pid") || "";

  // Deep link in: `?screen=<rel>&t=<seconds>` opens the room at that second.
  useEffect(() => {
    if (!param) return;
    if (s.open && s.rel === param) return;
    screen.open(param, { pid: projectPid, t: Number(paramT) || 0 });
    // paramT is intentionally read once, at open: after that the room owns time.
  }, [param]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link out: the room's rel is always in the URL; `t` follows the playhead
  // at 1 Hz. Both writes are `replace`, so scrubbing never grows the history.
  useEffect(() => {
    if (s.open && s.rel) {
      if (param !== s.rel) setQ({ screen: s.rel });
    } else if (param) {
      setQ({ screen: null, t: null });
    }
  }, [s.open, s.rel, param, setQ]);

  if (!s.open || !s.rel) return null;
  return <Room key={s.rel} pid={projectPid} state={s} setQ={setQ} />;
}

// ------------------------------------------------------------------- the room

function Room({ pid, state, setQ }: {
  pid: string;
  state: screen.ScreenState;
  setQ: (patch: Record<string, string | null>) => void;
}) {
  const rel = state.rel!;
  const nav = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isClip = IS_CLIP(rel);
  const [now, setNow] = useState(state.t);
  const [len, setLen] = useState<number>(state.seconds || (isClip ? 0 : STILL_HOLD));
  const [chapters, setChapters] = useState<Chapter[]>(state.chapters);
  const [full, setFull] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A still has no media clock, so the room keeps one for it.
  const stillClock = useRef<{ base: number; at: number } | null>(null);

  useEffect(() => { setChapters(state.chapters); }, [state.chapters]);
  useEffect(() => {
    if (state.seconds && !isClip) setLen(state.seconds);
  }, [state.seconds, isClip]);

  // ---------------------------------------------------------- the media clock

  const duration = useCallback(() => {
    const d = videoRef.current?.duration;
    if (isClip && d && Number.isFinite(d)) return d;
    return len || state.seconds || (isClip ? 0 : STILL_HOLD);
  }, [isClip, len, state.seconds]);

  const currentTime = useCallback(() => {
    if (isClip) return videoRef.current?.currentTime ?? now;
    return now;
  }, [isClip, now]);

  const seek = useCallback((t: number) => {
    const at = Math.max(0, Math.min(Number(t) || 0, Math.max(0, duration() - 0.05)));
    if (isClip && videoRef.current) videoRef.current.currentTime = at;
    else stillClock.current = { base: at, at: Date.now() };
    setNow(at);
  }, [duration, isClip]);

  const play = useCallback(async (): Promise<boolean> => {
    if (!isClip) {
      stillClock.current = { base: currentTime(), at: Date.now() };
      screen.setPlaying(true);
      return true;
    }
    const v = videoRef.current;
    if (!v) return false;
    try {
      await v.play();
      screen.setPlaying(true);
      return true;
    } catch {
      screen.setBlocked(true);
      return false;
    }
  }, [currentTime, isClip]);

  const pause = useCallback(() => {
    if (isClip) videoRef.current?.pause();
    else stillClock.current = null;
    screen.setPlaying(false);
  }, [isClip]);

  const close = useCallback(() => {
    screen.close();
    setQ({ screen: null, t: null });
  }, [setQ]);

  // ------------------------------------------------------- chapters (the EDL)

  useEffect(() => {
    if (chapters.length || !pid || !isClip) return;
    let live = true;
    void fetchChapters(api, pid, rel).then(({ chapters: rows, total }) => {
      if (!live || !rows.length) return;
      setChapters(rows);
      screen.setChapters(rows, total);
      if (total) setLen(total);
    });
    return () => { live = false; };
  }, [pid, rel, isClip]); // eslint-disable-line react-hooks/exhaustive-deps

  // --------------------------------------------------- hand the player to the store

  useEffect(() => screen.attach({
    currentTime, duration, seek, play, pause,
  }), [currentTime, duration, seek, play, pause]);

  // Honour every open()/seek() request, including a repeat of the same second.
  useEffect(() => { seek(state.t); }, [state.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autoplay, once, with the browser's answer recorded either way.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !state.autoplay) return;
    started.current = true;
    const id = setTimeout(() => { void play(); }, isClip ? 60 : 0);
    return () => clearTimeout(id);
  }, [state.autoplay, isClip, play]);

  // The playhead: a 4 Hz tick is enough for a readout and a lit chapter, and it
  // is the one place the still clock advances.
  useEffect(() => {
    const id = setInterval(() => {
      if (isClip) {
        const v = videoRef.current;
        if (v) setNow(v.currentTime);
      } else if (stillClock.current) {
        const t = stillClock.current.base + (Date.now() - stillClock.current.at) / 1000;
        if (t >= duration()) { stillClock.current = null; screen.setPlaying(false); setNow(duration()); }
        else setNow(t);
      }
    }, 250);
    return () => clearInterval(id);
  }, [isClip, duration]);

  // `?t=` follows the playhead at 1 Hz so the link in the address bar is live.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Math.floor(currentTime());
      setQ({ t: t > 0 ? String(t) : null });
    }, 1000);
    return () => clearInterval(id);
  }, [currentTime, setQ]);

  // Stop and hold at `to` (play_cut's second argument).
  useEffect(() => {
    if (state.stopAt == null) return;
    if (now >= state.stopAt) pause();
  }, [now, state.stopAt, pause]);

  // ------------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const k = e.key;
      const jump = (d: number) => { e.preventDefault(); seek(currentTime() + d); };
      if (k === "Escape") { e.preventDefault(); close(); }
      else if (k === " " || k === "Spacebar") {
        e.preventDefault();
        if (state.playing) pause(); else void play();
      } else if (k === "ArrowLeft") jump(-5);
      else if (k === "ArrowRight") jump(5);
      else if (k === "j" || k === "J") jump(-10);
      else if (k === "k" || k === "K") { e.preventDefault(); pause(); }
      else if (k === "l" || k === "L") {
        e.preventDefault();
        if (state.playing) jump(10); else void play();
      } else if (k === "f" || k === "F") { e.preventDefault(); toggleFullscreen(); }
      else if (k === "." || k === ",") {
        e.preventDefault();
        const hit = stepChapter(chapters, currentTime(), k === "." ? 1 : -1);
        if (hit) seek(hit.start);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) { void document.exitFullscreen(); setFull(false); }
      else { void el.requestFullscreen?.(); setFull(true); }
    } catch { /* not every browser, never fatal */ }
  };

  // ------------------------------------------------------------- page handles

  usePageHandles({
    kind: "screen", pid, rel,
    currentTime, duration, seek, play, pause, close,
    chapters: () => chapters,
  });

  // ------------------------------------------------------------------- render

  const total = duration();
  const here = useMemo(() => chapterAt(chapters, now), [chapters, now]);
  const url = mediaUrl(pid, rel);
  const pct = total ? Math.min(100, (now / total) * 100) : 0;

  return (
    <div ref={rootRef} data-action={ANCHORS.screenRoot} data-rel={rel}
         onClick={(e) => { if (e.target === e.currentTarget) close(); }}
         style={{
           position: "fixed", inset: 0, zIndex: 1000, background: "#05070b",
           display: "flex", flexDirection: "column",
         }}>
      {/* ------------------------------------------------------- top chrome */}
      <div className="row" style={{
        justifyContent: "space-between", padding: "6px 12px", flexShrink: 0,
        borderBottom: "1px solid #171c26", color: "#c8cedb",
      }}>
        <div className="row" style={{ gap: 8, minWidth: 0 }}>
          <b style={{ letterSpacing: 1, fontSize: 12, color: "#7c8699" }}>SCREENING</b>
          <code className="small" style={{ color: "#96a0b3", overflow: "hidden",
                                           textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.label || rel.split("/").pop()}</code>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {here && (
            <button className="small" data-action={ANCHORS.screenOpenShot}
                    data-sid={here.sid}
                    title={`open ${here.sid} in the Shot Editor`}
                    onClick={() => { close(); nav(`/p/${pid}/shot/${here.sid}`); }}>
              open {here.sid} ↗</button>)}
          <button className="small" onClick={toggleFullscreen}
                  title="fullscreen (f)">{full ? "⤡" : "⛶"}</button>
          <button className="small" data-action={ANCHORS.screenClose}
                  title="close (esc)" onClick={close}>✕</button>
        </div>
      </div>

      {/* ---------------------------------------------------------- the picture */}
      <div style={{
        flex: 1, minHeight: 0, display: "flex", alignItems: "center",
        justifyContent: "center", position: "relative", padding: 8,
      }} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        {isClip ? (
          <video ref={videoRef} src={url} controls playsInline
                 muted={state.muted}
                 data-action={ANCHORS.screenVideo} data-rel={rel}
                 onPlay={() => screen.setPlaying(true)}
                 onPause={() => screen.setPlaying(false)}
                 onLoadedMetadata={(e) => {
                   const v = e.currentTarget;
                   if (Number.isFinite(v.duration)) setLen(v.duration);
                   if (state.t > 0 && Math.abs(v.currentTime - state.t) > 0.25) {
                     v.currentTime = state.t;
                   }
                 }}
                 style={{ maxWidth: "100%", maxHeight: `calc(100vh - ${CHROME}px)`,
                          background: "#000", borderRadius: 4 }} />
        ) : (
          <img src={url} alt={rel} data-action={ANCHORS.screenVideo} data-rel={rel}
               style={{ maxWidth: "100%", maxHeight: `calc(100vh - ${CHROME}px)`,
                        objectFit: "contain", borderRadius: 4 }} />
        )}
        {state.blocked && (
          <button data-action={ANCHORS.screenPlay}
                  onClick={() => { void play(); }}
                  title="your browser blocked autoplay, press play"
                  style={{
                    position: "absolute", inset: 0, margin: "auto", width: 116,
                    height: 116, borderRadius: "50%", fontSize: 44,
                    background: "rgba(8,10,15,0.72)", color: "#fff",
                    border: "2px solid #4b5563", cursor: "pointer",
                  }}>▶</button>
        )}
      </div>

      {/* ------------------------------------------------------ bottom chrome */}
      <div style={{ flexShrink: 0, padding: "6px 12px 10px",
                    borderTop: "1px solid #171c26" }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <button className="small" title="play / pause (space)"
                  data-action={ANCHORS.screenPlay}
                  onClick={() => { if (state.playing) pause(); else void play(); }}>
            {state.playing ? "⏸" : "▶"}</button>
          <input type="range" min={0} max={Math.max(1, Math.round(total * 10))}
                 value={Math.round(now * 10)} style={{ flex: 1 }}
                 data-action={ANCHORS.screenScrub}
                 onChange={(e) => seek(parseInt(e.target.value, 10) / 10)} />
          <code className="small" style={{ color: "#96a0b3", minWidth: 92,
                                           textAlign: "right" }}>
            {mmss(now)} / {mmss(total)}</code>
        </div>
        {!isClip && (
          <div style={{ height: 3, background: "#1b2230", borderRadius: 2,
                        marginTop: 4 }}>
            <div style={{ height: 3, width: `${pct}%`, background: "var(--accent, #3b82f6)",
                          borderRadius: 2 }} /></div>)}

        {chapters.length > 0 && (
          <div className="row" style={{ gap: 4, marginTop: 6, overflowX: "auto",
                                        flexWrap: "nowrap", paddingBottom: 2 }}>
            {chapters.map((c) => {
              const on = here?.sid === c.sid;
              return (
                <button key={c.sid} className="small"
                        data-action={ANCHORS.screenChapter} data-sid={c.sid}
                        data-start={c.start}
                        title={`${c.sid} · ${mmss(c.start)} · ${c.seconds}s`}
                        onClick={() => seek(c.start)}
                        style={{
                          flexShrink: 0, borderColor: on ? "var(--accent, #3b82f6)" : undefined,
                          color: on ? "#fff" : "#8d97aa",
                          background: on ? "rgba(59,130,246,0.18)" : "transparent",
                        }}>
                  {c.sid} <span style={{ opacity: 0.6 }}>{mmss(c.start)}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="muted small" style={{ marginTop: 4, color: "#5d6678" }}>
          space play/pause · ←/→ 5s · J/L 10s · K pause · , / . chapter · f fullscreen · esc close
        </div>
      </div>
    </div>
  );
}
