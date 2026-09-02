/**
 * The screening-room store: one tiny observable, so anything can say
 * "put this on the big screen" without owning a player.
 *
 * The room (`components/ScreeningRoom.tsx`) subscribes, renders the overlay and
 * `attach()`es the real <video> back. Callers (the Cuts gallery, the take rail,
 * the `play_cut` / `play_take` tools) only ever touch this module, so a tool
 * works the same whether the room happens to be mounted yet or not: requests
 * made before the player attaches are held in the state and applied on attach.
 *
 * Owned by workstream M. See docs/WEBMCP-PLAN.md §4.
 */
import type { Chapter } from "../agent/contract";

export interface ScreenPlayer {
  currentTime(): number;
  duration(): number;
  seek(t: number): void;
  /** Resolves false when the browser refused to start (autoplay policy). */
  play(): Promise<boolean>;
  pause(): void;
}

export interface ScreenState {
  open: boolean;
  pid: string | null;
  /** Project-relative media path: a cut, a take clip, or a still. */
  rel: string | null;
  /** The seek the room should honour; `seq` bumps even when `t` repeats. */
  t: number;
  seq: number;
  autoplay: boolean;
  muted: boolean;
  /** True once the browser has refused to start playback. */
  blocked: boolean;
  playing: boolean;
  /** Stop and hold here (the `to` argument of play_cut). */
  stopAt: number | null;
  chapters: Chapter[];
  /** Known length: the cut's total, or a still's hold. */
  seconds: number | null;
  label: string | null;
}

export interface OpenOptions {
  pid?: string | null;
  t?: number;
  chapters?: Chapter[];
  seconds?: number | null;
  muted?: boolean;
  autoplay?: boolean;
  stopAt?: number | null;
  label?: string | null;
}

const EMPTY: ScreenState = {
  open: false, pid: null, rel: null, t: 0, seq: 0, autoplay: true, muted: false,
  blocked: false, playing: false, stopAt: null, chapters: [], seconds: null,
  label: null,
};

let state: ScreenState = { ...EMPTY };
const listeners = new Set<(s: ScreenState) => void>();
let player: ScreenPlayer | null = null;
let waiters: ((p: ScreenPlayer) => void)[] = [];

function set(patch: Partial<ScreenState>): ScreenState {
  state = { ...state, ...patch };
  for (const l of [...listeners]) { try { l(state); } catch { /* never break a publish */ } }
  return state;
}

export function state_(): ScreenState { return state; }
/** The contract name the tools and the page handles use. */
export const screenState = state_;

export function subscribe(l: (s: ScreenState) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Put `rel` on the big screen. Safe before the room has mounted. */
export function open(rel: string, opts: OpenOptions = {}): ScreenState {
  const t = Number.isFinite(opts.t) ? Math.max(0, Number(opts.t)) : 0;
  const next = set({
    open: true,
    rel,
    pid: opts.pid ?? state.pid,
    t,
    seq: state.seq + 1,
    chapters: opts.chapters ?? (rel === state.rel ? state.chapters : []),
    seconds: opts.seconds ?? (rel === state.rel ? state.seconds : null),
    muted: opts.muted ?? false,
    autoplay: opts.autoplay !== false,
    stopAt: opts.stopAt ?? null,
    label: opts.label ?? null,
    blocked: false,
    playing: false,
  });
  if (player) { player.seek(t); }
  return next;
}

export function close(): void {
  player = null;
  waiters = [];
  set({ ...EMPTY, pid: state.pid, seq: state.seq + 1 });
}

export function seek(t: number): void {
  const at = Math.max(0, Number(t) || 0);
  set({ t: at, seq: state.seq + 1 });
  player?.seek(at);
}

/** Resolves false when the browser refused (the room then shows a big ▶). */
export async function play(): Promise<boolean> {
  set({ autoplay: true });
  if (!player) return false;
  const started = await player.play().catch(() => false);
  set({ blocked: !started, playing: started });
  return started;
}

export function pause(): void {
  player?.pause();
  set({ playing: false });
}

export function setChapters(chapters: Chapter[], seconds?: number | null): void {
  set({ chapters, ...(seconds === undefined ? {} : { seconds }) });
}

export function setBlocked(blocked: boolean): void { set({ blocked, playing: !blocked && state.playing }); }
export function setPlaying(playing: boolean): void { set({ playing, ...(playing ? { blocked: false } : {}) }); }

/** The room hands its <video> over here. Returns the detacher. */
export function attach(p: ScreenPlayer): () => void {
  player = p;
  const pending = waiters;
  waiters = [];
  for (const w of pending) { try { w(p); } catch { /* ignore */ } }
  return () => { if (player === p) player = null; };
}

export function currentPlayer(): ScreenPlayer | null { return player; }

/**
 * Wait for the room's player. Resolves null on timeout rather than throwing:
 * a tool that cannot reach the element still succeeded at opening the room.
 */
export function waitForPlayer(timeoutMs = 2000): Promise<ScreenPlayer | null> {
  if (player) return Promise.resolve(player);
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: ScreenPlayer | null) => {
      if (done) return;
      done = true;
      waiters = waiters.filter((w) => w !== onAttach);
      resolve(p);
    };
    const onAttach = (p: ScreenPlayer) => finish(p);
    waiters.push(onAttach);
    setTimeout(() => finish(player), timeoutMs);
  });
}

/** Test seam: wipe every listener and the attached player. */
export function __reset(): void {
  listeners.clear();
  player = null;
  waiters = [];
  state = { ...EMPTY };
}
