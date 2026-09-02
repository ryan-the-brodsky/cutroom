/**
 * Genga Studio agent layer — the shared contract.
 *
 * FROZEN AT G0 (2026-09-01). Every workstream imports from here; nobody edits this file
 * without the architect. See docs/WEBMCP-PLAN.md §3 for the design and
 * docs/research/webmcp-api-brief.md for the WebMCP API this targets.
 *
 * One registry, three surfaces: WebMCP tools (document.modelContext), the ⌘K palette,
 * and "show me". Tools execute THROUGH the UI the human is looking at.
 */

// ---------------------------------------------------------------- budgets (Chrome guidance)

export const BUDGETS = {
  name: 30,          // tool name length; regex below
  description: 500,  // tool description chars
  param: 150,        // per-parameter description chars
  output: 1500,      // serialized result chars
} as const;

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,29}$/;

// ---------------------------------------------------------------- JSON schema (minimal)

export type JSONSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  enum?: (string | number)[];
  items?: JSONSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  additionalProperties?: boolean;
};

// ---------------------------------------------------------------- where a feature lives

export type Anchor = string; // a data-action value, see ANCHORS

export interface Where {
  route: string;                        // "/p/:pid/shot/:sid" (":pid"/":sid" substituted)
  query?: Record<string, string>;       // { tab: "generate", sub: "still" }
  anchor?: Anchor;                      // control to pulse when we arrive
  label: string;                        // "Shot Editor → Generate → Still"
}

// ---------------------------------------------------------------- results

export type ToolOk = { ok: true; summary: string; [k: string]: unknown };
export type ToolErr = {
  ok: false;
  error: string;                        // short machine-ish reason, e.g. "needs_confirmation"
  hint?: string;                        // what the agent should do next
  candidates?: unknown[];               // for ambiguity
  [k: string]: unknown;
};
export type ToolResult = ToolOk | ToolErr;

// ---------------------------------------------------------------- page handles

export type ShotTab = "compose" | "generate" | "motion" | "audio" | "script";
export type GenSub = "still" | "restyle" | "animate" | "chain";
export type KindFilter = "all" | "stills" | "i2i" | "motion" | "fx" | "crops";
export type GenField =
  | "prompt" | "negative" | "seeds" | "denoise" | "frames" | "seconds" | "steps" | "cfg"
  | "freeze_after" | "fullFrame" | "region" | "backend" | "model" | "beats"
  /** One-off reference images for the next submit: [{image, role}]. */
  | "references"
  /**
   * WHICH IMAGE the next generation starts from: "keeper" (the default plate),
   * "selected" (whatever is on the monitor) or an explicit take path. Animate
   * and chain read it as the plate; restyle reads it as the source frame.
   */
  | "source";
export type VoField = "text" | "voice" | "backend" | "treatment";

// ---------------------------------------------------------------- cues (music & SFX)

export type CueKind = "music" | "sfx";
/** Fields of the Audio tab's "Music & SFX" console. */
export type CueField = "prompt" | "seconds" | "instrumental" | "influence" | "gain";

/**
 * A cue placed on the film's audio bed. Anchor it absolutely (`start`, film
 * seconds) or to a shot (`shot`, which follows the shot when timing changes).
 * `gain` is DECIBELS: 0 is unity, negative rides under the VO.
 */
export interface CuePlacement {
  kind: CueKind;
  path: string;                       // project-relative, e.g. audio/music/theme.mp3
  start?: number;                     // absolute film seconds
  shot?: string;                      // sid anchor (wins over start)
  offset?: number;                    // seconds added to the anchor
  duration?: number;
  gain?: number;                      // dB
  fade_in?: number;
  fade_out?: number;
  loop?: boolean;
  label?: string;
}

export interface CueRecord extends CuePlacement {
  id: string;
  at?: number | null;                 // resolved film seconds (null = out of scope)
  exists?: boolean;
}

export interface TakeLite {
  path: string; kind: string; created?: string; seed?: number | null;
  duration?: number | null; job?: string | null; mock?: boolean;
}

/** What a reference image is FOR — the sentence the server puts in front of it. */
export type RefRole = "character" | "prop" | "setting" | "style";

/**
 * One reference attached to a shot (workstream S). The server keeps these on
 * `override.refs` and sends them to the model ahead of the prompt, each behind
 * its role sentence. Four per shot, most recent last.
 */
export interface ShotReference { path: string; role: RefRole; note?: string }

export interface ShotPageHandles {
  kind: "shot";
  pid: string;
  sid: string;
  getState(): {
    tab: ShotTab; sub: GenSub; kindFilter: KindFilter;
    selected: string | null; activeSource: string | null; keeper: string | null;
    takes: TakeLite[];
    /** The image the animate / chain console would submit right now, resolved
     *  from the `source` field — so a tool can report what it actually used. */
    genSource?: string | null;
  };
  setTab(tab: ShotTab): void;
  setSub(sub: GenSub): void;
  setKindFilter(kind: KindFilter): void;
  selectTake(path: string | null): void;
  setGenField(sub: GenSub, field: GenField, value: unknown): void;
  /** Same handler the ▶ button calls. Resolves with the submitted job. */
  submitGenerate(sub: GenSub): Promise<{ job: string; pool?: string }>;
  setLive(seconds: number): void;
  submitFreeze(): Promise<{ job: string }>;
  submitTrim(endSeconds: number): Promise<{ job: string }>;
  setVoField(field: VoField, value: unknown): void;
  submitVo(): Promise<{ job: string }>;
  /** The Music & SFX console: same fields the two ▶ buttons read. */
  setCueField(kind: CueKind, field: CueField, value: unknown): void;
  submitMusic(): Promise<{ job: string }>;
  submitSfx(): Promise<{ job: string }>;
  /** Place a cue on the film (the shot's cue list), and remove one by id. */
  addCue(cue: CuePlacement): Promise<CueRecord>;
  removeCue(id: string): Promise<void>;
  setKeeper(path: string, note?: string): Promise<void>;
  setSource(path: string | null): Promise<void>;
  setOverride(patch: Record<string, unknown>): Promise<void>;
  /** The Generate tab's References strip: attach a take, drop one by path/role/"all". */
  addReference(ref: ShotReference): Promise<ShotReference[]>;
  removeReference(which: string): Promise<ShotReference[]>;
  references(): ShotReference[];
  /** Types into the Direct box and compiles; shows the PlanPreview. Never applies. */
  direct(instruction: string): Promise<{ plan?: unknown; error?: string }>;
  applyPlan(plan: unknown): Promise<{ results: unknown[]; note?: string }>;
  refresh(): Promise<void>;
}

export interface FilmShotLite {
  sid: string; ordinal: number; beat?: string; act?: number; type?: string;
  seconds?: number; keeper?: string | null; active_source?: string | null;
}

export interface FilmPageHandles {
  kind: "film";
  pid: string;
  getState(): {
    selected: string | null; scope: string; res: string;
    shots: FilmShotLite[]; cues: CueRecord[];
  };
  selectShot(sid: string | null): void;
  setScope(scope: string): void;
  setRes(res: "720" | "1080"): void;
  cutFilm(): Promise<{ job: string }>;
  setOverride(sid: string, patch: Record<string, unknown>): Promise<void>;
  addCue(cue: CuePlacement): Promise<CueRecord>;
  removeCue(id: string): Promise<void>;
  refresh(): Promise<void>;
}

// ---------------------------------------------------------------- comp (the cel workbench)

export type BgMode = "edit" | "regen";
export type MatteMode = "window" | "figure";
/** Fields of the Background console under the layer stack. */
export type BgField = "prompt" | "mode" | "strength";

export interface CompLayerLite {
  id: string;
  clip: string | null;
  /** [l, t, r, b] in TRUE plate pixels — plates are 960x544 class, not 1080p. */
  region: number[];
  prompt?: string;
  z?: number;
  opacity?: number;
  matte?: string;
  variants?: number;
  /** A separated-figure layer (its cel animates from the original plate). */
  figure?: boolean;
}

/**
 * The cel workbench (`CompEditor`), which mounts INSIDE the Shot Editor's compose tab as
 * well as standalone on `/p/:pid/comp/:cid`. It registers alongside the page it lives in,
 * so `ctx.page.current()` still reports the shot; ask for the workbench by kind:
 * `ctx.page.waitFor("comp", { cid })`.
 */
export interface CompPageHandles {
  kind: "comp";
  pid: string;
  cid: string;
  sid: string | null;
  getState(): {
    cid: string; shot: string | null; background: string; duration: number;
    /** A comp background is a still plate or a clip; both stream. */
    backgroundKind: "still" | "video";
    /** True background pixels, once measured. */
    plate: [number, number] | null;
    layers: CompLayerLite[];
    selected: string | null;
    backgrounds: string[];
    render: string | null;
  };
  selectLayer(id: string | null): void;
  /** Draw the pending "new cel" box on the stage (plate pixels), and fill its prompt. */
  setNewRegion(region: number[] | null): void;
  setNewPrompt(prompt: string): void;
  /** The ▶ add layer & generate cel button. */
  submitLayer(extra?: Record<string, unknown>): Promise<{ job: string; layer?: string }>;
  /** ONE POST for the whole patch — the auto-render debounce then renders once. */
  patchLayer(id: string, patch: Record<string, unknown>): Promise<void>;
  removeLayer(id: string): Promise<void>;
  /** 🎲 reroll, or 🎛 directed reroll when `opts` carries prompt/seed/backend/model. */
  rerollLayer(id: string, opts?: Record<string, unknown>): Promise<{ job: string }>;
  /** Switch the background to a stored or new take (still or clip). */
  setBackground(rel: string): Promise<void>;
  setBgField(field: BgField, value: unknown): void;
  submitBackground(): Promise<{ job: string }>;
  setDuration(seconds: number): Promise<void>;
  renderComp(): Promise<{ job: string }>;
  /** ⬆ use in timeline — points the shot's source at a composite. */
  promote(path?: string): Promise<{ path: string }>;
  refresh(): Promise<void>;
}

// ---------------------------------------------------------------- projects (the front door)

export interface ProjectLite { id: string; label?: string; shots?: number; paused?: boolean }

/**
 * The Projects page. `create_project` drives this the way a human does: it types the
 * slug into the "New empty project" field and presses create, then navigates to the
 * new film. Not a "page" in `current()`'s sense (no project is open yet), so ask for
 * it by kind: `ctx.page.waitFor("projects")`.
 */
export interface ProjectsPageHandles {
  kind: "projects";
  getState(): { projects: ProjectLite[]; newId: string };
  /** Same handler the create button calls: fills the field, posts, refreshes. */
  createProject(id: string, body?: Record<string, unknown>): Promise<ProjectLite>;
  refresh(): Promise<void>;
}

// ------------------------------------------- the screening room (workstream M)

/**
 * One row of a cut's EDL: which shot is on screen, from when, for how long.
 * `start` and `seconds` are film seconds. This is what the chapter strip draws
 * and what "play the film from B03-S2" seeks against.
 */
export interface Chapter {
  sid: string;
  start: number;
  seconds: number;
  source?: string | null;
}

/**
 * The screening room overlay (`ScreeningRoom`), registered only while it is
 * open. It is an overlay, not a page, so `current()` still reports the Film or
 * Shot Editor underneath. Ask for it by kind: `ctx.page.waitFor("screen")`.
 */
export interface ScreenPageHandles {
  kind: "screen";
  pid: string;
  rel: string;
  currentTime(): number;
  duration(): number;
  seek(t: number): void;
  /** Resolves false when the browser refused autoplay (the room shows a big ▶). */
  play(): Promise<boolean>;
  pause(): void;
  close(): void;
  chapters(): Chapter[];
}

// --------------------------------------------------- the timeline transport

export interface TimelineClipLite {
  sid: string; start: number; seconds: number; kind: string;
}

/**
 * The Timeline page's transport. Seconds in, seconds out: the page converts
 * to frames itself, so a caller never has to know the fps.
 */
export interface TimelinePageHandles {
  kind: "timeline";
  pid: string;
  currentTime(): number;
  duration(): number;
  seek(t: number): void;
  play(): Promise<boolean>;
  pause(): void;
  toggle(): void;
  selectClip(sid: string): void;
  clips(): TimelineClipLite[];
  setScope(seconds: number | null): void;
}

export type AnyPageHandles =
  ShotPageHandles | FilmPageHandles | CompPageHandles | ProjectsPageHandles
  | ScreenPageHandles | TimelinePageHandles;

export interface PageHandles {
  current(): AnyPageHandles | null;
  waitFor(kind: "shot", match: { sid: string }, timeoutMs?: number): Promise<ShotPageHandles>;
  waitFor(kind: "film", match?: Record<string, never>, timeoutMs?: number): Promise<FilmPageHandles>;
  waitFor(kind: "comp", match?: { cid?: string; sid?: string }, timeoutMs?: number): Promise<CompPageHandles>;
  waitFor(kind: "projects", match?: Record<string, never>, timeoutMs?: number): Promise<ProjectsPageHandles>;
  waitFor(kind: "screen", match?: { rel?: string }, timeoutMs?: number): Promise<ScreenPageHandles>;
  waitFor(kind: "timeline", match?: Record<string, never>, timeoutMs?: number): Promise<TimelinePageHandles>;
}

// ---------------------------------------------------------------- resolver

export interface ResolvedShot {
  sid: string; ordinal: number; beat: string; act: number | null; type: string;
  seconds: number | null; summary: string; characters: string[];
  has_keeper: boolean; has_motion: boolean; plays: string | null;
}
export type Confidence = "exact" | "high" | "ambiguous" | "none";
export interface Candidate extends ResolvedShot { score: number; why: string }
export interface Resolution { best: ResolvedShot | null; candidates: Candidate[]; confidence: Confidence }

export interface ShotResolver {
  index(pid: string, opts?: { force?: boolean }): Promise<ResolvedShot[]>;
  resolve(pid: string, query: string): Promise<Resolution>;
}

// ---------------------------------------------------------------- trail (visible execution)

export interface TrailStep {
  id: string; t: number; tool: string; title: string;
  anchor?: Anchor; detail?: string; job?: string;
}
export interface Trail {
  /** Records a step, pulses the anchor (if any), and paces by ctx.speed. */
  step(s: Omit<TrailStep, "id" | "t">): Promise<void>;
  steps(): TrailStep[];
  clear(): void;
}

// ---------------------------------------------------------------- action definition

export type Speed = "watch" | "fast";

export interface ActionContext {
  signal: AbortSignal;
  project: string | null;
  nav(to: string): Promise<void>;                 // router navigate + await route mount
  page: PageHandles;
  api: <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T>;
  resolve: ShotResolver;
  trail: Trail;
  speed: Speed;
}

export interface ActionDef<A = Record<string, unknown>> {
  name: string;                                   // TOOL_NAME_RE, ≤ BUDGETS.name
  title: string;                                  // palette label
  description: string;                            // ≤ BUDGETS.description, verb-first
  inputSchema: JSONSchema;                        // param descriptions ≤ BUDGETS.param
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  where: Where | ((args: Partial<A>) => Where);
  keywords?: string[];
  howTo?: string;                                 // how a human does this by hand (1–2 sentences)
  /** The screen this belongs to ("Shot Editor", "Settings") — list_features groups by it. */
  group?: string;
  surfaces?: { agent?: boolean; palette?: boolean };  // default both true
  outputLimit?: number;                           // override BUDGETS.output for this tool (rare)
  summarize?: (args: A) => string;
  execute(args: A, ctx: ActionContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------- tool names (v1)

export const TOOL_NAMES = [
  "find_shots", "describe_shot", "get_context", "list_features", "show_me", "open_shot",
  "generate_takes", "freeze_tail", "trim_clip", "select_take", "set_keeper",
  "set_timeline_source", "set_shot_timing", "synthesize_vo", "direct_shot", "apply_plan",
  "cut_film", "get_jobs", "wait_for_jobs",
  // workstream H — music & SFX (appended; never renumber the rows above)
  "generate_music", "generate_sfx", "place_cue", "list_cues",
  // workstream I — the cel workbench (comps), then lanes / export / render
  "add_cel_layer", "reroll_layer", "restyle_background", "set_background",
  "set_layer", "remove_layer", "render_comp", "list_layers",
  "list_backends", "set_lane_default", "export_timeline", "render_timeline",
  // workstream K — starting a film from nothing
  "create_project", "write_script", "set_project_cast", "list_projects",
  // workstream M: the screening room (watching, not making)
  "play_cut", "play_take", "stop_playback", "preview_timeline",
  // workstream N: motion budget planning
  "plan_motion", "apply_motion_plan",
  // workstream P: the project style register
  "set_style",
  // workstream S: per-shot reference images the model actually receives
  "attach_reference", "remove_reference", "list_references",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------- anchors (data-action values)

/** Use `anchor(ANCHORS.shotTake, { path })` for parameterised anchors. */
export const ANCHORS = {
  // app shell
  navProjects: "app.nav.projects", navFilm: "app.nav.film", navTimeline: "app.nav.timeline",
  navChat: "app.nav.chat", navJobs: "app.nav.jobs", navSettings: "app.nav.settings",
  pause: "app.pause",
  // film editor
  filmCut: "film.cut", filmScope: "film.scope", filmRes: "film.res",
  filmStyle: "film.style",                     // the style register chip
  filmShot: "film.shot",                       // + data-sid
  quickSeconds: "film.quick.seconds", quickVoOffset: "film.quick.vo_offset",
  quickMute: "film.quick.mute", quickOpen: "film.quick.open",
  quickSource: "film.quick.source",            // + data-path
  // shot editor
  shotTab: "shot.tab",                         // "shot.tab.<tab>"
  directInput: "shot.direct.input", directSubmit: "shot.direct.submit", planApply: "shot.plan.apply",
  takesFilter: "shot.takes.filter",            // + data-kind
  shotTake: "shot.take",                       // + data-path
  takeKeeper: "shot.take.keeper", takeSource: "shot.take.source",
  takeFreeze: "shot.take.freeze", takeCompose: "shot.take.compose", takeScreen: "shot.take.screen",
  genSub: "shot.gen.sub",                      // "shot.gen.sub.<sub>"
  gen: "shot.gen",                             // "shot.gen.<sub>.<field|submit>"
  genModel: "shot.gen.model",
  /** The References strip above the Generate console, and one item in it. */
  genRefs: "shot.gen.refs", genRef: "shot.gen.ref",   // + data-path
  genRefRemove: "shot.gen.ref.remove",         // + data-path
  genRefPick: "shot.gen.refs.pick", genRefRole: "shot.gen.refs.role",
  genRefAdd: "shot.gen.refs.add",
  motionLive: "shot.motion.live", motionFreeze: "shot.motion.freeze", motionTrim: "shot.motion.trim",
  audioText: "shot.audio.text", audioVoice: "shot.audio.voice",
  audioTreatment: "shot.audio.treatment",
  audioSubmit: "shot.audio.submit", audioVoOffset: "shot.audio.vo_offset", audioMute: "shot.audio.mute",
  // music & SFX (the Audio tab's second section)
  musicPrompt: "shot.audio.music.prompt", musicSeconds: "shot.audio.music.seconds",
  musicInstrumental: "shot.audio.music.instrumental", musicSubmit: "shot.audio.music.submit",
  sfxPrompt: "shot.audio.sfx.prompt", sfxSeconds: "shot.audio.sfx.seconds",
  sfxSubmit: "shot.audio.sfx.submit",
  shotCues: "shot.audio.cues", shotCueRemove: "shot.audio.cues.remove",
  // monitor audio (workstream L) — the preview mix under the Shot Editor monitor
  monitorAudio: "shot.monitor.audio", monitorPlayStill: "shot.monitor.play",
  monitorTracks: "shot.monitor.tracks", monitorProgress: "shot.monitor.progress",
  // film cue strip (under the Cuts gallery)
  filmCues: "film.cues", filmCueRemove: "film.cues.remove",
  // shot editor — compose tab shell (the cel workbench lives inside it)
  compPick: "comp.pick",                       // + data-cid
  compCreate: "comp.create", compSeparate: "comp.separate",
  scriptPanel: "shot.script.panel",
  // the cel workbench (CompEditor)
  compStage: "comp.stage",
  compNewPrompt: "comp.new.prompt", compNewSubmit: "comp.new.submit",
  compNewCancel: "comp.new.cancel",
  compLayer: "comp.layer",                     // + data-id (the layer card)
  compLayerSelect: "comp.layer.select", compLayerReroll: "comp.layer.reroll",
  compLayerDirected: "comp.layer.directed", compLayerRemove: "comp.layer.remove",
  compLayerMatte: "comp.layer.matte", compLayerOpacity: "comp.layer.opacity",
  compLayerZ: "comp.layer.z", compLayerVariant: "comp.layer.variant",
  compLayerSpotlight: "comp.layer.spotlight",
  compRerollPrompt: "comp.layer.reroll.prompt", compRerollSeed: "comp.layer.reroll.seed",
  compRerollSubmit: "comp.layer.reroll.submit",
  compBgPrompt: "comp.bg.prompt", compBgMode: "comp.bg.mode",
  compBgStrength: "comp.bg.strength", compBgSubmit: "comp.bg.submit",
  compBgPlate: "comp.bg.plate",                // + data-path
  compDuration: "comp.duration", compRender: "comp.render", compPromote: "comp.promote",
  // separate-a-figure canvas
  sepCanvas: "separate.canvas", sepInclude: "separate.include",
  sepExclude: "separate.exclude", sepUndo: "separate.undo",
  sepClear: "separate.clear", sepSubmit: "separate.submit",
  // timeline
  timelineRender: "timeline.render", timelineScope: "timeline.scope",
  timelineZoom: "timeline.zoom", timelinePlay: "timeline.play",
  timelineStepBack: "timeline.step.back", timelineStepFwd: "timeline.step.fwd",
  timelineScrub: "timeline.scrub", timelineRuler: "timeline.ruler",
  timelineMute: "timeline.mute",
  timelineClip: "timeline.clip",                // + data-id
  timelineOtio: "timeline.export.otio", timelineEdl: "timeline.export.edl",
  // settings
  settingsBackend: "settings.backend",         // + data-id, then ".enable|.health|.save|.delete"
  settingsBackendEnable: "settings.backend.enable",
  settingsBackendHealth: "settings.backend.health",
  settingsBackendEdit: "settings.backend.edit",
  settingsBackendSave: "settings.backend.save",
  settingsBackendDelete: "settings.backend.delete",
  settingsBackendLabel: "settings.backend.label",
  settingsBackendUrl: "settings.backend.base_url",
  settingsBackendKey: "settings.backend.api_key",
  settingsBackendOptions: "settings.backend.options",
  settingsAdd: "settings.add", settingsAddId: "settings.add.id",
  settingsAddType: "settings.add.type", settingsAddUrl: "settings.add.base_url",
  settingsAddKey: "settings.add.api_key", settingsAddSubmit: "settings.add.submit",
  settingsAddCancel: "settings.add.cancel",
  settingsLane: "settings.lane",               // + data-lane
  settingsLaneModel: "settings.lane.model", settingsLaneSave: "settings.lane.save",
  settingsToken: "settings.token", settingsTokenSave: "settings.token.save",
  // jobs
  jobsRow: "jobs.row",                          // + data-id
  jobsCancel: "jobs.cancel", jobsLog: "jobs.log",
  // projects
  projectsCard: "projects.card",                // + data-pid
  projectsNewId: "projects.create.id", projectsCreate: "projects.create.submit",
  projectsImportSrc: "projects.import.src", projectsImportId: "projects.import.id",
  projectsImport: "projects.import",
  // director chat
  chatProvider: "chat.provider", chatInput: "chat.input", chatSend: "chat.send",
  // the screening room (workstream M): the full-screen overlay
  screenRoot: "screen.root", screenVideo: "screen.video",
  screenChapter: "screen.chapter",             // + data-sid
  screenClose: "screen.close", screenPlay: "screen.play",
  screenScrub: "screen.scrub", screenOpenShot: "screen.open_shot",
  // app shell odds and ends
  filmView: "film.view",
  /**
   * The Cuts-gallery poster. Narrow it with the cut's rel path, as in
   * `film.cut.play[data-path="assembly/animatic-full-720p.mp4"]`. The bare
   * `film.cut` is the "🎞 cut the film" button and must stay unique.
   */
  filmCutPlay: "film.cut.play",                // + data-path
  paletteInput: "app.palette.input", agentChip: "app.agent.chip",
} as const;

export const shotTabAnchor = (tab: ShotTab) => `${ANCHORS.shotTab}.${tab}`;
export const genSubAnchor = (sub: GenSub) => `${ANCHORS.genSub}.${sub}`;
export const genFieldAnchor = (sub: GenSub, field: GenField | "submit") => `${ANCHORS.gen}.${sub}.${field}`;

/** CSS selector for an anchor, optionally narrowed by a data attribute. */
export function anchorSelector(anchor: Anchor, data?: Record<string, string>): string {
  const extra = data ? Object.entries(data).map(([k, v]) => `[data-${k}="${CSS.escape(v)}"]`).join("") : "";
  return `[data-action="${anchor}"]${extra}`;
}

// ---------------------------------------------------------------- helpers shared by all

/**
 * Keep any result under BUDGETS.output chars: shrink arrays first, then long prose strings.
 * Never truncates whitespace-free strings (paths, ids, urls) — those are identifiers the
 * agent passes back. Marks the top-level object with `truncated: true` when anything shrank.
 */
export function clip<T>(value: T, limit: number = BUDGETS.output): T {
  const size = (v: unknown) => JSON.stringify(v)?.length ?? 0;
  if (size(value) <= limit) return value;
  const shrink = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, Math.max(1, Math.floor(v.length / 2))).map(shrink);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shrink(x)]));
    if (typeof v === "string" && v.length > 200 && /\s/.test(v)) return v.slice(0, 200) + "…";
    return v;
  };
  let out: unknown = value;
  for (let i = 0; i < 6 && size(out) > limit; i++) out = shrink(out);
  if (size(out) > limit) out = { ok: (value as { ok?: boolean })?.ok ?? true, summary: "result truncated", truncated: true };
  else if (out && typeof out === "object" && !Array.isArray(out)) out = { ...(out as Record<string, unknown>), truncated: true };
  return out as T;
}

export const err = (error: string, extra: Omit<ToolErr, "ok" | "error"> = {}): ToolErr => ({ ok: false, error, ...extra });
export const ok = (summary: string, extra: Record<string, unknown> = {}): ToolOk => ({ ok: true, summary, ...extra });
