import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { mediaUrl } from "../api";
import { ANCHORS } from "../agent/contract";
import {
  type AudioPlan, ShotMixer, bufferLoader, describeTracks,
} from "../audio/shotMix";
import { usePoll } from "../hooks";

/**
 * The Shot Editor monitor, with the shot's audio under it.
 *
 * The assembler only mixes narration, the bed and the SFX when it cuts, so a
 * take used to play silent here and a still had no preview at all. This asks
 * the server for the shot's audio plan (the same placement the cut uses) and
 * plays it through `ShotMixer`, locked to whichever transport is on screen:
 * the `<video>` for a clip take, a held-frame timer for a still.
 *
 * The AudioContext is built on the reviewer's first click — browsers will not
 * let a page make noise before that.
 */

const VIDEO = [".mp4", ".webm", ".mov"];
const AUDIO = [".wav", ".mp3", ".m4a"];
const STORE_KEY = "cutroom_shot_audio";

const isKind = (rel: string | null, exts: string[]) =>
  !!rel && exts.some((e) => rel.toLowerCase().endsWith(e));

function readPref(): boolean {
  try { return localStorage.getItem(STORE_KEY) !== "0"; } catch { return true; }
}

export default function ShotMonitor({ pid, sid, rel, seconds }: {
  pid: string; sid: string; rel: string | null; seconds: number;
}) {
  const [on, setOn] = useState(readPref);
  const [ready, setReady] = useState(false);      // an AudioContext exists
  const [held, setHeld] = useState(0);            // still transport, seconds
  const [holding, setHolding] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const mixRef = useRef<ShotMixer | null>(null);
  const rafRef = useRef<number | null>(null);

  const { data: plan } = usePoll<AudioPlan>(
    `/api/projects/${pid}/shots/${sid}/audio-plan`, 0);

  const isClip = isKind(rel, VIDEO);
  const isStill = !!rel && !isClip && !isKind(rel, AUDIO);
  const span = Math.max(0.1, Number(plan?.seconds || seconds) || 3);
  const tracks = useMemo(() => describeTracks(plan), [plan]);
  const hasAudio = !!(plan && (plan.vo || plan.music.length || plan.sfx.length));

  // --- the mixer -------------------------------------------------------
  /** Build (or resume) the AudioContext. Must run inside a user gesture. */
  const ensureAudio = useCallback(async () => {
    if (!mixRef.current) {
      mixRef.current = new ShotMixer({
        load: async (p) => {
          const ctx = ctxRef.current!;
          return bufferLoader(ctx, (x) => mediaUrl(pid, x))(p);
        },
      });
    }
    const mix = mixRef.current;
    await mix.resume(() => {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctor();
      ctxRef.current = ctx;
      return ctx;
    });
    setReady(!!ctxRef.current);
    return mix;
  }, [pid]);

  useEffect(() => () => { mixRef.current?.dispose(); mixRef.current = null; }, []);

  useEffect(() => { mixRef.current?.setPlan(on ? (plan ?? null) : null); },
            [plan, on]);
  useEffect(() => { mixRef.current?.setEnabled(on); }, [on]);

  // Lock the mix to the video whenever a clip take is on screen.
  useEffect(() => {
    const el = videoRef.current;
    const mix = mixRef.current;
    if (!el || !mix || !on || !ready) return;
    return mix.attach(el);
  }, [rel, on, ready, plan]);

  // --- the still's held-frame transport --------------------------------
  const stopHold = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setHolding(false);
    mixRef.current?.pause();
  }, []);

  const playHold = useCallback(async () => {
    const mix = on ? await ensureAudio() : null;
    stopHold();
    const t0 = performance.now();
    setHeld(0);
    setHolding(true);
    mix?.setPlan(plan ?? null);
    void mix?.play(0);
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= span) { setHeld(span); stopHold(); return; }
      setHeld(t);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [on, ensureAudio, plan, span, stopHold]);

  useEffect(() => { stopHold(); setHeld(0); }, [rel, stopHold]);

  // --- the toggle -------------------------------------------------------
  const toggle = async () => {
    const next = !on;
    setOn(next);
    try { localStorage.setItem(STORE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
    if (next) {
      const mix = await ensureAudio();
      mix.setPlan(plan ?? null);
      mix.setEnabled(true);
      const el = videoRef.current;
      if (el && !el.paused) void mix.play(el.currentTime);
    } else {
      mixRef.current?.pause();
    }
  };

  // A click anywhere on the monitor is the gesture the browser wants.
  const wake = () => { if (on && !ready) void ensureAudio(); };

  const body = !rel ? (
    <div className="monitor" style={{ aspectRatio: "16/9", display: "flex",
      alignItems: "center", justifyContent: "center", color: "var(--dim)" }}>
      no source
    </div>
  ) : isClip ? (
    <div className="monitor" onClick={wake}>
      <video key={mediaUrl(pid, rel)} ref={videoRef} src={mediaUrl(pid, rel)}
             controls loop autoPlay muted />
    </div>
  ) : isKind(rel, AUDIO) ? (
    <audio key={mediaUrl(pid, rel)} src={mediaUrl(pid, rel)} controls
           style={{ width: "100%" }} />
  ) : (
    <div className="monitor" onClick={wake} style={{ position: "relative" }}>
      <img src={mediaUrl(pid, rel)} alt={rel} />
      {holding && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0,
                      height: 4, background: "rgba(255,255,255,.15)" }}>
          <div data-action={ANCHORS.monitorProgress}
               style={{ height: "100%", width: `${(held / span) * 100}%`,
                        background: "var(--accent, #7dd3fc)" }} />
        </div>
      )}
    </div>
  );

  return (
    <div className="col" style={{ gap: 6 }}>
      {body}
      <div className="row small" style={{ gap: 8, alignItems: "center" }}>
        {isStill && (
          <button className="small" data-action={ANCHORS.monitorPlayStill}
                  title={`play the held frame for ${span.toFixed(1)}s with its mix`}
                  onClick={() => (holding ? stopHold() : void playHold())}>
            {holding ? "■ stop" : "▶ play still"}
          </button>
        )}
        <button className={`small ${on ? "primary" : ""}`}
                data-action={ANCHORS.monitorAudio}
                aria-pressed={on}
                title={on ? "monitor audio on — VO, bed and SFX play under the take"
                          : "monitor audio off — the take plays silent"}
                onClick={() => void toggle()}>
          {on ? "🔊 audio" : "🔇 audio"}
        </button>
        <span className="muted" data-action={ANCHORS.monitorTracks}
              style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                       whiteSpace: "nowrap" }}>
          {hasAudio ? tracks : "nothing under this shot yet"}
          {holding && ` · ${held.toFixed(1)}s / ${span.toFixed(1)}s`}
        </span>
      </div>
    </div>
  );
}
