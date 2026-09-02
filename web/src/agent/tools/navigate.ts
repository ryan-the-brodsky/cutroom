/**
 * Navigation tools: open_shot (drive to a shot) and show_me (teach a feature
 * by going there and pulsing the control).
 */
import type {
  ActionContext, ActionDef, GenSub, ShotTab, ToolResult, Where,
} from "../contract";
import { ANCHORS, err, genSubAnchor, ok, shotTabAnchor } from "../contract";
import { deps } from "./deps";
import {
  FILM_ROUTE, SHOT_ROUTE, cut, fetchShot, lookupShot, openShotPage, pickTake, safeState,
} from "./util";

const TABS: ShotTab[] = ["compose", "generate", "motion", "audio", "script"];
const SUBS: GenSub[] = ["still", "restyle", "animate", "chain"];

// ---------------------------------------------------------------- open_shot

interface OpenArgs { shot: string; tab?: ShotTab; sub?: GenSub; take?: string }

export const openShot: ActionDef<OpenArgs> = {
  name: "open_shot",
  title: "Open a shot",
  description:
    "Open a shot in the Shot Editor so the director can see it, optionally landing " +
    "on a specific tab (compose, generate, motion, audio, script), a generate " +
    "sub-tab (still, restyle, animate, chain) and a selected take. The page " +
    "navigates on screen and the tab is highlighted. Use it to put the right room " +
    "in front of the human before you change anything, or when they say \"show me " +
    "shot 37\". Returns the resolved sid and what is now visible.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      tab: { type: "string", enum: TABS, description: "Which workspace tab to land on. Default: leave the tab as it is." },
      sub: { type: "string", enum: SUBS, description: "Which Generate sub-tab to open (implies tab=generate)." },
      take: { type: "string", description: "A take to select: a path, or \"latest\", \"newest still\", \"newest motion\", \"keeper\", \"plays\"." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: {},
  where: (a) => ({
    route: SHOT_ROUTE,
    query: { tab: (a?.sub ? "generate" : a?.tab) || "compose", ...(a?.sub ? { sub: a.sub } : {}) },
    anchor: a?.sub ? genSubAnchor(a.sub) : shotTabAnchor((a?.tab as ShotTab) || "compose"),
    label: `Shot Editor${a?.tab ? ` → ${a.tab}` : ""}${a?.sub ? ` → ${a.sub}` : ""}`,
  }),
  keywords: ["open", "shot", "editor", "navigate", "go to", "show shot"],
  howTo:
    "Double-click the shot's cell in the Film Editor strip (or press \"open Shot Editor →\" " +
    "in its panel), then pick a tab across the top of the workspace.",
  summarize: (a) => `Open ${cut(a.shot, 26)}${a.tab ? ` → ${a.tab}` : ""}${a.sub ? ` → ${a.sub}` : ""}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const sub = SUBS.includes(args?.sub as GenSub) ? (args.sub as GenSub) : undefined;
    const tab: ShotTab | undefined = sub ? "generate"
      : TABS.includes(args?.tab as ShotTab) ? (args.tab as ShotTab) : undefined;

    const opened = await openShotPage(ctx, "open_shot", pid, shot.sid,
      { ...(tab ? { tab } : {}), ...(sub ? { sub } : {}) });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    if (tab) {
      page.setTab(tab);
      await ctx.trail.step({ tool: "open_shot", title: `Open the ${tab} tab`, anchor: shotTabAnchor(tab) });
    }
    if (sub) {
      page.setSub(sub);
      await ctx.trail.step({ tool: "open_shot", title: `Open Generate → ${sub}`, anchor: genSubAnchor(sub) });
    }

    let selected: string | null = safeState(page).selected;
    if (args?.take) {
      try {
        const detail = await fetchShot(ctx, pid, shot.sid);
        const hit = await pickTake(ctx, pid, detail, args.take, { selected });
        if (hit) {
          page.selectTake(hit.path);
          selected = hit.path;
          await ctx.trail.step({
            tool: "open_shot", title: `Select ${cut(hit.path.split("/").pop(), 34)}`,
            anchor: ANCHORS.shotTake, detail: hit.path,
          });
        }
      } catch { /* selection is a nicety, not the point of the tool */ }
    }

    const s = safeState(page);
    return ok(`${shot.sid} is open (${s.tab}${s.tab === "generate" ? ` → ${s.sub}` : ""})`, {
      shot: shot.sid,
      ordinal: shot.ordinal,
      type: shot.type,
      seconds: shot.seconds,
      tab: s.tab,
      sub: s.tab === "generate" ? s.sub : undefined,
      selected: selected ? cut(selected, 60) : null,
      keeper: s.keeper ? cut(s.keeper, 60) : null,
      plays: s.activeSource ? cut(s.activeSource, 60) : null,
      takes: s.takes.length,
      summary_line: cut(shot.summary, 90),
    });
  },
};

// ---------------------------------------------------------------- show_me

interface ShowArgs { feature: string; shot?: string }

interface FeatureDef {
  name: string; title: string; description: string; keywords?: string[];
  howTo?: string; where: Where | ((a: Record<string, never>) => Where);
}

const resolveWhere = (d: FeatureDef): Where | null => {
  try {
    return typeof d.where === "function" ? d.where({} as Record<string, never>) : d.where;
  } catch { return null; }
};

/** Cheap token-overlap score; exact name/title wins outright. */
function scoreFeature(d: FeatureDef, q: string): number {
  const name = d.name.toLowerCase();
  const title = d.title.toLowerCase();
  const norm = q.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!norm) return 0;
  if (name === norm || name === norm.replace(/ /g, "_")) return 1000;
  if (title === norm) return 900;
  let score = 0;
  if (name.includes(norm.replace(/ /g, "_")) || title.includes(norm)) score += 400;
  const hay = `${name} ${title} ${(d.keywords || []).join(" ")} ${d.description}`.toLowerCase();
  for (const tok of norm.split(" ")) {
    if (tok.length < 2) continue;
    if (name.includes(tok)) score += 60;
    if (title.includes(tok)) score += 40;
    if ((d.keywords || []).some((k) => k.toLowerCase().includes(tok))) score += 30;
    else if (hay.includes(tok)) score += 10;
  }
  return score;
}

/** The shot the human is looking at (or has selected in the Film Editor). */
function currentSid(ctx: ActionContext): string | null {
  try {
    const cur = ctx.page.current();
    if (cur?.kind === "shot") return cur.sid;
    if (cur?.kind === "film") return cur.getState().selected ?? null;
  } catch { /* no handles */ }
  return null;
}

export const showMe: ActionDef<ShowArgs> = {
  name: "show_me",
  title: "Show me how",
  description:
    "Teach a Genga Studio feature by driving to it: navigates to the screen where the " +
    "feature lives, highlights the actual control with a pulse, and explains how a " +
    "human does it by hand. Answers \"where is that?\", \"how do I do that myself?\" " +
    "and \"show me the freeze tool\". Nothing is generated and nothing is changed — " +
    "this only moves the view. Pass a feature name or plain words like \"freeze " +
    "tail\", \"cut the film\", \"set the keeper\", \"voice over\".",
  inputSchema: {
    type: "object",
    properties: {
      feature: { type: "string", description: "The feature to show: a tool name or plain words, e.g. \"freeze tail\", \"keeper\", \"cut the film\"." },
      shot: { type: "string", description: "Optional shot to demonstrate on, when the feature lives inside the Shot Editor." },
    },
    required: ["feature"],
    additionalProperties: false,
  },
  annotations: {},
  where: { route: FILM_ROUTE, label: "⌘K command palette" },
  keywords: ["show me", "how do i", "where is", "teach", "highlight", "demo", "help"],
  howTo: "Press ⌘K, type the feature name and press Enter — the palette navigates there and pulses the control.",
  summarize: (a) => `Show me “${cut(a.feature, 34)}”`,
  async execute(args, ctx): Promise<ToolResult> {
    const q = String(args?.feature ?? "").trim().toLowerCase();
    if (!q) return err("needs_feature", { hint: "Name the feature, e.g. \"freeze tail\"." });

    const all = deps.allActions() as unknown as FeatureDef[];
    if (!all.length) return err("registry_empty", { hint: "The action registry has not been populated yet." });

    const ranked = all
      .map((d) => ({ d, score: scoreFeature(d, q) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) {
      return err("feature_not_found", {
        hint: `Nothing matches “${cut(q, 34)}”. Call list_features to see what exists.`,
      });
    }
    const best = ranked[0].d;
    const where = resolveWhere(best);
    if (!where) return err("feature_has_no_location", { hint: `${best.name} does not live on a screen.` });

    const pid = ctx.project;
    let route = where.route;
    if (route.includes(":pid")) {
      if (!pid) return err("no_project", { hint: "Open a project first, then ask again." });
      route = route.replace(":pid", pid);
    }
    if (route.includes(":sid")) {
      let sid = currentSid(ctx);
      if (!sid && args?.shot) {
        const found = await lookupShot(ctx, args.shot);
        if (!found.ok) return found.res;
        sid = found.shot.sid;
      }
      if (!sid) {
        return err("needs_shot", {
          hint: `“${best.title}” lives inside the Shot Editor — tell me which shot to show it on, or open one first.`,
        });
      }
      route = route.replace(":sid", sid);
    }

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(where.query || {})) if (v) params.set(k, v);
    const url = `${route}${params.toString() ? `?${params}` : ""}`;

    try { await ctx.nav(url); }
    catch (e) { return err("nav_failed", { hint: cut((e as Error)?.message, 140) }); }

    await ctx.trail.step({
      tool: "show_me",
      title: `Here: ${where.label}`,
      anchor: where.anchor,
      detail: best.howTo,
    });

    return ok(`${best.title} — ${where.label}`, {
      feature: best.name,
      title: best.title,
      where: where.label,
      route: url,
      how_to: cut(best.howTo, 260),
      ...(ranked.length > 1
        ? { also: ranked.slice(1, 4).map((r) => r.d.name) }
        : {}),
    });
  },
};
