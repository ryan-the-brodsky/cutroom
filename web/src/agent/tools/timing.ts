/**
 * When things happen: `set_shot_timing` (the Film Editor's quick panel — duration,
 * VO offset, mute) and `move_audio` (the Timeline's drag, asked for in words).
 */
import type { ActionDef, AudioMoveResult, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { ROUTES } from "../../routes";
import {
  FILM_ROUTE, NEXT_CUT_FILM, asError, cut, lookupShot, maybeNum, openFilmPage,
  touchTimeline,
} from "./util";

const TIMELINE_ROUTE = ROUTES.timeline;

const clock = (s: number | null | undefined): string => {
  if (s == null || !Number.isFinite(s)) return "—";
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};

interface TimingArgs {
  shot: string;
  seconds?: number;
  vo_offset?: number;
  mute_vo?: boolean;
}

export const setShotTiming: ActionDef<TimingArgs> = {
  name: "set_shot_timing",
  title: "Set shot timing",
  description:
    "Retime a shot in the cut: how many seconds it holds, how far its voice-over " +
    "slides against the picture, and whether the VO is muted. Opens the Film " +
    "Editor, selects the shot and edits its quick panel, so the strip re-widths in " +
    "front of the director. Positive vo_offset delays the line, negative pulls it " +
    "earlier. Anything you leave out is left alone. Takes effect on the next " +
    "cut_film. Returns the resulting override.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      seconds: { type: "number", description: "How long the shot holds in the cut, in seconds. Overrides the scripted duration." },
      vo_offset: { type: "number", description: "Seconds to slide the voice-over: positive delays the line, negative pulls it earlier." },
      mute_vo: { type: "boolean", description: "True silences this shot's voice-over in the cut; false restores it." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: FILM_ROUTE, anchor: ANCHORS.quickSeconds,
    label: "Film Editor → selected shot → seconds / VO offset / mute",
  },
  keywords: ["timing", "seconds", "duration", "hold", "vo offset", "sync", "mute", "retime", "longer", "shorter"],
  howTo:
    "Click the shot in the Film Editor strip and edit \"seconds\", \"VO offset\" or " +
    "\"mute VO\" in the panel that opens below it — the fields commit when they lose focus.",
  summarize: (a) => {
    const bits = [
      maybeNum(a?.seconds) !== undefined ? `${a!.seconds}s` : null,
      maybeNum(a?.vo_offset) !== undefined ? `VO ${a!.vo_offset}s` : null,
      a?.mute_vo !== undefined ? (a.mute_vo ? "mute VO" : "unmute VO") : null,
    ].filter(Boolean);
    return `Retime ${cut(a?.shot, 24)}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
  },
  async execute(args, ctx): Promise<ToolResult> {
    const seconds = maybeNum(args?.seconds);
    const voOffset = maybeNum(args?.vo_offset);
    const mute = typeof args?.mute_vo === "boolean" ? args.mute_vo : undefined;
    if (seconds === undefined && voOffset === undefined && mute === undefined) {
      return err("nothing_to_set", {
        hint: "Pass at least one of seconds, vo_offset or mute_vo.",
      });
    }
    if (seconds !== undefined && seconds <= 0) {
      return err("bad_seconds", { hint: "seconds must be greater than 0." });
    }

    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const opened = await openFilmPage(ctx, "set_shot_timing", pid, { sel: shot.sid });
    if (!opened.ok) return opened.res;
    const page = opened.page;
    page.selectShot(shot.sid);

    const patch: Record<string, unknown> = {};
    if (seconds !== undefined) {
      patch.seconds = seconds;
      await ctx.trail.step({
        tool: "set_shot_timing", title: `${shot.sid} holds ${seconds}s`,
        anchor: ANCHORS.quickSeconds,
      });
    }
    if (voOffset !== undefined) {
      patch.vo_offset = voOffset;
      await ctx.trail.step({
        tool: "set_shot_timing",
        title: `VO offset ${voOffset > 0 ? "+" : ""}${voOffset}s`,
        anchor: ANCHORS.quickVoOffset,
      });
    }
    if (mute !== undefined) {
      // The server drops null-valued override keys, which is how "unmute" works.
      patch.mute_vo = mute ? true : null;
      await ctx.trail.step({
        tool: "set_shot_timing", title: mute ? "Mute the VO" : "Unmute the VO",
        anchor: ANCHORS.quickMute,
      });
    }

    try { await page.setOverride(shot.sid, patch); }
    catch (e) { return asError(e, "override_rejected", "The server refused the timing change"); }
    try { await page.refresh(); } catch { /* fine */ }
    touchTimeline(pid);

    const applied: Record<string, unknown> = {};
    if (seconds !== undefined) applied.seconds = seconds;
    if (voOffset !== undefined) applied.vo_offset = voOffset;
    if (mute !== undefined) applied.mute_vo = mute;

    const bits = Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(", ");
    return ok(`${shot.sid} retimed — ${bits}`, {
      shot: shot.sid,
      applied,
      hint: "Run cut_film to hear and see it in a rendered cut.",
      next: NEXT_CUT_FILM,
    });
  },
};

// ---------------------------------------------------------------- move_audio

interface MoveAudioArgs {
  project?: string;
  target: string;
  at?: number;
  delta?: number;
  snap?: boolean;
}

export const moveAudio: ActionDef<MoveAudioArgs> = {
  name: "move_audio",
  title: "Move audio on the timeline",
  description:
    "Slide one piece of audio along the film — a shot's voice-over, or a music " +
    "or SFX cue — the way dragging it on the Timeline does. `at` puts it that " +
    "many seconds into the film; `delta` slides it from where it sits (negative " +
    "pulls it earlier). Use it to lift a cue off a line it is stepping on: the " +
    "result says where it landed and what it still overlaps. A shot's lines " +
    "share one offset, so they travel together.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "What to move: a shot id for its VO, a cue id from list_cues, or part of the file name." },
      at: { type: "number", description: "Put it this many seconds into the film. Wins over delta." },
      delta: { type: "number", description: "Slide it this many seconds from where it is now; negative pulls it earlier." },
      snap: { type: "boolean", description: "Let it land on a cut or the playhead when it is close (default true)." },
      project: { type: "string", description: "Project id. Defaults to the film that is open." },
    },
    required: ["target"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: TIMELINE_ROUTE, anchor: ANCHORS.timelineAudioDrag,
    label: "Timeline → the A1 / MUSIC / SFX lanes",
  },
  keywords: ["move", "slide", "drag", "audio", "vo", "cue", "sfx", "music",
             "overlap", "later", "earlier", "timing", "sync"],
  howTo:
    "Drag the clip along its A1 / MUSIC / SFX lane on the Timeline — it snaps to " +
    "cuts and to the playhead, shows the new time as you go, and Esc cancels.",
  summarize: (a) => {
    const where = maybeNum(a?.at) !== undefined ? `to ${a!.at}s`
      : maybeNum(a?.delta) !== undefined ? `by ${a!.delta}s` : "";
    return `Move ${cut(a?.target, 24)} ${where}`.trim();
  },
  async execute(args, ctx): Promise<ToolResult> {
    const pid = args?.project || ctx.project;
    if (!pid) return err("no_project", { hint: "Open a film first, or call get_context." });
    const target = String(args?.target ?? "").trim();
    if (!target) {
      return err("needs_target", {
        hint: "Say what to move: a shot id for its VO, or a cue id from list_cues.",
      });
    }
    const at = maybeNum(args?.at);
    const delta = maybeNum(args?.delta);
    if (at === undefined && delta === undefined) {
      return err("needs_place", {
        hint: "Pass `at` (film seconds) or `delta` (seconds to slide it).",
      });
    }

    const url = ROUTES.timeline.replace(":pid", pid);
    let page;
    try {
      await ctx.nav(url);
      page = await ctx.page.waitFor("timeline");
    } catch (e) {
      return err("page_did_not_mount", {
        hint: `Could not open the Timeline: ${cut((e as Error)?.message, 90)}.`,
      });
    }

    let res: AudioMoveResult;
    try {
      res = await page.moveAudio({
        target, ...(at !== undefined ? { at } : {}),
        ...(delta !== undefined ? { delta } : {}),
        ...(args?.snap === false ? { snap: false } : {}),
      });
    } catch (e) {
      return asError(e, "move_failed", "The move was refused");
    }
    if (!res?.ok) {
      return err(res?.error || "move_failed", {
        hint: res?.hint || "Nothing moved.",
        ...(res?.candidates?.length ? { candidates: res.candidates.slice(0, 8) } : {}),
      });
    }
    await ctx.trail.step({
      tool: "move_audio",
      title: `${res.clip} → ${clock(res.to)}`,
      anchor: ANCHORS.timelineAudioDrag,
      detail: res.snapped_to ? `snapped to ${res.snapped_to}` : undefined,
    });

    const overlaps = (res.overlaps || []).slice(0, 4);
    return ok(
      `${res.clip} now starts at ${clock(res.to)}` +
      (overlaps.length ? `, still under ${overlaps[0].clip}` : ", clear of the other audio"),
      {
        moved: res.clip,
        track: res.track,
        from: res.from,
        to: res.to,
        ...(res.snapped_to ? { snapped_to: res.snapped_to } : {}),
        ...(res.shot ? { shot: res.shot, vo_offset: res.vo_offset } : {}),
        ...(res.lines && res.lines > 1 ? { lines_moved: res.lines } : {}),
        ...(res.cue ? { cue: res.cue } : {}),
        overlaps: overlaps.length
          ? overlaps.map((o) => `${cut(o.clip, 24)} ${clock(o.start)}–${clock(o.end)}`)
          : "none",
        hint: res.shot
          ? "A line moved late can stretch its shot when the film is cut (audio-fit). cut_film to hear it."
          : "cut_film to hear it; preview_timeline plays it without a render.",
        next: NEXT_CUT_FILM,
      },
    );
  },
};
