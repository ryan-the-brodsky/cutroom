/**
 * set_shot_timing — the Film Editor's quick panel: duration, VO offset, mute.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { FILM_ROUTE, asError, cut, lookupShot, maybeNum, openFilmPage } from "./util";

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

    const applied: Record<string, unknown> = {};
    if (seconds !== undefined) applied.seconds = seconds;
    if (voOffset !== undefined) applied.vo_offset = voOffset;
    if (mute !== undefined) applied.mute_vo = mute;

    const bits = Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(", ");
    return ok(`${shot.sid} retimed — ${bits}`, {
      shot: shot.sid,
      applied,
      hint: "Run cut_film to hear and see it in a rendered cut.",
    });
  },
};
