/**
 * Palette-only entries for the screening room.
 *
 * A separate file from `features.ts` on purpose: that one is a table of `walkTo`
 * rows, and these three actually do something (open the room, move a chapter,
 * close it). There is nowhere to walk to, because the room is an overlay rather
 * than a route. They stay `surfaces: { agent: false }` so they cost an agent no
 * tool budget; `play_cut` / `stop_playback` are the agent-facing versions.
 *
 * Owned by workstream M.
 */
import type { ActionContext, ActionDef, ToolResult } from "./contract";
import { ANCHORS, err, ok } from "./contract";
import { ROUTES, filmPath } from "../routes";
import * as screen from "../screen/store";
import { chapterAt, fetchChapters, mmss, stepChapter, totalOf } from "../screen/edl";

const FILM = ROUTES.film;

interface ScreenFeature {
  name: string;
  title: string;
  description: string;
  keywords: string[];
  howTo: string;
  anchor: string;
  label: string;
  run(ctx: ActionContext): Promise<ToolResult>;
}

function feature(spec: ScreenFeature): ActionDef {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {},
    where: { route: FILM, anchor: spec.anchor, label: spec.label },
    keywords: spec.keywords,
    howTo: spec.howTo,
    group: "Screening room",
    surfaces: { agent: false, palette: true },
    summarize: () => spec.title,
    execute: (_a, ctx) => spec.run(ctx),
  };
}

export const SCREEN_FEATURES: ActionDef[] = [
  feature({
    name: "screening_room",
    title: "Screening room",
    description:
      "Watch the newest cut full screen, with the film's own shot list as a chapter strip under it.",
    keywords: ["screening", "watch", "play", "full screen", "cinema", "review", "the film"],
    howTo: "Click a poster in the Cuts gallery at the bottom of the Film Editor.",
    anchor: ANCHORS.screenRoot,
    label: "Film Editor → Cuts → the screening room",
    async run(ctx) {
      const pid = ctx.project;
      if (!pid) return err("no_project", { hint: "Open a film first." });
      let rows: { path: string; meta?: { total?: number } }[] = [];
      try {
        rows = await ctx.api(`/api/projects/${pid}/takes?kind=animatic&limit=1`);
      } catch { /* handled below */ }
      const row = rows?.[0];
      if (!row) {
        return err("no_cuts", { hint: "Nothing has been assembled yet. Press 🎞 cut the film first." });
      }
      await ctx.nav(filmPath(pid));
      const { chapters, total } = await fetchChapters(ctx.api, pid, row.path);
      screen.open(row.path, {
        pid, chapters, seconds: total ?? row.meta?.total ?? null,
        label: row.path.split("/").pop() || row.path,
      });
      await ctx.trail.step({
        tool: "screening_room", title: "Screening room", anchor: ANCHORS.screenRoot,
        detail: row.path,
      });
      void screen.waitForPlayer(2000).then(() => screen.play());
      return ok("The newest cut is on the big screen. Esc closes it.", {
        cut: row.path, chapters: chapters.length,
        duration: total ? Math.round(total) : null,
      });
    },
  }),

  feature({
    name: "screen_chapter",
    title: "Next / previous chapter",
    description:
      "Jump the screening room to the next shot in the cut ( . ) or the one before it ( , ). Clicking a chapter in the strip does the same.",
    keywords: ["chapter", "next", "previous", "shot", "skip", "jump", "seek", "scene"],
    howTo: "In the screening room press . for the next shot and , for the previous one, or click a chapter in the strip.",
    anchor: ANCHORS.screenChapter,
    label: "Screening room → chapter strip",
    async run(ctx) {
      const s = screen.screenState();
      if (!s.open) {
        return err("not_screening", {
          hint: "Nothing is on the big screen. Open a cut from the Cuts gallery first.",
        });
      }
      if (!s.chapters.length) {
        return err("no_chapters", {
          hint: "This is a single take, not an assembled cut, so it has no chapters.",
        });
      }
      const at = screen.currentPlayer()?.currentTime() ?? s.t;
      const next = stepChapter(s.chapters, at, 1) ?? s.chapters[0];
      screen.seek(next.start);
      await ctx.trail.step({
        tool: "screen_chapter", title: `Chapter: ${next.sid} (${mmss(next.start)})`,
        anchor: `${ANCHORS.screenChapter}[data-sid="${next.sid}"]`,
      });
      return ok(`Jumped to ${next.sid} at ${mmss(next.start)}.`, {
        sid: next.sid, start: next.start,
        of: s.chapters.length, total: Math.round(totalOf(s.chapters)),
      });
    },
  }),

  feature({
    name: "close_screening_room",
    title: "Close the screening room",
    description:
      "Leave the full-screen view and go back to the page underneath. Esc does the same.",
    keywords: ["close", "esc", "stop", "exit", "back", "screening room"],
    howTo: "Press esc, or click ✕ at the top right of the screening room.",
    anchor: ANCHORS.screenClose,
    label: "Screening room → ✕ close",
    async run(ctx) {
      const s = screen.screenState();
      const here = s.open ? chapterAt(s.chapters, s.t) : null;
      screen.close();
      await ctx.trail.step({
        tool: "close_screening_room", title: "Close the screening room",
        anchor: ANCHORS.screenClose,
      });
      return ok(s.open ? "Closed the screening room." : "Nothing was on screen.", {
        was_open: s.open, last_shot: here?.sid ?? null,
      });
    },
  }),
];

export default SCREEN_FEATURES;
