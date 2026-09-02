/**
 * Read-only tools: find_shots, describe_shot, get_context, list_features.
 * These are the only tools allowed to answer without driving the UI.
 */
import type { ActionContext, ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok, shotTabAnchor } from "../contract";
import { deps } from "./deps";
import {
  FILM_ROUTE, SHOT_ROUTE, compactCandidate, cut, fetchShot, lookupShot,
} from "./util";

// ---------------------------------------------------------------- find_shots

interface FindArgs { query: string }

export const findShots: ActionDef<FindArgs> = {
  name: "find_shots",
  title: "Find shots",
  description:
    "Find shots in the current film by anything a director would say: a sid " +
    "(B10-S2), a number in the cut (\"shot 37\"), a beat (\"B11\"), a character " +
    "(\"David Ross\"), a shot type (\"close-up\") or a free description (\"the " +
    "cemetery\"). Returns up to eight matches with their ordinal, beat, " +
    "type, one-line summary and whether they already have a keeper still, motion " +
    "or a source playing in the timeline. When a phrase matches two different " +
    "shots the confidence comes back \"ambiguous\" — ask which one before acting.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What the director said: a sid, a number, a beat, a character name, a shot type, or a description.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmShot, label: "Film Editor → the strip" },
  keywords: ["search", "shots", "which shot", "lookup", "sid", "beat", "character", "find"],
  howTo:
    "Open the Film Editor and scan the strip or the act board for the shot — every cell " +
    "shows its sid, seconds and ticks for keeper, motion, comps and VO.",
  summarize: (a) => `Find shots matching “${cut(a.query, 40)}”`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first (get_context shows where you are)." });
    const q = String(args?.query ?? "").trim();
    if (!q) return err("needs_query", { hint: "Pass what the director said, e.g. \"the David Ross close-up\"." });
    let r;
    try { r = await ctx.resolve.resolve(pid, q); }
    catch (e) { return err("resolve_failed", { hint: cut((e as Error)?.message, 140) }); }

    const rows = (r.candidates || []).slice(0, 8).map((c) => ({
      sid: c.sid, ordinal: c.ordinal, beat: c.beat, act: c.act, type: c.type,
      summary: cut(c.summary, 64),
      characters: (c.characters || []).slice(0, 3),
      has_keeper: !!c.has_keeper, has_motion: !!c.has_motion,
      plays: c.plays ? cut(c.plays.split("/").pop(), 34) : null,
    }));
    if (!rows.length && r.best) {
      rows.push({
        sid: r.best.sid, ordinal: r.best.ordinal, beat: r.best.beat, act: r.best.act,
        type: r.best.type, summary: cut(r.best.summary, 64),
        characters: (r.best.characters || []).slice(0, 3),
        has_keeper: !!r.best.has_keeper, has_motion: !!r.best.has_motion,
        plays: r.best.plays ? cut(r.best.plays.split("/").pop(), 34) : null,
      });
    }

    const hint = r.confidence === "ambiguous"
      ? "Two readings of that phrase point at different shots — ask the director which, then pass that sid."
      : r.confidence === "none"
        ? "Nothing matched. Try a sid (B10-S2), a number, or a character name."
        : undefined;
    const summary = rows.length
      ? `${rows.length} match${rows.length === 1 ? "" : "es"} for “${cut(q, 36)}” (${r.confidence})` +
        (r.best ? ` — best ${r.best.sid}` : "")
      : `No shot matches “${cut(q, 36)}”`;
    return ok(summary, {
      confidence: r.confidence,
      best: r.best?.sid ?? null,
      matches: rows,
      ...(hint ? { hint } : {}),
    });
  },
};

// ---------------------------------------------------------------- describe_shot

interface DescribeArgs { shot: string }

const LANES: [string, string][] = [
  ["still", "still"], ["i2i", "restyle"], ["motion", "animate"], ["vo", "vo"],
];

export const describeShot: ActionDef<DescribeArgs> = {
  name: "describe_shot",
  title: "Describe a shot",
  description:
    "Read one shot's script and state without changing anything: its beat, act, " +
    "type, duration, image and motion prompts, dialogue or radio line, the curated " +
    "keeper, what currently plays in the timeline, how many takes exist of each " +
    "kind with the newest few paths, comps, and which backend each generation lane " +
    "would use with its cost class. Use it before generating so the prompt you send " +
    "builds on the shot the director actually wrote.",
  inputSchema: {
    type: "object",
    properties: {
      shot: {
        type: "string",
        description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description like \"the Ross close-up\".",
      },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "script" },
    anchor: shotTabAnchor("script"), label: "Shot Editor → Script",
  },
  keywords: ["describe", "shot", "script", "prompt", "state", "inspect", "detail"],
  howTo:
    "Open the shot in the Shot Editor and press the Script tab — it shows the image " +
    "prompt, motion prompt, dialogue, radio line and render notes as written.",
  summarize: (a) => `Describe ${cut(a.shot, 30)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;
    let d;
    try { d = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return err("shot_fetch_failed", { hint: cut((e as Error)?.message, 140) }); }

    const counts = {
      stills: d.stills?.length || 0, i2i: d.i2i?.length || 0,
      motion: d.motion?.length || 0, fx: d.fx?.length || 0, vo: d.vo?.length || 0,
    };
    const latest = [...(d.motion || []).slice(-2), ...(d.i2i || []).slice(-2),
                    ...(d.stills || []).slice(-2)]
      .slice(0, 5).map((p) => cut(p.split("/").pop(), 40));

    const lanes: Record<string, string> = {};
    await Promise.all(LANES.map(async ([lane, label]) => {
      try {
        const c = await deps.classifyBackend(pid, lane, undefined, ctx.api);
        if (!c.backend) return;
        lanes[label] = `${c.backend}${c.cost_class === "paid"
          ? ` (paid${c.cost_usd ? ` ≈$${c.cost_usd}` : ""})` : " (free)"}`;
      } catch { /* lane unknown is fine */ }
    }));

    const line = d.dialogue?.[0];
    return ok(`${shot.sid} · ${d.type || shot.type} · ${d.seconds ?? shot.seconds}s · ` +
              `${counts.stills} stills, ${counts.motion + counts.fx} clips`, {
      sid: shot.sid,
      ordinal: shot.ordinal,
      beat: d.beat ?? shot.beat,
      act: d.act ?? shot.act,
      type: d.type ?? shot.type,
      register: d.register,
      seconds: d.seconds,
      image_prompt: cut(d.image_prompt, 200),
      motion_prompt: d.motion_prompt ? cut(d.motion_prompt, 120) : null,
      ...(line ? { dialogue: `${line.character}: ${cut(line.line, 90)}` } : {}),
      ...(d.radio ? { radio: cut(d.radio, 90) } : {}),
      keeper: d.keeper ? cut(d.keeper, 60) : null,
      plays: d.active_source ? cut(d.active_source, 60) : null,
      override: d.override && Object.keys(d.override).length ? d.override : undefined,
      takes: counts,
      latest_takes: latest,
      comps: d.comps?.length || 0,
      lanes,
    });
  },
};

// ---------------------------------------------------------------- get_context

interface ContextArgs { [k: string]: never }

interface RunningJob { id: string; type?: string; title?: string; status?: string }

export const getContext: ActionDef<ContextArgs> = {
  name: "get_context",
  title: "Where am I?",
  description:
    "Report what is on screen right now: the current route and project, whether the " +
    "Film Editor or a Shot Editor is open, which shot, which tab and generate " +
    "sub-tab, the selected take, the keeper, what plays in the timeline, any jobs " +
    "still running, the WebMCP mode the page is in and the agent's playback speed. " +
    "Call it first when you are unsure what the director is looking at, or after a " +
    "navigation, before acting on \"this shot\" or \"the newest one\".",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.navFilm, label: "Anywhere in Cutroom" },
  keywords: ["context", "where", "current", "state", "screen", "now", "status"],
  howTo:
    "Look at the sidebar and the topbar — the project name, the breadcrumb and the " +
    "job chip tell you where you are and what is still running.",
  summarize: () => "Read what is on screen",
  async execute(_args, ctx: ActionContext): Promise<ToolResult> {
    const loc = typeof window !== "undefined" ? window.location : null;
    const route = loc ? `${loc.pathname}${loc.search || ""}` : null;

    let page: Record<string, unknown> = { kind: null };
    try {
      const cur = ctx.page.current();
      if (cur?.kind === "shot") {
        const s = cur.getState();
        page = {
          kind: "shot", shot: cur.sid, tab: s.tab, sub: s.sub,
          kind_filter: s.kindFilter,
          selected: s.selected ? cut(s.selected.split("/").pop(), 40) : null,
          keeper: s.keeper ? cut(s.keeper.split("/").pop(), 40) : null,
          plays: s.activeSource ? cut(s.activeSource.split("/").pop(), 40) : null,
          takes: s.takes?.length || 0,
        };
      } else if (cur?.kind === "film") {
        const s = cur.getState();
        page = { kind: "film", selected: s.selected, scope: s.scope, res: s.res,
                 shots: s.shots?.length || 0 };
      }
    } catch { /* no page handles yet */ }

    let jobs: { job: string; type?: string; status?: string; title?: string }[] = [];
    try {
      const rows = await ctx.api<RunningJob[]>("/api/jobs?status=running&limit=10");
      jobs = (rows || []).slice(0, 6).map((j) => ({
        job: j.id, type: j.type, status: j.status, title: cut(j.title, 44),
      }));
    } catch { /* jobs unavailable */ }

    const agent = (globalThis as { __cutroomAgent?: { mode?: string; tools?: unknown[] } })
      .__cutroomAgent;
    const mode = agent?.mode
      ?? (typeof document !== "undefined" &&
          (document as unknown as { modelContext?: unknown }).modelContext
        ? "native" : "unavailable");

    return ok(
      page.kind === "shot" ? `Shot Editor — ${page.shot} · ${page.tab}`
        : page.kind === "film" ? `Film Editor — ${page.shots} shots`
          : `On ${route ?? "an unknown route"}`,
      {
        route, project: ctx.project, page,
        running_jobs: jobs,
        webmcp_mode: mode,
        speed: ctx.speed,
      },
    );
  },
};

// ---------------------------------------------------------------- list_features

interface FeaturesArgs { query?: string }

const featureText = (d: { name: string; title: string; description: string; keywords?: string[] }) =>
  `${d.name} ${d.title} ${(d.keywords || []).join(" ")} ${d.description}`.toLowerCase();

const whereLabel = (d: { where: unknown }): string => {
  try {
    const w = typeof d.where === "function"
      ? (d.where as (a: Record<string, never>) => { label: string })({} as Record<string, never>)
      : (d.where as { label: string });
    return w?.label || "";
  } catch { return ""; }
};

export const listFeatures: ActionDef<FeaturesArgs> = {
  name: "list_features",
  title: "List Cutroom features",
  description:
    "List what Cutroom can do and where each feature lives in the UI, optionally " +
    "filtered by a word like \"freeze\", \"comp\", \"opacity\" or \"voice\". With no " +
    "query it returns every callable tool plus a count per screen; with a query it " +
    "searches the WHOLE application, including the hundred-odd controls that are " +
    "not tools, and gives each one its screen path and how a human does it by " +
    "hand. Then call show_me to navigate there and pulse the control.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional filter word, e.g. \"freeze\", \"comp\", \"opacity\", \"timeline\", \"backend\". Also matches a screen name.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  outputLimit: 4000,
  where: { route: FILM_ROUTE, label: "⌘K command palette" },
  keywords: ["features", "help", "what can you do", "capabilities", "palette", "commands"],
  howTo: "Press ⌘K (Ctrl+K on Windows) anywhere in Cutroom to open the command palette and type to filter.",
  summarize: (a) => (a?.query ? `List features matching “${cut(a.query, 30)}”` : "List Cutroom features"),
  async execute(args): Promise<ToolResult> {
    const all = deps.allActions() as unknown as {
      name: string; title: string; description: string; keywords?: string[];
      howTo?: string; where: unknown; group?: string;
      surfaces?: { agent?: boolean; palette?: boolean };
    }[];
    const q = String(args?.query ?? "").trim().toLowerCase();
    const groupOf = (d: { group?: string; where: unknown }) =>
      d.group || whereLabel(d).split("→")[0].trim() || "Other";

    // No query: every TOOL as a row (the agent's actual reach), plus a count per
    // screen so it knows what a query would open up. With a query: the whole
    // application, palette-only controls included.
    if (!q) {
      const tools = all.filter((d) => d.surfaces?.agent !== false);
      const groups: Record<string, number> = {};
      for (const d of all) groups[groupOf(d)] = (groups[groupOf(d)] || 0) + 1;
      let rows = tools.map((d) => ({ name: d.name, title: cut(d.title, 24), where: cut(whereLabel(d), 28) }));
      for (const [tw, ww] of [[24, 28], [20, 22], [16, 16]] as const) {
        rows = tools.map((d) => ({ name: d.name, title: cut(d.title, tw), where: cut(whereLabel(d), ww) }));
        if (JSON.stringify(rows).length < 2900) break;
      }
      return ok(`${tools.length} tools · ${all.length} features in all`, {
        features: rows,            // the tool rows, under the key every client reads
        total: all.length,
        screens: groups,
        hint: "Pass `query` (a word, or a screen name like \"Cel workbench\") for the other features and their how-to.",
      });
    }

    const matched = all.filter((d) =>
      featureText(d).includes(q) || groupOf(d).toLowerCase().includes(q));
    const build = (n: number, howChars: number) => matched.slice(0, n).map((d) => ({
      name: d.name,
      title: cut(d.title, 30),
      group: cut(groupOf(d), 20),
      where: cut(whereLabel(d), 40),
      ...(d.surfaces?.agent === false ? { palette_only: true } : {}),
      ...(howChars > 0 ? { how: cut(d.howTo, howChars) } : {}),
    }));
    let rows = build(10, 110);
    for (const [n, h] of [[10, 110], [10, 70], [8, 60], [8, 0], [5, 0]] as const) {
      rows = build(n, h);
      if (JSON.stringify(rows).length < 2600) break;
    }
    return ok(`${matched.length} feature${matched.length === 1 ? "" : "s"} match \u201c${cut(q, 26)}\u201d`, {
      features: rows,
      total: matched.length,
      ...(matched.length > rows.length
        ? { hint: "Narrow the query to see the rest, or call show_me with a feature name." }
        : { hint: "show_me <name> navigates there and pulses the control." }),
    });
  },
};
