/**
 * Agent presence — the trail store, the pulse, the drawer and the topbar chip.
 *
 * Tools execute THROUGH the UI: every step is stamped here, the anchor it touched is pulsed
 * on screen, and the human can replay the run from the drawer. Pacing is `ctx.speed`:
 * "watch" (default) adds ~350 ms per visible step so a person can follow; "fast" is for tests.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.3.
 */
import { useEffect, useState } from "react";
import type { Anchor, Speed, Trail, TrailStep } from "./contract";
import { subscribeAgentStatus, type AgentStatus } from "./webmcp";
import { ROUTES } from "../routes";

// ------------------------------------------------------------------ speed

const SPEED_KEY = "cutroom_agent_speed";

function readSpeed(): Speed {
  try {
    const q = new URLSearchParams(window.location.search).get("agent_speed");
    if (q === "fast" || q === "watch") { localStorage.setItem(SPEED_KEY, q); return q; }
    const s = localStorage.getItem(SPEED_KEY);
    if (s === "fast" || s === "watch") return s;
  } catch { /* SSR / no storage */ }
  return "watch";
}

let speed: Speed = typeof window === "undefined" ? "fast" : readSpeed();

export function getSpeed(): Speed { return speed; }
export function setSpeed(s: Speed) {
  speed = s;
  try { localStorage.setItem(SPEED_KEY, s); } catch { /* ignore */ }
  emit();
}

const PACE: Record<Speed, number> = { watch: 350, fast: 0 };

// ------------------------------------------------------------------ pulse

const PULSE_MS = 1200;

/**
 * Scroll a control into view and ring it. Accepts a raw anchor ("shot.gen.still.submit"),
 * an anchor plus data narrowing ('shot.take[data-path="…"]') or a full CSS selector.
 */
export function pulse(anchorOrSelector: string | null | undefined): Element | null {
  if (!anchorOrSelector || typeof document === "undefined") return null;
  const sel = anchorOrSelector.startsWith("[") || anchorOrSelector.includes("[data-action")
    ? anchorOrSelector
    : anchorOrSelector.includes("[")
      ? `[data-action="${anchorOrSelector.slice(0, anchorOrSelector.indexOf("["))}"]` +
        anchorOrSelector.slice(anchorOrSelector.indexOf("["))
      : `[data-action="${anchorOrSelector}"]`;
  let el: Element | null = null;
  try { el = document.querySelector(sel); } catch { return null; }
  if (!el) return null;
  try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); }
  catch { /* jsdom */ }
  el.classList.remove("agent-pulse");
  // force reflow so a repeat pulse restarts the animation
  void (el as HTMLElement).offsetWidth;
  el.classList.add("agent-pulse");
  setTimeout(() => el?.classList.remove("agent-pulse"), PULSE_MS);
  return el;
}

// ------------------------------------------------------------------ trail store

type TrailListener = () => void;
const trailListeners = new Set<TrailListener>();
let steps: TrailStep[] = [];
let seq = 0;
let open = false;

function emit() { for (const l of [...trailListeners]) { try { l(); } catch { /* ignore */ } } }

function subscribe(l: TrailListener): () => void {
  trailListeners.add(l);
  return () => { trailListeners.delete(l); };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const trail: Trail = {
  async step(s) {
    const entry: TrailStep = { id: `s${++seq}`, t: Date.now(), ...s };
    steps = [...steps, entry].slice(-200);
    emit();
    if (entry.anchor) pulse(entry.anchor);
    // Always yield at least a macrotask so React has flushed the state the step just set
    // before the next step reads it back through `getState()`.
    await sleep(PACE[speed] ?? 0);
  },
  steps() { return steps; },
  clear() { steps = []; emit(); },
};

export function trailOpen(): boolean { return open; }
export function setTrailOpen(v: boolean) { open = v; emit(); }
export function toggleTrail() { open = !open; emit(); }

function useTrail() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return { steps, open, speed };
}

// ------------------------------------------------------------------ topbar chip

const MODE_LABEL: Record<AgentStatus["mode"], string> = {
  native: "native", polyfill: "polyfill", unavailable: "unavailable",
};

/** "🤖 16 tools · native" — click to open the trail. */
export function AgentChip() {
  const [status, setStatus] = useState<AgentStatus>(
    () => ({ mode: "unavailable", tools: 0 }));
  const t = useTrail();
  useEffect(() => subscribeAgentStatus(setStatus), []);
  const title = status.mode === "unavailable"
    ? "WebMCP is not available here (needs https:// or localhost, and Chrome " +
      "--enable-features=WebMCP). The ⌘K palette and the debug hook still work."
    : `WebMCP tools registered on document.modelContext (${MODE_LABEL[status.mode]})`;
  return (
    <button className={`chip agent-chip ${t.open ? "on" : ""}`} title={title}
            data-action="app.agent.chip" onClick={toggleTrail}>
      <span aria-hidden>🤖</span>
      <span>{status.tools} tools</span>
      <span className="muted">·</span>
      <span className={status.mode === "unavailable" ? "bad" : "ok"}>
        {MODE_LABEL[status.mode]}
      </span>
      {t.steps.length > 0 && <span className="agent-count">{t.steps.length}</span>}
    </button>
  );
}

// ------------------------------------------------------------------ drawer

const clock = (t: number) => new Date(t).toLocaleTimeString([], {
  hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Bottom-right collapsible "Agent trail". Clicking a step re-pulses its anchor. */
export function AgentTrail() {
  const t = useTrail();
  if (!t.open && t.steps.length === 0) return null;
  if (!t.open) {
    return (
      <button className="agent-trail collapsed" onClick={() => setTrailOpen(true)}
              title="show the agent trail">
        🤖 agent trail · {t.steps.length}
      </button>
    );
  }
  return (
    <div className="agent-trail">
      <div className="agent-trail-head">
        <b>Agent trail</b>
        <span className="muted small">{t.steps.length} steps</span>
        <div style={{ flex: 1 }} />
        <button className="small" title="watch = paced so a human can follow"
                onClick={() => setSpeed(t.speed === "watch" ? "fast" : "watch")}>
          {t.speed === "watch" ? "◐ watch" : "⚡ fast"}
        </button>
        <button className="small" onClick={() => trail.clear()}>clear</button>
        <button className="small" onClick={() => setTrailOpen(false)}>▾</button>
      </div>
      <div className="agent-trail-body">
        {t.steps.length === 0 && (
          <div className="muted small" style={{ padding: 8 }}>
            nothing yet — ask an agent to drive, or press ⌘K
          </div>
        )}
        {[...t.steps].reverse().map((s) => (
          <div key={s.id} className={`agent-step ${s.anchor ? "clickable" : ""}`}
               onClick={() => s.anchor && pulse(s.anchor)}
               title={s.anchor ? "re-pulse this control" : undefined}>
            <span className="agent-step-t muted small">{clock(s.t)}</span>
            <span className="agent-step-main">
              <b>{s.title}</b>
              {s.detail && <span className="muted small"> — {s.detail}</span>}
            </span>
            <span className="agent-step-tool muted small">{s.tool}</span>
            {s.job && <a className="small" href={ROUTES.jobs}
                         onClick={(e) => e.stopPropagation()}>job →</a>}
          </div>
        ))}
      </div>
    </div>
  );
}
