/**
 * Lanes, backends and getting the cut out of Genga Studio (workstream I).
 *
 * `list_backends` and `export_timeline` are reads. `set_lane_default` changes
 * what every future generation runs on, so it drives the Settings page's lane
 * table on screen and relays the server's own 403 when a demo instance says no.
 * `render_timeline` is the FreeCut engine path, which is often simply absent —
 * that is a clean answer, not an error.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { getToken } from "../../api";
import { cut, maybeNum } from "./util";
import { imageModelRows, imageModels } from "./images";
import { modelCost, motionModels } from "./plan";
import { ROUTES, timelinePath } from "../../routes";

const LANES = ["still", "i2i", "motion", "vo", "music", "sfx", "direction"] as const;
const SETTINGS_ROUTE = ROUTES.settings;
const TIMELINE_ROUTE = ROUTES.timeline;

const statusOf = (e: unknown): number =>
  Number((e as { status?: number })?.status) || 0;
const messageOf = (e: unknown): string =>
  cut((e as { message?: string })?.message ?? String(e), 200);

// ---------------------------------------------------------------- list_backends

interface BackendRow {
  id: string; type: string; label?: string; enabled?: boolean;
  lanes?: string[]; api_key_set?: boolean; base_url?: string;
  options?: Record<string, unknown>;
}

const PAID_HINT = new Set([
  "fal", "replicate", "openai-images", "openrouter-image", "openrouter",
  "elevenlabs", "eleven-labs", "anthropic", "gemini", "google-images",
]);

const costOf = (b: BackendRow): number | undefined => {
  const v = b.options?.cost_usd;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const classOf = (b: BackendRow): "free" | "paid" => {
  const probe = `${b.id} ${b.type}`.toLowerCase();
  if (/\bmock\b/.test(probe) || /comfy|local/.test(probe)) return "free";
  for (const p of PAID_HINT) if (probe.includes(p)) return "paid";
  return costOf(b) ? "paid" : "free";
};

export const listBackends: ActionDef<Record<string, never>> = {
  name: "list_backends",
  title: "List generation backends",
  description:
    "Report every generation backend this server knows: its id and adapter " +
    "type, which lanes it can serve (still, i2i, motion, vo, music, sfx, " +
    "direction), whether it is enabled, whether a key is stored, and whether it " +
    "costs money per job. Nothing is probed, so it is instant and never bills. " +
    "Call it before naming a backend in generate_takes or set_lane_default, or " +
    "to answer \"what can this machine actually run?\". Also lists the motion " +
    "and image models with their price and what each is good at.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  where: { route: SETTINGS_ROUTE, anchor: ANCHORS.settingsBackend,
           label: "Settings → Generation backends" },
  keywords: ["backends", "models", "lanes", "providers", "gpu", "comfyui", "fal", "cost"],
  howTo: "Open Settings from the sidebar — every backend is a card with its lanes, its key state and enable/health buttons.",
  summarize: () => "List the generation backends",
  async execute(_args, ctx): Promise<ToolResult> {
    let rows: BackendRow[];
    try { rows = (await ctx.api<BackendRow[]>("/api/backends")) || []; }
    catch (e) {
      return err("backends_unavailable", { hint: messageOf(e) });
    }
    let defaults: Record<string, { backend?: string; model?: string }> = {};
    if (ctx.project) {
      try {
        defaults = await ctx.api<typeof defaults>(`/api/projects/${ctx.project}/lanes`) || {};
      } catch { /* lane defaults are a nicety here */ }
    }
    const enabled = rows.filter((b) => b.enabled !== false);
    const models = rows.some((b) => b.type === "fal" && b.enabled !== false)
      ? await motionModels(ctx) : [];
    const imgModels = rows.some((b) => b.type === "openrouter-image"
                                       && b.enabled !== false)
      ? await imageModels(ctx) : [];
    return ok(`${rows.length} backend${rows.length === 1 ? "" : "s"}, ${enabled.length} enabled`, {
      backends: rows.slice(0, 12).map((b) => ({
        id: b.id,
        type: b.type,
        lanes: (b.lanes || []).slice(0, 6),
        enabled: b.enabled !== false,
        key: b.api_key_set === true,
        cost_class: classOf(b),
        ...(costOf(b) !== undefined ? { cost_usd: costOf(b) } : {}),
      })),
      lane_defaults: Object.fromEntries(
        Object.entries(defaults).filter(([, v]) => v?.backend)
          .map(([k, v]) => [k, v.model ? `${v.backend}:${cut(v.model, 24)}` : v.backend!])),
      // A fal row serves any registry model, and they differ in price and in
      // what they are good at — so the choice belongs next to the backends.
      ...(models.length
        ? { motion_models: models.map((m) => ({
              key: m.key, usd: modelCost(m, 5),
              good_at: (m.registers || []).join("/"),
              note: cut(m.note, 40), fallback: m.fallback,
            })) }
        : {}),
      // Same story on the still lane: one openrouter-image row serves every
      // image model, and only some of them can spell.
      ...(imgModels.length ? { image_models: imageModelRows(imgModels) } : {}),
      hint: "set_lane_default points a lane at one of these; generate_takes takes " +
        "an explicit backend, model:\"seedance\"/\"wan\" for motion, and " +
        "model:\"pro\" for a still whose text must be readable.",
    });
  },
};

// ---------------------------------------------------------------- set_lane_default

interface LaneArgs { lane: string; backend: string; model?: string }

export const setLaneDefault: ActionDef<LaneArgs> = {
  name: "set_lane_default",
  title: "Set a lane's default backend",
  description:
    "Point one generation lane at a backend (and optionally a model) for this " +
    "project, so every later generate that leaves the console blank runs there — " +
    "the \"(project default)\" the model picker shows. Lanes are still, i2i, " +
    "motion, vo, music, sfx and direction. Opens the Settings lane table and " +
    "changes the row on screen. Hosted demos allow this to the admin only; the " +
    "server's refusal is relayed verbatim.",
  inputSchema: {
    type: "object",
    properties: {
      lane: { type: "string", enum: [...LANES], description: "Which lane: still, i2i, motion, vo, music, sfx or direction." },
      backend: { type: "string", description: "The backend id to make default, e.g. \"mock\", \"fal\", \"elevenlabs\". Use list_backends to see them." },
      model: { type: "string", description: "Model (or voice) id on that backend. Omit to leave the backend's own default." },
    },
    required: ["lane", "backend"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SETTINGS_ROUTE, anchor: ANCHORS.settingsLane,
           label: "Settings → Where each part of the film is made" },
  keywords: ["lane", "default", "backend", "model", "voice", "project default", "route lane"],
  howTo: "In Settings, find \"Where each part of the film is made\", pick a backend for the lane and press save.",
  summarize: (a) => `Point the ${cut(a?.lane, 12)} lane at ${cut(a?.backend, 20)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first — lane defaults are per project." });

    const lane = String(args?.lane ?? "").trim().toLowerCase();
    if (!(LANES as readonly string[]).includes(lane)) {
      return err("unknown_lane", { hint: `Lane must be one of: ${LANES.join(", ")}.` });
    }
    const backend = String(args?.backend ?? "").trim();
    if (!backend) return err("needs_backend", { hint: "Name a backend id — call list_backends to see them." });

    let known: { id: string; enabled?: boolean; lanes?: string[] }[] = [];
    try { known = (await ctx.api<typeof known>("/api/backends")) || []; }
    catch { /* validate optimistically */ }
    const hit = known.find((b) => b.id === backend);
    if (known.length && !hit) {
      return err("backend_not_found", {
        hint: `No backend "${cut(backend, 24)}". Known: ${known.map((b) => b.id).slice(0, 8).join(", ")}.`,
      });
    }
    if (hit && hit.lanes && hit.lanes.length && !hit.lanes.includes(lane)) {
      return err("backend_wrong_lane", {
        hint: `${backend} serves ${hit.lanes.join(", ")} — not ${lane}.`,
      });
    }

    try { await ctx.nav(SETTINGS_ROUTE); } catch { /* the write still stands */ }
    await ctx.trail.step({
      tool: "set_lane_default", title: `Settings → lane defaults → ${lane}`,
      anchor: ANCHORS.settingsLane,
    });

    try {
      await ctx.api(`/api/projects/${pid}/lanes`, {
        lane, backend, model: args?.model || null,
      });
    } catch (e) {
      if (statusOf(e) === 403) {
        return err("forbidden", { lane, backend, hint: messageOf(e) });
      }
      return err("lane_update_failed", { hint: messageOf(e) });
    }

    await ctx.trail.step({
      tool: "set_lane_default",
      title: `${lane} → ${backend}${args?.model ? ` · ${cut(args.model, 24)}` : ""}`,
      anchor: ANCHORS.settingsLaneSave,
    });

    return ok(`the ${lane} lane now runs on ${backend}`, {
      project: pid, lane, backend,
      model: args?.model || null,
      enabled: hit ? hit.enabled !== false : null,
      hint: hit && hit.enabled === false
        ? `${backend} is disabled — enable it in Settings or jobs will fall back.`
        : "Generate consoles left blank will use this from now on.",
    });
  },
};

// ---------------------------------------------------------------- export_timeline

interface ExportArgs { format?: "otio" | "edl" }

/** The interchange endpoints are a JSON body (otio) or plain text (edl). */
async function fetchInterchange(
  ctx: Parameters<ActionDef["execute"]>[1], path: string,
): Promise<string | null> {
  try {
    const body = await ctx.api<unknown>(path);
    return typeof body === "string" ? body : JSON.stringify(body);
  } catch { /* plain-text responses do not parse as JSON */ }
  try {
    const token = getToken();
    const r = await fetch(path + (token ? `?token=${encodeURIComponent(token)}` : ""));
    if (r.ok) return await r.text();
  } catch { /* preview is a nicety; the URL is the deliverable */ }
  return null;
}

export const exportTimeline: ActionDef<ExportArgs> = {
  name: "export_timeline",
  title: "Export the timeline",
  description:
    "Hand the cut to another program. \"otio\" is OpenTimelineIO JSON, which " +
    "opens natively in Resolve, Nuke Studio and Kdenlive and carries each " +
    "clip's Genga Studio lineage in its metadata; \"edl\" is a CMX3600 edit decision " +
    "list, the universal conform format. Nothing is rendered and nothing " +
    "changes — this compiles the current film and returns a download URL plus " +
    "the first lines, so you can check the cut before opening it downstream.",
  inputSchema: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["otio", "edl"], description: "\"otio\" for OpenTimelineIO JSON (default), \"edl\" for a CMX3600 edit decision list." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: TIMELINE_ROUTE, anchor: ANCHORS.timelineOtio,
           label: "Timeline → export" },
  keywords: ["export", "otio", "edl", "resolve", "premiere", "conform", "interchange", "hand off"],
  howTo: "On the Timeline page, click OTIO or EDL beside the render button — the file downloads.",
  summarize: (a) => `Export the timeline as ${a?.format === "edl" ? "EDL" : "OTIO"}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first, then export its timeline." });
    const format = args?.format === "edl" ? "edl" : "otio";
    const path = `/api/projects/${pid}/timeline/${format}`;

    const text = await fetchInterchange(ctx, path);
    if (text === null) {
      return ok(`${format.toUpperCase()} export ready at ${path}`, {
        project: pid, format, url: path, preview: null,
        hint: "The preview could not be read from this page, but the URL downloads the file.",
      });
    }

    let clips: number | null = null;
    try {
      clips = format === "otio"
        ? (JSON.parse(text).tracks?.children?.[0]?.children?.length ?? null)
        : (text.match(/^\d{3}\s/gm)?.length ?? null);
    } catch { /* preview only */ }

    return ok(`${format.toUpperCase()} export ready${clips ? ` — ${clips} events` : ""}`, {
      project: pid, format, url: path,
      bytes: text.length,
      ...(clips !== null ? { events: clips } : {}),
      preview: cut(text.replace(/\s+/g, " "), 300),
      hint: format === "otio"
        ? "Open the .otio in Resolve or Kdenlive; metadata.cutroom carries the lineage."
        : "Conform the EDL against the media in the project's renders/ folder.",
    });
  },
};

// ---------------------------------------------------------------- render_timeline

interface RenderArgs { scope_sec?: number; container?: "mp4" | "webm" }

export const renderTimeline: ActionDef<RenderArgs> = {
  name: "render_timeline",
  title: "Render through the engine",
  description:
    "Render the compiled timeline through the lifted FreeCut engine — the clip " +
    "model with real source in/out points, not the shot-slot assembler that " +
    "cut_film uses. Optionally scope it to the first N seconds so a check is " +
    "quick. Returns the job. The engine is an optional dependency: when it is " +
    "not configured — and on the hosted studio it never is — this answers " +
    "\"engine offline\" cleanly rather than failing, and cut_film remains the " +
    "way to see the film.",
  inputSchema: {
    type: "object",
    properties: {
      scope_sec: { type: "number", minimum: 1, description: "Render only the first N seconds. Omit for the whole film." },
      container: { type: "string", enum: ["mp4", "webm"], description: "Output container. Default mp4." },
    },
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: TIMELINE_ROUTE, anchor: ANCHORS.timelineRender,
           label: "Timeline → 🎞 cut the film" },
  keywords: ["render", "engine", "freecut", "timeline", "preview render", "export video"],
  howTo: "There is no engine button in the studio: this is a server-side option, and the Timeline's 🎞 cut the film is what a director presses.",
  summarize: (a) => (a?.scope_sec ? `Render the first ${a.scope_sec}s` : "Render the whole timeline"),
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) return err("no_project", { hint: "Open a project first." });

    const scope = maybeNum(args?.scope_sec);
    try { await ctx.nav(timelinePath(pid)); } catch { /* the submit still stands */ }
    await ctx.trail.step({
      tool: "render_timeline",
      title: scope ? `Render scope — first ${scope}s` : "Render scope — whole film",
      anchor: ANCHORS.timelineScope,
    });

    let job: { job?: string };
    try {
      job = await ctx.api<{ job?: string }>(`/api/projects/${pid}/timeline/render`, {
        ...(scope ? { scope_sec: scope } : {}),
        ...(args?.container ? { container: args.container } : {}),
      });
    } catch (e) {
      if (statusOf(e) === 503) {
        return err("engine offline", {
          hint: "The FreeCut engine is not configured on this server (CUTROOM_ENGINE_DIR / CUTROOM_NODE_BIN). Use cut_film instead.",
        });
      }
      return err("render_failed", { hint: messageOf(e) });
    }
    if (!job?.job) {
      return err("render_failed", { hint: "The server accepted the request but returned no job." });
    }

    await ctx.trail.step({
      tool: "render_timeline", title: "▶ render (engine)",
      anchor: ANCHORS.timelineRender, job: job.job,
    });

    return ok(scope ? `rendering the first ${scope}s through the engine`
                    : "rendering the whole timeline through the engine", {
      project: pid,
      scope_sec: scope ?? null,
      container: args?.container || "mp4",
      jobs: [job.job],
      hint: "The render lands as a take on the project; wait_for_jobs follows the job.",
    });
  },
};
