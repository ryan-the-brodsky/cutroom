/**
 * The cel workbench, as tools (workstream I).
 *
 * A comp is a background — a still plate, or a clip — plus z-ordered animated
 * cel layers merged through feathered windows or per-frame figure mattes. The
 * background is never touched by a video model unless you say so: that is the
 * whole point of the cel grammar, and it is why a Cutroom shot can hold still
 * where an end-to-end video model would boil.
 *
 * Every tool here drives `CompEditor` through its page handles, so an agent's
 * edit is the edit a human makes with the mouse. Regions are TRUE BACKGROUND
 * PIXELS (plates are 960x544 class, not 1080p) and are snapped to /32 the way
 * the server's own `snap_region` does.
 */
import type { ActionDef, CompLayerLite, CompPageHandles, ToolErr, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { deps } from "./deps";
import {
  IS_CLIP, SHOT_ROUTE, asError, costGate, cut, fetchShot, listTakes, lookupShot,
  maybeNum, pickTake, plateOf, shotUrl, type ShotDetail,
} from "./util";

const REGION_DESC =
  "[left, top, right, bottom] on the background, in its own pixels — or fractions 0-1. Snapped to /32.";
const LAYER_DESC =
  "Which layer: its id (L1, L2…), \"newest\" for the last one added, or \"selected\".";
const CEL_FRAMES = 49;   // doctrine default, same as generate_takes' animate lane

// ---------------------------------------------------------------- regions

/** Fractions 0-1 → pixels, then grow to a /32 box that stays inside the plate. */
export function snapRegion(region: number[], pw: number, ph: number): number[] {
  let [l, t, r, b] = region.map((n) => Number(n) || 0);
  if (l > r) [l, r] = [r, l];
  if (t > b) [t, b] = [b, t];
  if (l <= 1 && t <= 1 && r <= 1 && b <= 1 && r > 0 && b > 0) {
    l *= pw; r *= pw; t *= ph; b *= ph;
  }
  const grow = (lo: number, hi: number, max: number): [number, number] => {
    let a = Math.max(0, Math.floor(lo));
    let z = Math.min(max, Math.ceil(hi));
    if (z <= a) z = Math.min(max, a + 32);
    const want = Math.min(Math.max(32, Math.ceil((z - a) / 32) * 32), Math.floor(max / 32) * 32 || max);
    let need = want - (z - a);
    a -= Math.floor(need / 2);
    z += Math.ceil(need / 2);
    if (a < 0) { z -= a; a = 0; }
    if (z > max) { a -= z - max; z = max; }
    return [Math.max(0, Math.round(a)), Math.min(max, Math.round(z))];
  };
  const [L, R] = grow(l, r, pw);
  const [T, B] = grow(t, b, ph);
  return [L, T, R, B];
}

/** The background's TRUE pixels. Plates are not 1080p, so never assume. */
async function bgDims(ctx: Parameters<ActionDef["execute"]>[1], pid: string, rel: string):
  Promise<[number, number]> {
  try {
    const d = await ctx.api<{ width: number; height: number }>(
      `/api/projects/${pid}/dims/${rel}`);
    if (d?.width && d?.height) return [d.width, d.height];
  } catch { /* fall through */ }
  return [960, 544];
}

// ---------------------------------------------------------------- comps

interface CompRow {
  cid: string; shot?: string | null; background: string;
  background_kind?: "still" | "video";
  width: number; height: number; duration: number;
  layers: CompLayerLite[]; background_history?: string[];
}

const listComps = (ctx: Parameters<ActionDef["execute"]>[1], pid: string, sid: string) =>
  ctx.api<CompRow[]>(`/api/projects/${pid}/comps?shot=${encodeURIComponent(sid)}`);

type CompLookup =
  | { ok: true; comp: CompRow; created: boolean }
  | { ok: false; res: ToolErr };

/**
 * The comp a cel tool acts on: the one named, else the shot's newest, else a
 * fresh one staged on `background` (default the keeper plate) when `create`.
 */
async function resolveComp(
  ctx: Parameters<ActionDef["execute"]>[1], pid: string, shot: ShotDetail,
  want: unknown, create: boolean, background?: unknown,
): Promise<CompLookup> {
  let rows: CompRow[] = [];
  try { rows = (await listComps(ctx, pid, shot.sid)) || []; }
  catch (e) { return { ok: false, res: asError(e, "comps_unavailable", "Could not list comps") }; }

  const cid = typeof want === "string" ? want.trim() : "";
  if (cid) {
    const hit = rows.find((c) => c.cid === cid);
    if (hit) return { ok: true, comp: hit, created: false };
    return { ok: false, res: err("comp_not_found", {
      hint: `${shot.sid} has no comp "${cut(cid, 30)}". Comps here: ${
        rows.map((c) => c.cid).join(", ") || "none yet"}.`,
    }) };
  }
  if (rows.length) return { ok: true, comp: rows[rows.length - 1], created: false };
  if (!create) {
    return { ok: false, res: err("no_comp", {
      hint: `${shot.sid} has no comp yet — call add_cel_layer, which stages one on the keeper plate.`,
    }) };
  }

  // Stage a new one. A background may be a still plate or a clip.
  const hit = await pickTake(ctx, pid, shot, background ?? "keeper",
    { prefer: background ? undefined : "image" });
  const bg = hit?.path || plateOf(shot);
  if (!bg) {
    return { ok: false, res: err("no_background", {
      hint: `${shot.sid} has nothing to stage on. Generate a still first (generate_takes lane:"still").`,
    }) };
  }
  const [w, h] = await bgDims(ctx, pid, bg);
  try {
    const made = await ctx.api<CompRow>(`/api/projects/${pid}/comps`, {
      shot: shot.sid, background: bg, duration: shot.seconds ?? 4,
      width: w, height: h,
    });
    return { ok: true, comp: made, created: true };
  } catch (e) {
    return { ok: false, res: asError(e, "comp_create_failed", "Could not stage a comp") };
  }
}

/** Navigate to the Shot Editor's compose tab with this comp open, and wait. */
async function openComp(
  ctx: Parameters<ActionDef["execute"]>[1], tool: string, pid: string, sid: string, cid: string,
): Promise<{ ok: true; page: CompPageHandles } | { ok: false; res: ToolErr }> {
  const url = shotUrl(pid, sid, { tab: "compose", comp: cid });
  try {
    await ctx.nav(url);
    const page = await ctx.page.waitFor("comp", { cid });
    await ctx.trail.step({ tool, title: `Open the cel workbench — ${cid}`, detail: url });
    return { ok: true, page };
  } catch (e) {
    return { ok: false, res: err("page_did_not_mount", {
      hint: `Could not open ${url}: ${cut((e as Error)?.message, 90)}.`,
    }) };
  }
}

/** "L2" | "newest" | "selected" → a real layer id. */
function pickLayer(page: CompPageHandles, want: unknown): CompLayerLite | null {
  let state;
  try { state = page.getState(); } catch { return null; }
  const layers = state.layers || [];
  if (!layers.length) return null;
  const w = typeof want === "string" ? want.trim() : "";
  if (!w || /^(newest|latest|last|it|this)$/i.test(w)) return layers[layers.length - 1];
  if (/^(selected|current)$/i.test(w)) {
    return layers.find((L) => L.id === state.selected) || layers[layers.length - 1];
  }
  return layers.find((L) => L.id.toLowerCase() === w.toLowerCase()) || null;
}

const layerRow = (L: CompLayerLite) => ({
  id: L.id,
  region: L.region.map((n) => Math.round(n)),
  z: L.z ?? 0,
  opacity: L.opacity ?? 1,
  matte: L.matte || "window",
  variants: L.variants ?? 0,
  ...(L.figure ? { figure: true } : {}),
  ...(L.clip ? {} : { pending: true }),
  prompt: cut(L.prompt, 44),
});

const noLayer = (want: unknown, page: CompPageHandles): ToolErr => {
  let ids: string[] = [];
  try { ids = page.getState().layers.map((L) => L.id); } catch { /* none */ }
  return err("layer_not_found", {
    hint: `No layer matches "${cut(want ?? "newest", 24)}". This comp has: ${
      ids.join(", ") || "no layers yet"}.`,
  });
};

// ---------------------------------------------------------------- add_cel_layer

interface AddArgs {
  shot: string; region: number[]; prompt: string;
  frames?: number; comp?: string; background?: string; confirm_cost?: boolean;
}

export const addCelLayer: ActionDef<AddArgs> = {
  name: "add_cel_layer",
  title: "Add a cel layer",
  description:
    "Animate one region of a shot as a cel layer over a background that stays " +
    "put — the ink-first grammar: name only what moves (\"only the hand turns " +
    "the dial\"), and the rest of the frame never boils. Draws the region on the " +
    "cel workbench, fills the motion prompt and submits. Creates the comp from " +
    "the keeper plate (or `background`, which may be a clip) when the shot has " +
    "none. Regions are background pixels, snapped to /32. Paid backends need confirm_cost.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: REGION_DESC },
      prompt: { type: "string", description: "Motion prompt for this cel. Name ONLY what moves; the rest of the frame is the background's job." },
      frames: { type: "integer", description: `Cel length in frames at 24fps. Default ${CEL_FRAMES} (about two seconds).` },
      comp: { type: "string", description: "Which comp to add to. Default: the shot's newest, or a new one staged on the keeper." },
      background: { type: "string", description: "Only when creating the comp: \"keeper\", \"newest motion\", \"plays\", or a take path. A clip gives a moving background." },
      confirm_cost: { type: "boolean", description: "True approves a paid motion backend. Required when the motion lane costs money." },
    },
    required: ["shot", "region", "prompt"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compNewSubmit,
           label: "Shot Editor → compose → new cel" },
  keywords: ["cel", "layer", "comp", "animate region", "ink first", "only the hand", "composition"],
  howTo:
    "Open the shot's compose tab, drag a box on the stage over what should move, type a motion " +
    "prompt naming only that, and press ▶ add layer & generate cel.",
  summarize: (a) => `Add a cel to ${cut(a?.shot, 20)}: ${cut(a?.prompt, 34)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) {
      return err("needs_prompt", { hint: "Say what moves, e.g. \"only the hand turns the dial\"." });
    }
    const region = Array.isArray(args?.region) ? args.region : [];
    if (region.length !== 4) {
      return err("needs_region", { hint: `region is ${REGION_DESC}` });
    }

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const choice = await deps.classifyBackend(pid, "motion", undefined, ctx.api);
    const gate = costGate(choice, 1, "cel", args?.confirm_cost === true);
    if (gate) return gate;

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, true, args?.background);
    if (!resolved.ok) return resolved.res;
    const comp = resolved.comp;

    const [pw, ph] = await bgDims(ctx, pid, comp.background);
    const snapped = snapRegion(region, pw, ph);

    const opened = await openComp(ctx, "add_cel_layer", pid, shot.sid, comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    page.setNewRegion(snapped);
    await ctx.trail.step({
      tool: "add_cel_layer", title: `Draw the region [${snapped.join(", ")}]`,
      anchor: ANCHORS.compStage, detail: `${pw}×${ph} plate`,
    });
    page.setNewPrompt(prompt);
    await ctx.trail.step({
      tool: "add_cel_layer", title: "Fill the motion prompt",
      anchor: ANCHORS.compNewPrompt, detail: cut(prompt, 80),
    });

    let submitted: { job: string; layer?: string };
    try {
      submitted = await page.submitLayer({
        frames: Math.round(maybeNum(args?.frames) ?? CEL_FRAMES),
      });
    } catch (e) { return asError(e, "layer_submit_failed", "The cel did not queue"); }

    await ctx.trail.step({
      tool: "add_cel_layer", title: `▶ generate cel ${submitted.layer || ""}`.trim(),
      anchor: ANCHORS.compNewSubmit, job: submitted.job,
    });

    const settled = await deps.settleJobs([submitted.job].filter(Boolean),
      { settleMs: 8000, signal: ctx.signal, api: ctx.api });
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${submitted.layer || "the new layer"} is generating on ${comp.cid}`, {
      shot: shot.sid,
      comp: comp.cid,
      ...(resolved.created ? { comp_created: true, background: cut(comp.background, 60) } : {}),
      background_kind: comp.background_kind ||
        (IS_CLIP(comp.background) ? "video" : "still"),
      layer: submitted.layer ?? null,
      region: snapped,
      plate: [pw, ph],
      frames: Math.round(maybeNum(args?.frames) ?? CEL_FRAMES),
      backend: choice.backend,
      cost_class: choice.cost_class,
      jobs: [submitted.job],
      status: settled[0]?.status ?? "running",
      hint: "The comp auto-renders when the cel lands; render_comp forces one.",
    });
  },
};

// ---------------------------------------------------------------- reroll_layer

interface RerollArgs {
  shot: string; layer?: string; prompt?: string; seed?: number;
  backend?: string; model?: string; comp?: string; confirm_cost?: boolean;
}

export const rerollLayer: ActionDef<RerollArgs> = {
  name: "reroll_layer",
  title: "Reroll a cel layer",
  description:
    "Generate another take of one cel layer, leaving the background and every " +
    "other layer untouched — the comparison take. Same prompt and a fresh seed " +
    "by default; pass prompt, seed, backend or model to direct it. Every take a " +
    "layer has ever had stays in its variants strip, so nothing is overwritten. " +
    "Opens the workbench, selects the layer and presses reroll. Paid backends need confirm_cost.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      layer: { type: "string", description: LAYER_DESC },
      prompt: { type: "string", description: "A new motion prompt for this cel. Default: keep the layer's own prompt." },
      seed: { type: "integer", description: "Fix the seed to reproduce a take. Default: a fresh random seed." },
      backend: { type: "string", description: "Motion backend id, e.g. \"mock\" or \"fal\". Default: the project's motion lane." },
      model: { type: "string", description: "Model id on that backend. Default: the backend's own default." },
      comp: { type: "string", description: "Which comp the layer belongs to. Default: the shot's newest comp." },
      confirm_cost: { type: "boolean", description: "True approves a paid motion backend. Required when the motion lane costs money." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compLayerReroll,
           label: "Shot Editor → compose → layer → reroll" },
  keywords: ["reroll", "layer", "cel", "another take", "again", "variant", "comp"],
  howTo:
    "In the compose tab, find the layer's card and press 🎲 reroll — or 🎛 directed reroll to " +
    "change its prompt, seed or model first.",
  summarize: (a) => `Reroll ${cut(a?.layer ?? "the newest layer", 20)} on ${cut(a?.shot, 20)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const choice = await deps.classifyBackend(pid, "motion", args?.backend, ctx.api);
    const gate = costGate(choice, 1, "cel", args?.confirm_cost === true);
    if (gate) return gate;

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, false);
    if (!resolved.ok) return resolved.res;

    const opened = await openComp(ctx, "reroll_layer", pid, shot.sid, resolved.comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    const L = pickLayer(page, args?.layer);
    if (!L) return noLayer(args?.layer, page);

    page.selectLayer(L.id);
    await ctx.trail.step({
      tool: "reroll_layer", title: `Select layer ${L.id}`,
      anchor: ANCHORS.compLayerSelect, detail: cut(L.prompt, 70),
    });

    const directed = Boolean(args?.prompt || args?.seed || args?.backend || args?.model);
    let job: { job: string };
    try {
      job = await page.rerollLayer(L.id, {
        ...(args?.prompt ? { prompt: String(args.prompt) } : {}),
        ...(maybeNum(args?.seed) !== undefined ? { seed: maybeNum(args?.seed) } : {}),
        ...(args?.backend ? { backend: args.backend } : {}),
        ...(args?.model ? { model: args.model } : {}),
      });
    } catch (e) { return asError(e, "reroll_failed", "The reroll did not queue"); }

    await ctx.trail.step({
      tool: "reroll_layer",
      title: `${directed ? "🎛 directed reroll" : "🎲 reroll"} ${L.id}`,
      anchor: directed ? ANCHORS.compRerollSubmit : ANCHORS.compLayerReroll,
      job: job.job,
    });

    const settled = await deps.settleJobs([job.job], { settleMs: 8000, signal: ctx.signal, api: ctx.api });
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${L.id} is rerolling on ${resolved.comp.cid}`, {
      shot: shot.sid, comp: resolved.comp.cid, layer: L.id,
      directed,
      prompt: cut(args?.prompt ?? L.prompt, 70),
      backend: choice.backend, cost_class: choice.cost_class,
      jobs: [job.job], status: settled[0]?.status ?? "running",
      hint: "The old cel stays as a variant — nothing is overwritten.",
    });
  },
};

// ---------------------------------------------------------------- restyle_background

interface BgArgs {
  shot: string; prompt: string; mode?: "edit" | "regen";
  strength?: number; comp?: string; confirm_cost?: boolean;
}

export const restyleBackground: ActionDef<BgArgs> = {
  name: "restyle_background",
  title: "Restyle the plate",
  description:
    "Change the comp's background plate while every cel layer stays exactly " +
    "where it is. mode \"edit\" keeps this plate and follows guidance (strength " +
    "0.55 holds the staged geometry, 0.85+ redesigns); mode \"regen\" paints a " +
    "brand-new plate from a full image prompt. Every previous plate stays " +
    "toggleable in the comp's background history. Still plates only — a clip " +
    "background is footage, so animate a new clip and set_background instead.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      prompt: { type: "string", description: "Edit guidance (\"warmer, dusk light\") for mode edit, or the full image prompt for mode regen." },
      mode: { type: "string", enum: ["edit", "regen"], description: "\"edit\" keeps this plate and guides it; \"regen\" paints a new one. Default edit." },
      strength: { type: "number", minimum: 0.35, maximum: 0.95, description: "Edit mode only: how much may change. 0.55 keeps the staging, 0.85+ redesigns. Default 0.55." },
      comp: { type: "string", description: "Which comp to restyle. Default: the shot's newest comp." },
      confirm_cost: { type: "boolean", description: "True approves a paid image backend. Required when the still or i2i lane costs money." },
    },
    required: ["shot", "prompt"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compBgSubmit,
           label: "Shot Editor → compose → Background" },
  keywords: ["background", "plate", "restyle", "regenerate", "warmer", "relight", "comp"],
  howTo:
    "In the compose tab, scroll to Background, choose ✎ edit this plate or 🎲 regenerate, type what " +
    "should change, and press the button beside it.",
  summarize: (a) => `Restyle ${cut(a?.shot, 18)}'s plate: ${cut(a?.prompt, 30)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) {
      return err("needs_prompt", { hint: "Say what the plate should become, e.g. \"warmer, late dusk\"." });
    }
    const mode: "edit" | "regen" = args?.mode === "regen" ? "regen" : "edit";

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, false);
    if (!resolved.ok) return resolved.res;
    const comp = resolved.comp;

    if (comp.background_kind === "video" || IS_CLIP(comp.background)) {
      return err("background_is_a_clip", {
        comp: comp.cid,
        background: cut(comp.background, 60),
        hint: "Restyle applies to still plates. Animate a new clip and call set_background with it.",
      });
    }

    const lane = mode === "regen" ? "still" : "i2i";
    const choice = await deps.classifyBackend(pid, lane, undefined, ctx.api);
    const gate = costGate(choice, 1, "plate", args?.confirm_cost === true);
    if (gate) return gate;

    const opened = await openComp(ctx, "restyle_background", pid, shot.sid, comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    const strength = Math.min(0.95, Math.max(0.35, maybeNum(args?.strength) ?? 0.55));
    page.setBgField("mode", mode);
    await ctx.trail.step({
      tool: "restyle_background",
      title: mode === "edit" ? "✎ edit this plate" : "🎲 regenerate from scratch",
      anchor: ANCHORS.compBgMode,
    });
    page.setBgField("prompt", prompt);
    if (mode === "edit") page.setBgField("strength", strength);
    await ctx.trail.step({
      tool: "restyle_background", title: "Fill the plate prompt",
      anchor: ANCHORS.compBgPrompt, detail: cut(prompt, 80),
    });

    let job: { job: string };
    try { job = await page.submitBackground(); }
    catch (e) { return asError(e, "background_submit_failed", "The plate job did not queue"); }

    await ctx.trail.step({
      tool: "restyle_background", title: mode === "edit" ? "✎ apply edit" : "🎲 regenerate",
      anchor: ANCHORS.compBgSubmit, job: job.job,
    });

    const settled = await deps.settleJobs([job.job], { settleMs: 8000, signal: ctx.signal, api: ctx.api });
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${comp.cid}'s plate is ${mode === "edit" ? "being edited" : "being regenerated"}`, {
      shot: shot.sid, comp: comp.cid, mode,
      ...(mode === "edit" ? { strength } : {}),
      lane, backend: choice.backend, cost_class: choice.cost_class,
      previous_plate: cut(comp.background, 60),
      layers_kept: comp.layers?.length ?? 0,
      jobs: [job.job], status: settled[0]?.status ?? "running",
      hint: "Old plates stay in the background history — click one to switch back.",
    });
  },
};

// ---------------------------------------------------------------- set_background

interface SetBgArgs { shot: string; take: string; comp?: string }

export const setBackground: ActionDef<SetBgArgs> = {
  name: "set_background",
  title: "Set the comp background",
  description:
    "Point a comp at a different background — any take, still or clip. A still " +
    "is the classic cel plate that never shimmers; a clip gives a MOVING " +
    "background under the cel layers, which is how a comp holds camera motion " +
    "without the figures boiling. Every layer keeps its region and its takes, " +
    "the old background stays toggleable in the history, and the composite " +
    "re-renders. Accepts a path or \"newest motion\", \"keeper\", \"plays\".",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      take: { type: "string", description: "The new background: a take path, or \"keeper\", \"newest still\", \"newest motion\", \"plays\"." },
      comp: { type: "string", description: "Which comp to repoint. Default: the shot's newest comp." },
    },
    required: ["shot", "take"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compBgPlate,
           label: "Shot Editor → compose → Background" },
  keywords: ["background", "plate", "moving background", "clip background", "swap", "comp"],
  howTo:
    "In the compose tab's Background row, click one of the stored backgrounds — or press 🎬 compose " +
    "on this on any take in the rail to stage a comp on it.",
  summarize: (a) => `Set ${cut(a?.shot, 18)}'s background to ${cut(a?.take, 26)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const hit = await pickTake(ctx, pid, detail, args?.take, {});
    if (!hit) {
      return err("take_not_found", {
        hint: `No take on ${shot.sid} matches "${cut(args?.take, 26)}". Try "keeper" or "newest motion".`,
      });
    }

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, true, hit.path);
    if (!resolved.ok) return resolved.res;
    const comp = resolved.comp;

    const opened = await openComp(ctx, "set_background", pid, shot.sid, comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    const kind = IS_CLIP(hit.path) ? "video" : "still";
    if (comp.background === hit.path) {
      return ok(`${comp.cid} already runs on ${cut(hit.path.split("/").pop(), 40)}`, {
        shot: shot.sid, comp: comp.cid, background: cut(hit.path, 60),
        background_kind: kind, changed: false,
      });
    }

    try { await page.setBackground(hit.path); }
    catch (e) { return asError(e, "background_rejected", "The server refused the background"); }

    await ctx.trail.step({
      tool: "set_background",
      title: `Background → ${cut(hit.path.split("/").pop(), 30)}${kind === "video" ? " (moving)" : ""}`,
      anchor: ANCHORS.compBgPlate, detail: hit.path,
    });
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${comp.cid} now runs on ${kind === "video" ? "a moving clip" : "a still plate"}`, {
      shot: shot.sid, comp: comp.cid,
      background: cut(hit.path, 60),
      background_kind: kind,
      previous: cut(comp.background, 60),
      layers_kept: comp.layers?.length ?? 0,
      hint: kind === "video"
        ? "restyle_background is refused on a clip — swap in another clip instead."
        : "The plate never shimmers; only the cel layers move.",
    });
  },
};

// ---------------------------------------------------------------- set_layer

interface SetLayerArgs {
  shot: string; layer?: string; opacity?: number;
  z?: string | number; matte?: "window" | "figure"; region?: number[]; comp?: string;
}

export const setLayer: ActionDef<SetLayerArgs> = {
  name: "set_layer",
  title: "Adjust a cel layer",
  description:
    "Adjust one cel layer in place: opacity, stacking order (\"front\", \"back\" " +
    "or an explicit z), matte mode (\"window\" is a feathered rectangle, " +
    "\"figure\" cuts a per-frame anime matte so only the figure lands on the " +
    "plate) and its region. Everything you pass is written in ONE edit, so the " +
    "composite re-renders once rather than once per field. The cel itself is not " +
    "regenerated — use reroll_layer for that.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      layer: { type: "string", description: LAYER_DESC },
      opacity: { type: "number", minimum: 0.1, maximum: 1, description: "How strongly the cel reads over the background. 1 is solid, 0.5 is a ghost." },
      z: { type: "string", description: "Stacking: \"front\", \"back\", or a number. Higher z draws over lower z." },
      matte: { type: "string", enum: ["window", "figure"], description: "\"window\" = feathered rectangle; \"figure\" = per-frame anime matte, only the figure lands." },
      region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: `Move or resize the cel. ${REGION_DESC}` },
      comp: { type: "string", description: "Which comp the layer belongs to. Default: the shot's newest comp." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compLayerOpacity,
           label: "Shot Editor → compose → layer controls" },
  keywords: ["opacity", "z order", "front", "back", "matte", "figure", "window", "move layer", "resize"],
  howTo:
    "On the layer's card use the opacity slider, the ▲/▼ z buttons and the matte dropdown; drag the " +
    "cel on the stage (or nudge it with the arrow keys) to move it.",
  summarize: (a) => `Adjust ${cut(a?.layer ?? "the newest layer", 18)} on ${cut(a?.shot, 20)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, false);
    if (!resolved.ok) return resolved.res;
    const comp = resolved.comp;

    const opened = await openComp(ctx, "set_layer", pid, shot.sid, comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    const L = pickLayer(page, args?.layer);
    if (!L) return noLayer(args?.layer, page);

    const state = page.getState();
    const patch: Record<string, unknown> = {};
    const opacity = maybeNum(args?.opacity);
    if (opacity !== undefined) patch.opacity = Math.min(1, Math.max(0.1, opacity));
    if (args?.matte === "window" || args?.matte === "figure") patch.matte = args.matte;
    if (args?.z !== undefined && args.z !== null && args.z !== "") {
      const zs = state.layers.map((x) => x.z ?? 0);
      const word = String(args.z).trim().toLowerCase();
      if (/^(front|top|over|above)$/.test(word)) patch.z = Math.max(...zs, 0) + 1;
      else if (/^(back|bottom|under|behind)$/.test(word)) patch.z = Math.min(...zs, 0) - 1;
      else if (maybeNum(args.z) !== undefined) patch.z = maybeNum(args.z);
    }
    let snapped: number[] | null = null;
    if (Array.isArray(args?.region) && args.region.length === 4) {
      const dims = state.plate ?? (await bgDims(ctx, pid, comp.background));
      snapped = snapRegion(args.region, dims[0], dims[1]);
      patch.region = snapped;
    }
    if (!Object.keys(patch).length) {
      return err("nothing_to_set", {
        layer: L.id,
        hint: "Pass at least one of opacity, z, matte or region.",
      });
    }

    page.selectLayer(L.id);
    await ctx.trail.step({
      tool: "set_layer", title: `Select layer ${L.id}`, anchor: ANCHORS.compLayerSelect,
    });

    // ONE write for the whole patch: the workbench's auto-render debounce then
    // renders the composite exactly once.
    try { await page.patchLayer(L.id, patch); }
    catch (e) { return asError(e, "layer_update_failed", "The server refused the change"); }

    const anchor = patch.opacity !== undefined ? ANCHORS.compLayerOpacity
      : patch.z !== undefined ? ANCHORS.compLayerZ
        : patch.matte !== undefined ? ANCHORS.compLayerMatte : ANCHORS.compStage;
    await ctx.trail.step({
      tool: "set_layer",
      title: `${L.id}: ${Object.keys(patch).join(", ")}`,
      anchor, detail: JSON.stringify(patch).slice(0, 90),
    });
    try { await page.refresh(); } catch { /* fine */ }

    return ok(`${L.id} updated (${Object.keys(patch).join(", ")})`, {
      shot: shot.sid, comp: comp.cid, layer: L.id,
      applied: patch,
      before: { z: L.z ?? 0, opacity: L.opacity ?? 1, matte: L.matte || "window",
                region: L.region.map((n) => Math.round(n)) },
      hint: "The composite re-renders about a second and a half after the last edit.",
    });
  },
};

// ---------------------------------------------------------------- remove_layer

interface RemoveArgs { shot: string; layer?: string; comp?: string }

export const removeLayer: ActionDef<RemoveArgs> = {
  name: "remove_layer",
  title: "Remove a cel layer",
  description:
    "Take one cel layer out of a comp. The background and the other layers are " +
    "untouched, and the composite re-renders without it. The layer's generated " +
    "clips stay on disk as takes, so this is a composition decision, not a " +
    "delete — restage it with add_cel_layer if you change your mind. Defaults to " +
    "the newest layer when none is named.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      layer: { type: "string", description: LAYER_DESC },
      comp: { type: "string", description: "Which comp the layer belongs to. Default: the shot's newest comp." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compLayerRemove,
           label: "Shot Editor → compose → layer → remove" },
  keywords: ["remove", "delete layer", "drop cel", "undo layer", "comp"],
  howTo: "Press remove on the layer's card in the compose tab, or select it on the stage and hit delete.",
  summarize: (a) => `Remove ${cut(a?.layer ?? "the newest layer", 18)} from ${cut(a?.shot, 20)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, false);
    if (!resolved.ok) return resolved.res;

    const opened = await openComp(ctx, "remove_layer", pid, shot.sid, resolved.comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    const L = pickLayer(page, args?.layer);
    if (!L) return noLayer(args?.layer, page);

    page.selectLayer(L.id);
    try { await page.removeLayer(L.id); }
    catch (e) { return asError(e, "remove_failed", "The server refused the removal"); }

    await ctx.trail.step({
      tool: "remove_layer", title: `Remove layer ${L.id}`,
      anchor: ANCHORS.compLayerRemove, detail: cut(L.prompt, 70),
    });
    try { await page.refresh(); } catch { /* fine */ }

    let left = 0;
    try { left = page.getState().layers.length; } catch { /* fine */ }
    return ok(`${L.id} is out of ${resolved.comp.cid}`, {
      shot: shot.sid, comp: resolved.comp.cid, removed: L.id,
      was: { region: L.region.map((n) => Math.round(n)), prompt: cut(L.prompt, 50) },
      layers_left: left,
      hint: "Its clips are still in the takes rail — the composition changed, nothing was deleted.",
    });
  },
};

// ---------------------------------------------------------------- render_comp

interface RenderArgs { shot: string; comp?: string; promote?: boolean }

export const renderComp: ActionDef<RenderArgs> = {
  name: "render_comp",
  title: "Render the composite",
  description:
    "Render the comp into one clip: the background (a still plate, or a clip " +
    "playing under everything) with every cel layer merged through its matte, " +
    "at the comp's duration. Runs on the CPU pool and costs nothing. Pass " +
    "promote:true to also make the finished composite what this shot plays in " +
    "the cut, which is the usual last step of a cel build. Returns the job and, " +
    "when it lands quickly, the rendered take.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      comp: { type: "string", description: "Which comp to render. Default: the shot's newest comp." },
      promote: { type: "boolean", description: "True also sets the finished composite as the shot's timeline source (the ⬆ button)." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compRender,
           label: "Shot Editor → compose → render composite" },
  keywords: ["render", "composite", "comp", "flatten", "merge layers", "use in timeline"],
  howTo:
    "Press ▶ render composite at the bottom of the compose tab; when it finishes, ⬆ use in timeline " +
    "makes it what the shot plays.",
  summarize: (a) => `Render ${cut(a?.shot, 22)}'s composite${a?.promote ? " and use it" : ""}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let detail: ShotDetail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const resolved = await resolveComp(ctx, pid, detail, args?.comp, false);
    if (!resolved.ok) return resolved.res;
    const comp = resolved.comp;

    const opened = await openComp(ctx, "render_comp", pid, shot.sid, comp.cid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    let job: { job: string };
    try { job = await page.renderComp(); }
    catch (e) { return asError(e, "render_failed", "The render did not queue"); }

    await ctx.trail.step({
      tool: "render_comp", title: `▶ render composite — ${comp.cid}`,
      anchor: ANCHORS.compRender, job: job.job,
    });

    const settled = await deps.settleJobs([job.job],
      { settleMs: 20000, signal: ctx.signal, api: ctx.api });
    try { await page.refresh(); } catch { /* fine */ }

    const done = settled[0]?.status === "done";
    let take = settled[0]?.takes?.[0]?.path ?? null;
    if (!take) { try { take = page.getState().render; } catch { /* fine */ } }

    let promoted: string | null = null;
    if (args?.promote === true) {
      if (!done || !take) {
        return ok(`${comp.cid} is still rendering`, {
          shot: shot.sid, comp: comp.cid, jobs: [job.job],
          status: settled[0]?.status ?? "running", promoted: false,
          hint: "Call wait_for_jobs, then render_comp again with promote:true (or set_timeline_source).",
        });
      }
      try {
        const res = await page.promote(take);
        promoted = res.path;
        await ctx.trail.step({
          tool: "render_comp", title: "⬆ use in timeline",
          anchor: ANCHORS.compPromote, detail: promoted,
        });
      } catch (e) { return asError(e, "promote_failed", "The composite rendered but could not be promoted"); }
    }

    return ok(`${comp.cid} ${done ? "rendered" : "is rendering"}${promoted ? " and now plays in the cut" : ""}`, {
      shot: shot.sid, comp: comp.cid,
      layers: comp.layers?.length ?? 0,
      background_kind: comp.background_kind || (IS_CLIP(comp.background) ? "video" : "still"),
      duration: comp.duration,
      jobs: [job.job], status: settled[0]?.status ?? "running",
      take: take ? cut(take, 60) : null,
      plays: promoted ? cut(promoted, 60) : null,
      ...(settled[0]?.error ? { job_error: cut(settled[0].error, 90) } : {}),
    });
  },
};

// ---------------------------------------------------------------- list_layers

interface ListArgs { shot: string; comp?: string }

export const listLayers: ActionDef<ListArgs> = {
  name: "list_layers",
  title: "List a shot's cel layers",
  description:
    "Read a shot's compositions without changing anything: each comp's " +
    "background (and whether it is a still plate or a moving clip), its " +
    "duration, how many alternative plates are stored, and every cel layer with " +
    "its region, prompt, z order, opacity, matte mode and how many takes it has. " +
    "Call it before reroll_layer or set_layer so you name a layer that exists, " +
    "or to answer \"what is in this comp?\".",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      comp: { type: "string", description: "Only this comp. Default: every comp on the shot." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: SHOT_ROUTE, query: { tab: "compose" }, anchor: ANCHORS.compStage,
           label: "Shot Editor → compose" },
  keywords: ["layers", "comp", "list", "what is in", "cels", "composition", "inspect"],
  howTo: "Open the shot's compose tab — the layer stack is listed under the stage, newest last.",
  summarize: (a) => `List the cel layers on ${cut(a?.shot, 26)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    let rows: CompRow[];
    try { rows = (await listComps(ctx, pid, shot.sid)) || []; }
    catch (e) { return asError(e, "comps_unavailable", "Could not list comps"); }

    const wanted = typeof args?.comp === "string" && args.comp.trim()
      ? rows.filter((c) => c.cid === args.comp!.trim()) : rows;
    if (!wanted.length) {
      const takes = await listTakes(ctx, pid, shot.sid);
      return ok(`${shot.sid} has no comps yet`, {
        shot: shot.sid, comps: [],
        takes: takes.length,
        hint: "add_cel_layer stages one on the keeper plate; set_background can put a clip under it.",
      });
    }

    return ok(`${shot.sid}: ${wanted.length} comp${wanted.length === 1 ? "" : "s"}`, {
      shot: shot.sid,
      comps: wanted.slice(0, 4).map((c) => ({
        cid: c.cid,
        background: cut(c.background.split("/").pop(), 40),
        background_kind: c.background_kind || (IS_CLIP(c.background) ? "video" : "still"),
        duration: c.duration,
        stored_backgrounds: (c.background_history?.length ?? 0) + 1,
        layers: (c.layers || []).slice(0, 6).map(layerRow),
      })),
    });
  },
};
