/**
 * The picks: select_take (what the monitor shows), set_keeper (the curated
 * plate) and set_timeline_source (what actually plays in the cut).
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import {
  IS_CLIP, IS_IMAGE, SHOT_ROUTE, asError, cut, fetchShot, lookupShot,
  openShotPage, pickTake, safeState,
} from "./util";

const TAKE_WORDS =
  "A path, or a word: \"latest\", \"newest still\", \"newest motion\", \"keeper\", \"plays\".";

// ---------------------------------------------------------------- select_take

interface SelectArgs { shot: string; take: string }

export const selectTake: ActionDef<SelectArgs> = {
  name: "select_take",
  title: "Select a take",
  description:
    "Put one take on the Shot Editor's monitor so the director can see it and so " +
    "the next edit acts on it. Accepts a take path or the words a director uses: " +
    "\"latest\", \"newest still\", \"newest motion\", \"keeper\" or \"plays\" (the one " +
    "in the timeline). The takes rail scrolls to it and the thumbnail pulses. Call " +
    "this before freeze_tail, trim_clip, set_keeper or a restyle when the director " +
    "says \"that one\" or \"the newest\". Returns the selected path, its kind and duration.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: TAKE_WORDS },
    },
    required: ["shot", "take"],
    additionalProperties: false,
  },
  annotations: {},
  where: { route: SHOT_ROUTE, anchor: ANCHORS.shotTake, label: "Shot Editor → takes rail" },
  keywords: ["select", "take", "this one", "that one", "newest", "latest", "pick", "monitor"],
  howTo: "Click the take's thumbnail in the takes rail under the monitor — the monitor switches to it.",
  summarize: (a) => `Select ${cut(a?.take, 26)} on ${cut(a?.shot, 22)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const hit = await pickTake(ctx, pid, detail, args?.take, {});
    if (!hit) {
      return err("take_not_found", {
        hint: `No take on ${shot.sid} matches “${cut(args?.take, 30)}”. ${TAKE_WORDS}`,
      });
    }

    const opened = await openShotPage(ctx, "select_take", pid, shot.sid, { take: hit.path });
    if (!opened.ok) return opened.res;
    const page = opened.page;
    page.selectTake(hit.path);
    await ctx.trail.step({
      tool: "select_take", title: `Select ${cut(hit.path.split("/").pop(), 32)}`,
      anchor: ANCHORS.shotTake, detail: hit.path,
    });

    const s = safeState(page);
    const meta = s.takes.find((t) => t.path === hit.path);
    return ok(`${cut(hit.path.split("/").pop(), 44)} is on the monitor`, {
      shot: shot.sid,
      selected: cut(hit.path, 70),
      kind: hit.kind,
      is_clip: IS_CLIP(hit.path),
      duration: meta?.duration ?? null,
      is_keeper: detail.keeper === hit.path,
      plays_in_timeline: detail.active_source === hit.path,
    });
  },
};

// ---------------------------------------------------------------- set_keeper

interface KeeperArgs { shot: string; take?: string; note?: string }

export const setKeeper: ActionDef<KeeperArgs> = {
  name: "set_keeper",
  title: "Set the keeper",
  description:
    "Mark a still as the shot's keeper — the curated plate everything else is " +
    "built on: comps stage on it, animate uses it, and the Film Editor shows it as " +
    "the chosen frame. Presses ★ keeper on the take. Stills only; motion clips are " +
    "refused (use set_timeline_source to choose what plays instead). Defaults to " +
    "the selected take. The previous keeper is kept in history, never overwritten. " +
    "Optionally records a curation note.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: `Which still to keep. ${TAKE_WORDS} Defaults to the selected take.` },
      note: { type: "string", description: "Optional curation note recorded with the pick, e.g. \"best eyeline, hands read\"." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, anchor: ANCHORS.takeKeeper, label: "Shot Editor → take → ★ keeper" },
  keywords: ["keeper", "star", "plate", "curate", "pick", "approve", "chosen", "hero frame"],
  howTo: "Click a still in the takes rail, then press ★ keeper in the row of buttons under the monitor.",
  summarize: (a) => `Set the keeper on ${cut(a?.shot, 26)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const hit = await pickTake(ctx, pid, detail, args?.take, { prefer: "image" });
    if (!hit) {
      return err("take_not_found", {
        hint: `No still on ${shot.sid} matches “${cut(args?.take ?? "the selection", 30)}”. Generate one first, or pass a path.`,
      });
    }
    if (!IS_IMAGE(hit.path)) {
      return err("keeper_must_be_a_still", {
        take: cut(hit.path, 60),
        hint: "The keeper is the plate, so it has to be an image. For a clip, use set_timeline_source.",
      });
    }

    const previous = detail.keeper ?? null;
    const opened = await openShotPage(ctx, "set_keeper", pid, shot.sid, { take: hit.path });
    if (!opened.ok) return opened.res;
    const page = opened.page;
    page.selectTake(hit.path);
    await ctx.trail.step({
      tool: "set_keeper", title: `★ keeper — ${cut(hit.path.split("/").pop(), 30)}`,
      anchor: ANCHORS.takeKeeper, detail: hit.path,
    });

    try { await page.setKeeper(hit.path, args?.note); }
    catch (e) { return asError(e, "keeper_rejected", "The server refused the keeper"); }
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${shot.sid} keeper is now ${cut(hit.path.split("/").pop(), 40)}`, {
      shot: shot.sid,
      keeper: cut(hit.path, 70),
      previous_keeper: previous ? cut(previous, 70) : null,
      ...(args?.note ? { note: cut(args.note, 90) } : {}),
      hint: previous ? "The old keeper is still in the takes rail — nothing was overwritten." : undefined,
    });
  },
};

// ---------------------------------------------------------------- set_timeline_source

interface SourceArgs { shot: string; take?: string; clear?: boolean }

export const setTimelineSource: ActionDef<SourceArgs> = {
  name: "set_timeline_source",
  title: "Set what plays",
  description:
    "Choose which take actually plays for this shot in the cut — the ⬆ timeline " +
    "source override. Any take works: a still, a restyle, a motion clip or a " +
    "frozen one. Presses ⬆ on the take, and the Film Editor immediately shows the " +
    "new pick. Pass clear:true to drop the override and fall back to the shot's " +
    "default (keeper, or the newest motion). Defaults to the selected take. Run " +
    "cut_film afterwards to see it in a rendered cut.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: `Which take should play. ${TAKE_WORDS} Defaults to the selected take.` },
      clear: { type: "boolean", description: "True removes the override so the shot falls back to its default source." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, anchor: ANCHORS.takeSource, label: "Shot Editor → take → ⬆ timeline source" },
  keywords: ["timeline", "source", "plays", "use this", "override", "in the cut", "playing"],
  howTo:
    "Select a take and press ⬆ timeline source under the monitor — or click a thumbnail " +
    "in the Film Editor's \"what plays\" strip for that shot.",
  summarize: (a) => (a?.clear ? `Clear the source override on ${cut(a?.shot, 24)}`
    : `Play ${cut(a?.take ?? "the selected take", 22)} on ${cut(a?.shot, 22)}`),
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const clearing = args?.clear === true ||
      (typeof args?.take === "string" && /^(none|clear|default|off)$/i.test(args.take.trim()));

    const opened = await openShotPage(ctx, "set_timeline_source", pid, shot.sid,
      clearing ? {} : { take: undefined });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    if (clearing) {
      await ctx.trail.step({
        tool: "set_timeline_source", title: "Clear the source override", anchor: ANCHORS.takeSource,
      });
      try { await page.setSource(null); }
      catch (e) { return asError(e, "source_rejected", "The server refused the change"); }
      try { await page.refresh(); } catch { /* fine */ }
      return ok(`${shot.sid} is back to its default source`, {
        shot: shot.sid, plays: null, previous: detail.active_source ? cut(detail.active_source, 60) : null,
      });
    }

    const hit = await pickTake(ctx, pid, detail, args?.take, {});
    if (!hit) {
      return err("take_not_found", {
        hint: `No take on ${shot.sid} matches “${cut(args?.take ?? "the selection", 30)}”. ${TAKE_WORDS}`,
      });
    }
    page.selectTake(hit.path);
    await ctx.trail.step({
      tool: "set_timeline_source", title: `⬆ timeline source — ${cut(hit.path.split("/").pop(), 28)}`,
      anchor: ANCHORS.takeSource, detail: hit.path,
    });

    try { await page.setSource(hit.path); }
    catch (e) { return asError(e, "source_rejected", "The server refused the change"); }
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${shot.sid} now plays ${cut(hit.path.split("/").pop(), 40)}`, {
      shot: shot.sid,
      plays: cut(hit.path, 70),
      kind: hit.kind,
      previous: detail.active_source && detail.active_source !== hit.path
        ? cut(detail.active_source, 60) : null,
      hint: "Call cut_film to render a cut with this pick in it.",
    });
  },
};
