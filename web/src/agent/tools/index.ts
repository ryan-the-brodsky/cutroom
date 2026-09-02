/**
 * The tool catalogue (workstream C). One array, in the order of
 * docs/WEBMCP-PLAN.md §4 — the registry, the WebMCP tool list and the ⌘K
 * palette are all projections of it.
 *
 * Copy deck (descriptions, param descriptions, howTo) lives in
 * `./descriptions.md`; a unit test keeps both inside the Chrome budgets.
 */
import type { ActionDef } from "../contract";
import { TOOL_NAMES } from "../contract";
import { synthesizeVo } from "./audio";
import {
  addCelLayer, listLayers, removeLayer, renderComp, rerollLayer,
  restyleBackground, setBackground, setLayer,
} from "./comp";
import { deps, installDeps, tryAdoptRealDeps } from "./deps";
import { applyPlan, directShot } from "./direct";
import { cutFilm } from "./film";
import { describeShot, findShots, getContext, listFeatures } from "./find";
import { generateTakes } from "./generate";
import { getJobs, waitForJobs } from "./jobs";
import { freezeTail, trimClip } from "./motion";
import { generateMusic, generateSfx, listCues, placeCue } from "./music";
import { openShot, showMe } from "./navigate";
import { applyMotionPlan, planMotion } from "./plan";
import { selectTake, setKeeper, setTimelineSource } from "./picks";
import {
  createProject, listProjects, setProjectCast, writeScript,
} from "./project";
import {
  exportTimeline, listBackends, renderTimeline, setLaneDefault,
} from "./settings";
import { attachReference, listReferences, removeReference } from "./references";
import { setStyle } from "./style";
import { playCut, playTake, previewTimeline, stopPlayback } from "./screen";
import { setShotTiming } from "./timing";
import { FEATURES } from "../features";
import { SCREEN_FEATURES } from "../features.screen";

/**
 * Defs are individually typed by their own argument shape; the registry takes
 * them structurally. `any` here is the variance escape hatch, not laziness —
 * `ActionDef<A>` is invariant in `A` through `where`, `summarize` and `execute`.
 */
export type AnyActionDef = ActionDef<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Catalogue order = TOOL_NAMES order = the order agents and the palette see. */
export const TOOLS: AnyActionDef[] = [
  findShots,
  describeShot,
  getContext,
  listFeatures,
  showMe,
  openShot,
  generateTakes,
  freezeTail,
  trimClip,
  selectTake,
  setKeeper,
  setTimelineSource,
  setShotTiming,
  synthesizeVo,
  directShot,
  applyPlan,
  cutFilm,
  getJobs,
  waitForJobs,
  generateMusic,
  generateSfx,
  placeCue,
  listCues,
  // workstream I — the cel workbench, then lanes / export / render
  addCelLayer,
  rerollLayer,
  restyleBackground,
  setBackground,
  setLayer,
  removeLayer,
  renderComp,
  listLayers,
  listBackends,
  setLaneDefault,
  exportTimeline,
  renderTimeline,
  // workstream K — starting a film from nothing
  createProject,
  writeScript,
  setProjectCast,
  listProjects,
  // workstream M — the screening room (watching, not making)
  playCut,
  playTake,
  stopPlayback,
  previewTimeline,
  // workstream N — motion budget planning
  planMotion,
  applyMotionPlan,
  // workstream P — the style register
  setStyle,
  // workstream S — per-shot reference images
  attachReference,
  removeReference,
  listReferences,
];

/**
 * The whole registry: tools an agent can call, plus the palette-only feature
 * entries that make `list_features` and `show_me` cover the entire application
 * rather than the subset that happens to be automatable.
 */
export const ALL_ACTIONS: AnyActionDef[] = [...TOOLS, ...FEATURES, ...SCREEN_FEATURES];

/** list_features / show_me read the catalogue through deps, so A can widen it. */
installDeps({ allActions: () => ALL_ACTIONS as never[] });

export const TOOLS_BY_NAME: Record<string, AnyActionDef> =
  Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/**
 * Registers every tool with A's registry, in catalogue order. Idempotent from
 * the caller's side: it just calls `register` once per def.
 */
export function registerAllTools(register: (def: AnyActionDef) => void): AnyActionDef[] {
  // Prefer A's real settleJobs / classifyBackend when those modules exist.
  void tryAdoptRealDeps();
  installDeps({ allActions: () => ALL_ACTIONS as never[] });
  for (const def of ALL_ACTIONS) register(def);
  return ALL_ACTIONS;
}

/** Sanity check used by the contract test and by A's smoke test. */
export function missingTools(): string[] {
  const have = new Set(TOOLS.map((t) => t.name));
  return TOOL_NAMES.filter((n) => !have.has(n));
}

export { deps, installDeps };
export * from "./deps";
export { findShots, describeShot, getContext, listFeatures } from "./find";
export { openShot, showMe } from "./navigate";
export { generateTakes } from "./generate";
export { freezeTail, trimClip } from "./motion";
export { selectTake, setKeeper, setTimelineSource } from "./picks";
export { setShotTiming } from "./timing";
export { synthesizeVo } from "./audio";
export { directShot, applyPlan } from "./direct";
export { cutFilm } from "./film";
export { getJobs, waitForJobs } from "./jobs";
export { generateMusic, generateSfx, placeCue, listCues } from "./music";
export {
  addCelLayer, listLayers, removeLayer, renderComp, rerollLayer,
  restyleBackground, setBackground, setLayer, snapRegion,
} from "./comp";
export { exportTimeline, listBackends, renderTimeline, setLaneDefault } from "./settings";
export { createProject, listProjects, setProjectCast, writeScript } from "./project";
export { STYLE_PRESETS, setStyle } from "./style";
export { attachReference, listReferences, removeReference } from "./references";
export { playCut, playTake, previewTimeline, stopPlayback, pickCut, resolveFrom } from "./screen";
export {
  applyMotionPlan, clipCost, fitBudget, framesForSeconds, motionProfile,
  planMotion, rankShots,
} from "./plan";
export { SCREEN_FEATURES } from "../features.screen";
export { FEATURES, FEATURES_BY_NAME, featureGroups, walkTo } from "../features";
