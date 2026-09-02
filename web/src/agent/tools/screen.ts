/**
 * The screening room tools: watching, as one call.
 *
 * "Play the film" used to end in a thumbnail-sized <video> in the Cuts gallery,
 * because that was the only playback surface an agent could reach. These three
 * open the full-screen room instead, and they take the words a director uses
 * for a place in the film: a second, "1:05", a shot sid, "act2", or a
 * description the resolver knows ("the lighthouses").
 *
 * `preview_timeline` is the fourth, and the other half of the same problem: the
 * Timeline's live preview had a real transport nothing could ask for.
 *
 * Owned by workstream M. See docs/WEBMCP-PLAN.md §4.
 */
import type {
  ActionContext, ActionDef, Chapter, ToolResult,
} from "../contract";
import { ANCHORS, err, ok } from "../contract";
import * as screen from "../../screen/store";
import { ROUTES, timelinePath } from "../../routes";
import {
  chapterAt, chapterOf, fetchChapters, mmss, parseFrom, totalOf,
} from "../../screen/edl";
import {
  FILM_ROUTE, SHOT_ROUTE, basename, cut, fetchShot, filmUrl, lookupShot,
  openFilmPage, pickTake,
} from "./util";

const TIMELINE_ROUTE = ROUTES.timeline;

const FROM_WORDS =
  "Where to start: seconds (65), \"1:05\", a shot sid (\"B03-S2\"), \"act2\", " +
  "\"start\", \"end\", or a description of the shot.";

// ---------------------------------------------------------------- shared plumbing

interface CutRow { path: string; created_at?: number; meta?: { total?: number } }

/** Newest-first animatic takes for the project. */
async function listCuts(ctx: ActionContext, pid: string): Promise<CutRow[]> {
  try {
    const rows = await ctx.api<CutRow[]>(
      `/api/projects/${pid}/takes?kind=animatic&limit=25`);
    return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.path === "string");
  } catch { return []; }
}

/**
 * `cut` the way a director names one: nothing / "latest", an index from newest
 * (1 = newest), a file name, or a full rel path.
 */
export function pickCut(rows: CutRow[], want: unknown): CutRow | null {
  if (!rows.length) return null;
  if (want === undefined || want === null || want === "") return rows[0];
  if (typeof want === "number" && Number.isFinite(want)) {
    return rows[Math.max(0, Math.min(rows.length - 1, Math.round(want) - 1))] ?? null;
  }
  const s = String(want).trim();
  const word = s.toLowerCase();
  if (/^(the )?(latest|newest|last|current|it|this)$/.test(word)) return rows[0];
  if (/^(the )?(oldest|first)$/.test(word)) return rows[rows.length - 1];
  if (/^\d+$/.test(word)) {
    return rows[Math.max(0, Math.min(rows.length - 1, parseInt(word, 10) - 1))] ?? null;
  }
  return rows.find((r) => r.path === s)
    ?? rows.find((r) => basename(r.path) === basename(s))
    ?? rows.find((r) => basename(r.path).toLowerCase().includes(word))
    ?? null;
}

/** sid → act, for "act2". One film fetch, only when an act word shows up. */
async function actLookup(ctx: ActionContext, pid: string) {
  try {
    const rows = await ctx.api<{ sid: string; act?: number }[]>(`/api/projects/${pid}/film`);
    const map = new Map((rows || []).map((r) => [String(r.sid).toLowerCase(), r.act ?? null]));
    return (sid: string) => map.get(String(sid).toLowerCase()) ?? null;
  } catch { return () => null; }
}

export interface FromResolution { seconds: number; how: string; sid?: string }

/**
 * The `from` grammar, plus the resolver fallback that makes
 * "from the lighthouses" land on a frame.
 */
export async function resolveFrom(
  ctx: ActionContext, pid: string, raw: unknown, chapters: Chapter[],
  duration: number | null,
): Promise<FromResolution> {
  if (raw === undefined || raw === null || raw === "") return { seconds: 0, how: "the top" };
  const wantsAct = /^act\s*\d$/i.test(String(raw).trim());
  const hit = parseFrom(raw, chapters, {
    duration,
    actOf: wantsAct ? await actLookup(ctx, pid) : undefined,
  });
  if (hit) return hit;
  // Not a clock, not a sid, not an act: ask the resolver what shot that is.
  try {
    const r = await ctx.resolve.resolve(pid, String(raw));
    const sid = (r.confidence === "exact" || r.confidence === "high") && r.best ? r.best.sid : null;
    if (sid) {
      const ch = chapterOf(chapters, sid);
      if (ch) return { seconds: ch.start, how: `${sid} (${mmss(ch.start)})`, sid };
      return { seconds: 0, how: `${sid} is not in this cut, so starting at the top`, sid };
    }
  } catch { /* fall through to the top */ }
  return { seconds: 0, how: `could not place "${cut(raw, 30)}", so starting at the top` };
}

/** Seek the room (once its <video> is live), then try to start it. */
async function startRoom(t: number, wantPlay: boolean): Promise<{ playing: boolean; attached: boolean }> {
  const player = await screen.waitForPlayer(1500);
  if (!player) return { playing: false, attached: false };
  player.seek(t);
  if (!wantPlay) return { playing: false, attached: true };
  const playing = await screen.play();
  return { playing, attached: true };
}

// ---------------------------------------------------------------- play_cut

interface PlayCutArgs {
  project?: string; cut?: string | number; from?: string | number;
  to?: number; muted?: boolean;
}

export const playCut: ActionDef<PlayCutArgs> = {
  name: "play_cut",
  title: "Watch the film",
  description:
    "Play an assembled cut full screen in the screening room, from anywhere in " +
    "it. Picks the cut (newest by default, or a file name or an index from " +
    "newest), opens the Film Editor, opens the room over it and starts playing. " +
    "`from` takes seconds, \"1:05\", a shot sid, \"act2\", \"start\"/\"end\", or a " +
    "description like \"the lighthouses\". The room shows the cut's shot list as a " +
    "chapter strip. Returns the shot now on screen. Use stop_playback to close it.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project id. Defaults to the film that is open." },
      cut: { type: "string", description: "Which cut: \"latest\" (default), a file name, or an index from newest where 1 is newest." },
      from: { type: "string", description: FROM_WORDS },
      to: { type: "number", description: "Stop and hold at this many seconds. Leave it out to play to the end." },
      muted: { type: "boolean", description: "Start muted. Browsers allow a muted clip to autoplay when a normal one is refused." },
    },
    additionalProperties: false,
  },
  annotations: {},
  where: (a) => ({
    route: FILM_ROUTE, anchor: ANCHORS.screenRoot,
    label: `Film Editor → Cuts → ${a?.cut ? cut(String(a.cut), 24) : "the newest cut"} → screening room`,
  }),
  keywords: ["play", "watch", "screen", "film", "cut", "animatic", "full screen",
             "show me the film", "from", "playback", "review"],
  howTo:
    "Scroll to Cuts at the bottom of the Film Editor and click a poster. It opens " +
    "full screen with a chapter strip; click a chapter to jump to that shot.",
  summarize: (a) => `Play the film${a?.from ? ` from ${cut(String(a.from), 22)}` : ""}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = args?.project || ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first, then ask to play the film." });

    const rows = await listCuts(ctx, pid);
    if (!rows.length) {
      return err("no_cuts", {
        hint: "This film has not been assembled yet. Call cut_film first, then play_cut.",
      });
    }
    const row = pickCut(rows, args?.cut);
    if (!row) {
      return err("cut_not_found", {
        candidates: rows.slice(0, 5).map((r) => basename(r.path)),
        hint: `No cut matches "${cut(args?.cut, 30)}". Pass one of the names above, or "latest".`,
      });
    }

    const opened = await openFilmPage(ctx, "play_cut", pid);
    if (!opened.ok) return opened.res;
    await ctx.trail.step({
      tool: "play_cut", title: `Cut: ${cut(basename(row.path), 34)}`,
      anchor: `${ANCHORS.filmCutPlay}[data-path="${row.path}"]`, detail: row.path,
    });

    const { chapters, total } = await fetchChapters(ctx.api, pid, row.path);
    const duration = total ?? row.meta?.total ?? (chapters.length ? totalOf(chapters) : null);
    const from = await resolveFrom(ctx, pid, args?.from, chapters, duration);

    screen.open(row.path, {
      pid, t: from.seconds, chapters, seconds: duration,
      muted: args?.muted === true, autoplay: true,
      stopAt: typeof args?.to === "number" ? args.to : null,
      label: basename(row.path),
    });
    await ctx.trail.step({
      tool: "play_cut", title: `Screening room, from ${mmss(from.seconds)}`,
      anchor: ANCHORS.screenRoot, detail: from.how,
    });

    const started = await startRoom(from.seconds, true);
    const here = chapterAt(chapters, from.seconds);

    return ok(
      `Playing ${cut(basename(row.path), 40)} from ${mmss(from.seconds)}` +
      (here ? ` · ${here.sid}` : ""),
      {
        cut: cut(row.path, 70),
        duration: duration ? Math.round(duration) : null,
        from: Math.round(from.seconds * 100) / 100,
        from_meaning: cut(from.how, 60),
        now_playing_shot: here?.sid ?? null,
        chapters: chapters.length,
        ...(args?.to ? { to: args.to } : {}),
        ...(started.playing ? {} : { needs_click: true }),
        hint: started.playing
          ? "It is on screen now. play_cut again to jump, or stop_playback to close it."
          : started.attached
            ? "The room is open but the browser refused autoplay. The big ▶ is on screen for the director to press, or re-call with muted:true."
            : "The room is open; the picture is still loading. Re-call with the same `from` if it has not started.",
      },
    );
  },
};

// ---------------------------------------------------------------- play_take

interface PlayTakeArgs { shot: string; take?: string; from?: string | number }

export const playTake: ActionDef<PlayTakeArgs> = {
  name: "play_take",
  title: "Watch one take",
  description:
    "Put a single take on the big screen: full-viewport playback of one shot's " +
    "clip, or a still held for the shot's duration with a progress bar. `take` " +
    "accepts a path or the usual words: \"latest\", \"newest motion\", \"newest " +
    "still\", \"keeper\", \"plays\" (what is in the cut). Use it when the director " +
    "wants to look hard at one shot rather than the whole film. stop_playback closes it.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: "Which take: a path, or \"latest\", \"newest motion\", \"newest still\", \"keeper\", \"plays\". Defaults to what plays." },
      from: { type: "string", description: "Start this many seconds in, or \"0:02\". Defaults to the head of the take." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: {},
  where: { route: SHOT_ROUTE, anchor: ANCHORS.screenRoot, label: "Shot Editor → take → ⛶ screening room" },
  keywords: ["play", "watch", "take", "clip", "full screen", "look at", "screen", "review"],
  howTo: "Select a take in the takes rail and press ⛶. It fills the screen; esc closes it.",
  summarize: (a) => `Play ${cut(a?.take || "what plays", 20)} on ${cut(a?.shot, 22)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch { return err("shot_fetch_failed", { hint: `Could not read ${shot.sid}.` }); }

    const hit = await pickTake(ctx, pid, detail, args?.take, { prefer: "clip" });
    if (!hit) {
      return err("take_not_found", {
        hint: `Nothing on ${shot.sid} matches "${cut(args?.take ?? "what plays", 30)}". Generate a take first, or pass a path.`,
      });
    }

    const seconds = detail.seconds ?? shot.seconds ?? null;
    const chapters: Chapter[] = [{ sid: shot.sid, start: 0, seconds: seconds || 0, source: hit.path }];
    const from = await resolveFrom(ctx, pid, args?.from, chapters, seconds);

    try {
      await ctx.nav(filmUrl(pid, { sel: shot.sid }));
      await ctx.page.waitFor("film");
    } catch { /* the room does not need the page underneath */ }

    screen.open(hit.path, {
      pid, t: from.seconds, chapters, seconds, autoplay: true,
      label: `${shot.sid} · ${basename(hit.path)}`,
    });
    await ctx.trail.step({
      tool: "play_take", title: `Screening ${shot.sid} · ${cut(basename(hit.path), 28)}`,
      anchor: ANCHORS.screenRoot, detail: hit.path,
    });

    const started = await startRoom(from.seconds, true);
    return ok(`${cut(basename(hit.path), 40)} is on the big screen`, {
      shot: shot.sid,
      take: cut(hit.path, 70),
      kind: hit.kind,
      is_still: !/\.(mp4|webm|mov|m4v)$/i.test(hit.path),
      seconds,
      from: Math.round(from.seconds * 100) / 100,
      ...(started.playing ? {} : { needs_click: true }),
      hint: started.playing
        ? "Esc or stop_playback closes it."
        : "The room is open; the browser may want a click on the big ▶ before it starts.",
    });
  },
};

// ---------------------------------------------------------------- stop_playback

export const stopPlayback: ActionDef<Record<string, never>> = {
  name: "stop_playback",
  title: "Close the screening room",
  description:
    "Stop whatever is playing and close the full-screen screening room, putting " +
    "the director back on the page underneath with nothing lost. Also clears the " +
    "?screen and ?t deep-link parameters. Safe to call when nothing is playing.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {},
  where: { route: FILM_ROUTE, anchor: ANCHORS.screenClose, label: "Screening room → ✕ close" },
  keywords: ["stop", "close", "quit", "esc", "enough", "playback", "screening room"],
  howTo: "Press esc, or click the ✕ at the top right of the screening room.",
  summarize: () => "Close the screening room",
  async execute(_args, ctx): Promise<ToolResult> {
    const was = screen.screenState();
    if (!was.open) {
      return ok("Nothing was playing.", { was_playing: false });
    }
    screen.pause();
    screen.close();
    await ctx.trail.step({
      tool: "stop_playback", title: "Close the screening room", anchor: ANCHORS.screenClose,
    });
    return ok(`Closed the screening room (${cut(basename(was.rel || ""), 40)}).`, {
      was_playing: true,
      closed: cut(was.rel || "", 70),
      stopped_at: Math.round(was.t * 100) / 100,
    });
  },
};

// ---------------------------------------------------------------- preview_timeline

interface PreviewArgs {
  project?: string; from?: string | number; play?: boolean; scope_sec?: number;
}

export const previewTimeline: ActionDef<PreviewArgs> = {
  name: "preview_timeline",
  title: "Preview the timeline",
  description:
    "Play the Timeline's live preview: the film compiled straight from the clip " +
    "model, with no render step, so it reflects edits the instant they are made. " +
    "Seeks to `from` (seconds, \"1:05\", a shot sid, \"act2\", or a description) " +
    "and presses play. Video and stills only: there is no audio in this preview, " +
    "so use play_cut when the director needs to hear the VO or the score.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project id. Defaults to the film that is open." },
      from: { type: "string", description: FROM_WORDS },
      play: { type: "boolean", description: "Start playing (default true). False seeks and holds on the frame." },
      scope_sec: { type: "number", description: "Set the render-scope dropdown to this many seconds, for a following render_timeline." },
    },
    additionalProperties: false,
  },
  annotations: {},
  where: { route: TIMELINE_ROUTE, anchor: ANCHORS.timelinePlay, label: "Timeline → live preview → ▶" },
  keywords: ["preview", "timeline", "play", "scrub", "playhead", "live", "seek", "transport"],
  howTo: "Open Timeline and press ▶ under the preview monitor; drag the bar beside it to scrub.",
  summarize: (a) => `Preview the timeline${a?.from ? ` from ${cut(String(a.from), 20)}` : ""}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = args?.project || ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first, then ask for the preview." });

    const url = timelinePath(pid);
    let page;
    try {
      await ctx.nav(url);
      page = await ctx.page.waitFor("timeline");
      await ctx.trail.step({ tool: "preview_timeline", title: "Open Timeline", detail: url });
    } catch (e) {
      return err("page_did_not_mount", {
        hint: `Could not open ${url}: ${cut((e as Error)?.message, 90)}.`,
      });
    }

    if (typeof args?.scope_sec === "number") {
      page.setScope(args.scope_sec);
      await ctx.trail.step({
        tool: "preview_timeline", title: `Scope: first ${args.scope_sec}s`,
        anchor: ANCHORS.timelineScope,
      });
    }

    const clips = page.clips() || [];
    const chapters: Chapter[] = clips.map((c) => ({
      sid: c.sid, start: c.start, seconds: c.seconds,
    }));
    const duration = page.duration() || (chapters.length ? totalOf(chapters) : null);
    const from = await resolveFrom(ctx, pid, args?.from, chapters, duration);

    page.seek(from.seconds);
    const here = chapterAt(chapters, from.seconds);
    if (here) page.selectClip(here.sid);
    await ctx.trail.step({
      tool: "preview_timeline", title: `Playhead at ${mmss(from.seconds)}`,
      anchor: ANCHORS.timelineScrub, detail: from.how,
    });

    let playing = false;
    if (args?.play !== false) {
      playing = await page.play().catch(() => false);
      await ctx.trail.step({
        tool: "preview_timeline", title: playing ? "▶ playing" : "▶ press play",
        anchor: ANCHORS.timelinePlay,
      });
    }

    return ok(
      `Timeline preview at ${mmss(from.seconds)}${here ? ` · ${here.sid}` : ""}` +
      (playing ? ", playing" : ""),
      {
        from: Math.round(from.seconds * 100) / 100,
        from_meaning: cut(from.how, 60),
        now_playing_shot: here?.sid ?? null,
        duration: duration ? Math.round(duration) : null,
        clips: clips.length,
        ...(args?.play !== false && !playing ? { needs_click: true } : {}),
        note: "live compiled preview, video only; use play_cut for the rendered cut with audio",
      },
    );
  },
};
