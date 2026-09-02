/**
 * Smoke tools — minimal `open_shot` and `show_me` so the spine is drivable before workstream
 * C's real catalogue lands. Registered LAST and only if the name is still free, so C's
 * implementations always win.
 *
 * Owned by workstream A. Delete-safe once `tools/` covers both names.
 */
import {
  err, genSubAnchor, ok, shotTabAnchor,
  type ActionDef, type GenSub, type ShotTab,
} from "./contract";
import { all, get, register, whereOf } from "./registry";
import { pulse } from "./presence";
import { fillRoute, withQuery } from "./urlState";
import { ROUTES, shotPath } from "../routes";

const TABS: ShotTab[] = ["compose", "generate", "motion", "audio", "script"];
const SUBS: GenSub[] = ["still", "restyle", "animate", "chain"];

interface OpenShotArgs { shot: string; tab?: ShotTab; sub?: GenSub; take?: string }

const openShot: ActionDef<OpenShotArgs> = {
  name: "open_shot",
  title: "Open a shot",
  description:
    "Open a shot in Genga Studio's Shot Editor and put a specific tab on screen. Accepts a shot id " +
    "(B10-S2), a number in film order (37), a beat (B10) or a description. Navigates the real " +
    "UI so the human sees where the work happens.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "Shot id, film-order number, beat, or a description of the shot." },
      tab: { type: "string", enum: TABS, description: "Workspace tab to open." },
      sub: { type: "string", enum: SUBS, description: "Generate sub-tab, when tab is generate." },
      take: { type: "string", description: "Take path to select in the monitor." },
    },
    required: ["shot"],
  },
  annotations: { readOnlyHint: false, consequentialHint: false },
  keywords: ["open", "shot", "navigate", "editor", "go to"],
  howTo: "In the Film Editor, click a shot in the strip and press “open Shot Editor →”, " +
    "or double-click its card. Then pick a tab on the right.",
  where: (a) => ({
    route: ROUTES.shot,
    query: { ...(a.tab ? { tab: a.tab } : {}), ...(a.sub ? { sub: a.sub } : {}) },
    anchor: a.tab ? shotTabAnchor(a.tab) : undefined,
    label: `Shot Editor${a.tab ? ` → ${a.tab}` : ""}${a.sub ? ` → ${a.sub}` : ""}`,
  }),
  summarize: (a) => `Open ${a.shot}${a.tab ? ` on ${a.tab}` : ""}`,
  async execute(args, ctx) {
    const pid = ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first (the Projects page)." });
    const r = await ctx.resolve.resolve(pid, args.shot);
    if (!r.best) {
      return err("shot_not_found", {
        hint: `nothing matched "${args.shot}" — try a sid like B10-S2 or a number in film order`,
      });
    }
    if (r.confidence === "ambiguous" && r.candidates.length > 1) {
      return err("ambiguous_shot", {
        hint: "say which one, then call open_shot again with that sid",
        candidates: r.candidates.slice(0, 5).map((c) => ({ sid: c.sid, ordinal: c.ordinal, why: c.why })),
      });
    }
    const sid = r.best.sid;
    const to = withQuery(shotPath(pid, sid), {
      tab: args.tab || null, sub: args.sub || null, take: args.take || null,
    });
    await ctx.trail.step({ tool: "open_shot", title: `Open ${sid}`, detail: r.candidates[0]?.why });
    await ctx.nav(to);
    const page = await ctx.page.waitFor("shot", { sid });
    if (args.tab) {
      page.setTab(args.tab);
      await ctx.trail.step({ tool: "open_shot", title: `Tab: ${args.tab}`, anchor: shotTabAnchor(args.tab) });
    }
    if (args.sub) {
      page.setSub(args.sub);
      await ctx.trail.step({ tool: "open_shot", title: `Sub-tab: ${args.sub}`, anchor: genSubAnchor(args.sub) });
    }
    if (args.take) page.selectTake(args.take);
    const s = page.getState();
    return ok(`${sid} is open on ${s.tab}${s.tab === "generate" ? ` → ${s.sub}` : ""}`, {
      shot: sid, ordinal: r.best.ordinal, tab: s.tab, sub: s.sub,
      selected: s.selected, takes: s.takes.length,
    });
  },
};

interface ShowMeArgs { feature: string }

const showMe: ActionDef<ShowMeArgs> = {
  name: "show_me",
  title: "Show me where that lives",
  description:
    "Find a Genga Studio feature by name, navigate to the screen it lives on, highlight the exact " +
    "control, and explain how a human does it by hand. Use this to teach the UI rather than " +
    "doing the work for the director.",
  inputSchema: {
    type: "object",
    properties: {
      feature: { type: "string", description: "What to find, e.g. “freeze tail”, “cut the film”, “keeper”." },
    },
    required: ["feature"],
  },
  annotations: { readOnlyHint: false },
  keywords: ["help", "where", "teach", "how do I", "find the button"],
  howTo: "Press ⌘K and type the feature name — the palette shows where it lives.",
  where: { route: "/", label: "Anywhere — the ⌘K palette" },
  summarize: (a) => `Show where “${a.feature}” lives`,
  async execute(args, ctx) {
    const q = args.feature.toLowerCase().trim();
    const scored = all()
      .map((d) => {
        const hay = `${d.name} ${d.title} ${(d.keywords || []).join(" ")} ${d.description}`.toLowerCase();
        const score = d.name === q ? 100 : d.title.toLowerCase() === q ? 90
          : hay.includes(q) ? 50
            : q.split(/\s+/).filter((t) => t && hay.includes(t)).length * 10;
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) {
      return err("feature_not_found", {
        hint: "call list_features to see everything Genga Studio can do",
        known: all().slice(0, 20).map((d) => d.name),
      });
    }
    const def = scored[0].d;
    const where = whereOf(def, {});
    const route = fillRoute(where.route, { pid: ctx.project, sid: null });
    if (route) {
      await ctx.trail.step({ tool: "show_me", title: `Go to ${where.label}` });
      await ctx.nav(withQuery(route, where.query || {}));
    }
    if (where.anchor) {
      await ctx.trail.step({ tool: "show_me", title: `Here: ${def.title}`, anchor: where.anchor });
      pulse(where.anchor);
    }
    return ok(`${def.title} — ${where.label}`, {
      feature: def.name, where: where.label,
      howTo: def.howTo || def.description,
      anchor: where.anchor ?? null,
      navigated: Boolean(route),
      others: scored.slice(1, 4).map((x) => x.d.name),
    });
  },
};

const SMOKE: ActionDef<any>[] = [openShot as ActionDef<any>, showMe as ActionDef<any>];

/** Register the smoke tools, skipping any name workstream C already claimed. */
export function registerSmokeTools(): string[] {
  const added: string[] = [];
  for (const def of SMOKE) {
    if (get(def.name)) continue;
    register(def);
    added.push(def.name);
  }
  return added;
}
