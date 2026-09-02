/**
 * The test double every tool unit test drives: a fake ActionContext with a
 * recording router, recording page handles, a fixture-backed API and a fake
 * resolver pinned to the §5 journey fixtures.
 *
 * Not shipped to users, but it lives in src/ so `tsc -p .` type-checks it
 * against the frozen contract — which is the whole point.
 */
import { APP_BASE } from "../../routes";
import type {
  ActionContext, AnyPageHandles, BgField, Candidate, CompLayerLite,
  CompPageHandles, Confidence, CueField, CueKind,
  CuePlacement, CueRecord, FilmPageHandles,
  FilmShotLite, GenField, GenSub, KindFilter, ProjectLite, ProjectsPageHandles,
  ResolvedShot, Resolution, ShotReference,
  ShotPageHandles, ShotTab, TakeLite, TimelineClipLite, TimelinePageHandles,
  TrailStep, VoField,
} from "../contract";
import type { AgentDeps, BackendChoice, SettledJob } from "./deps";
import { installDeps, resetDeps } from "./deps";

// ---------------------------------------------------------------- fixtures

export const FIXTURE_SHOTS: Record<string, ResolvedShot> = {
  "B10-S2": {
    sid: "B10-S2", ordinal: 34, beat: "B10", act: 3, type: "HERO",
    seconds: 4, summary: "David Ross in the dugout, close on the eyes",
    characters: ["david ross", "catcher"],
    has_keeper: true, has_motion: true, plays: "renders/B10-S2/motion/a.mp4",
  },
  "B11-S4": {
    sid: "B11-S4", ordinal: 37, beat: "B11", act: 3, type: "STILL",
    seconds: 3, summary: "The cemetery at dusk, wide and empty",
    characters: [],
    has_keeper: true, has_motion: false, plays: "renders/B11-S4/stills/k.png",
  },
};

/** Shot detail as `GET /api/projects/{pid}/shots/{sid}` returns it. */
export const FIXTURE_DETAIL: Record<string, Record<string, unknown>> = {
  "B10-S2": {
    sid: "B10-S2", beat: "B10", act: 3, type: "HERO", register: "hero",
    seconds: 4,
    image_prompt: "Subject: David Ross in the dugout, close on the eyes, anime cel",
    negative: "text, watermark",
    motion_prompt: "only the eyes blink; the jaw sets",
    narration: null,
    dialogue: [{ character: "ROSS", line: "One more inning." }],
    keeper: "renders/B10-S2/stills/keeper.png",
    active_source: "renders/B10-S2/motion/a.mp4",
    override: {},
    stills: ["renders/B10-S2/stills/keeper.png", "renders/B10-S2/stills/s2.png"],
    i2i: ["renders/B10-S2/i2i/warm.png"],
    motion: ["renders/B10-S2/motion/a.mp4"],
    fx: [], crops: [], vo: [],
    comps: [],
  },
  "B11-S4": {
    sid: "B11-S4", beat: "B11", act: 3, type: "STILL", register: "still",
    seconds: 3,
    image_prompt: "Subject: the cemetery at dusk, wide, anime cel",
    negative: "",
    motion_prompt: null,
    narration: "…and that's the ballgame from here.",
    dialogue: [],
    keeper: "renders/B11-S4/stills/k.png",
    active_source: "renders/B11-S4/stills/k.png",
    override: {},
    stills: ["renders/B11-S4/stills/k.png"],
    i2i: [], motion: [], fx: [], crops: [], vo: [],
    comps: [],
  },
};

/**
 * References attached during a test, by sid. The fake shot detail serves them
 * back, so attach → list → generate round-trips the way the server does.
 * Cleared by every `makeFakeContext()`.
 */
export const FIXTURE_REFS: Record<string, ShotReference[]> = {};
export const resetReferences = (): void => {
  for (const k of Object.keys(FIXTURE_REFS)) delete FIXTURE_REFS[k];
};

/**
 * The keeper the fixtures start with. `setKeeper` MOVES the fixture's keeper,
 * the way the server does — a fake that only logged the call is what let a
 * tool claim "the keeper is now X" while every motion job kept starting from
 * the old plate.
 */
const FIXTURE_KEEPERS: Record<string, unknown> = Object.fromEntries(
  Object.entries(FIXTURE_DETAIL).map(([sid, d]) => [sid, d.keeper]));
export const resetKeepers = (): void => {
  for (const [sid, keeper] of Object.entries(FIXTURE_KEEPERS)) {
    FIXTURE_DETAIL[sid].keeper = keeper;
  }
};

const takeRows = (sid: string) => {
  const d = FIXTURE_DETAIL[sid] || {};
  const rows: { path: string; kind: string; created_at: number }[] = [];
  let t = 2000;
  const add = (paths: unknown, kind: string) =>
    (Array.isArray(paths) ? paths : []).forEach((p) =>
      rows.push({ path: String(p), kind, created_at: t-- }));
  add(d.motion, "motion"); add(d.fx, "fx"); add(d.i2i, "i2i");
  add(d.stills, "still");
  return rows;
};

// ---------------------------------------------------------------- recording

export interface ApiCall { path: string; body?: unknown; method?: string }

export interface FakeRecord {
  nav: string[];
  steps: Omit<TrailStep, "id" | "t">[];
  page: string[];
  api: ApiCall[];
  /** Convenience: only the anchors that were pulsed, in order. */
  anchors: () => (string | undefined)[];
  /** Convenience: page-handle calls as "name(arg)" strings. */
  calls: (prefix?: string) => string[];
}

// ---------------------------------------------------------------- cue store

/**
 * The cue sheet both fake pages share, standing in for
 * `POST /api/projects/{pid}/cues`. `at` is resolved the way the server does:
 * a shot anchor becomes that shot's start (4s per fixture shot, in order).
 */
export class FakeCueStore {
  rows: CueRecord[] = [];
  private seq = 0;

  starts(): Record<string, number> {
    let t = 0;
    const out: Record<string, number> = {};
    for (const s of Object.values(FIXTURE_SHOTS).sort((a, b) => a.ordinal - b.ordinal)) {
      out[s.sid] = t;
      t += s.seconds ?? 4;
    }
    return out;
  }

  add(cue: CuePlacement): CueRecord {
    const starts = this.starts();
    const base = cue.shot ? starts[cue.shot] : (cue.start ?? 0);
    const row: CueRecord = {
      ...cue,
      id: `cue_fake${++this.seq}`,
      at: base === undefined ? null : base + (cue.offset ?? 0),
      exists: true,
    };
    this.rows.push(row);
    return row;
  }

  remove(id: string): void {
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  sheet(): { music: CueRecord[]; sfx: CueRecord[] } {
    return {
      music: this.rows.filter((r) => r.kind === "music"),
      sfx: this.rows.filter((r) => r.kind === "sfx"),
    };
  }
}

// ---------------------------------------------------------------- page fakes

export class FakeShotPage implements ShotPageHandles {
  kind = "shot" as const;
  tab: ShotTab = "compose";
  sub: GenSub = "still";
  kindFilter: KindFilter = "all";
  selected: string | null = null;
  gen: Record<string, unknown> = {};
  vo: Record<string, unknown> = {};
  live = 1.0;
  jobSeq = 0;
  /** Set to a message to make the next submit throw. */
  failSubmit: string | null = null;
  directResult: { plan?: unknown; error?: string } =
    { plan: { ops: [{ op: "freeze_tail", clip: "renders/B10-S2/motion/a.mp4", live: 1 }], note: "hold the pose" } };
  applyResult: { results: unknown[]; note?: string } =
    { results: [{ op: "freeze_tail", job: "job-apply-1" }], note: "applied" };

  constructor(public pid: string, public sid: string, private rec: string[],
              private cues: FakeCueStore = new FakeCueStore()) {}

  private log(s: string) { this.rec.push(s); }

  getState() {
    const d = FIXTURE_DETAIL[this.sid] || {};
    const takes: TakeLite[] = takeRows(this.sid)
      .map((r) => ({ path: r.path, kind: r.kind, created: String(r.created_at) }));
    return {
      tab: this.tab, sub: this.sub, kindFilter: this.kindFilter,
      selected: this.selected ?? (d.active_source as string | undefined) ?? null,
      activeSource: (d.active_source as string | null) ?? null,
      keeper: (d.keeper as string | null) ?? null,
      takes,
    };
  }
  setTab(tab: ShotTab) { this.tab = tab; this.log(`setTab(${tab})`); }
  setSub(sub: GenSub) { this.sub = sub; this.log(`setSub(${sub})`); }
  setKindFilter(k: KindFilter) { this.kindFilter = k; this.log(`setKindFilter(${k})`); }
  selectTake(path: string | null) { this.selected = path; this.log(`selectTake(${path})`); }
  setGenField(sub: GenSub, field: GenField, value: unknown) {
    this.gen[field] = value;
    this.log(`setGenField(${sub},${field},${JSON.stringify(value)})`);
  }
  async submitGenerate(sub: GenSub) {
    this.log(`submitGenerate(${sub})`);
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-${sub}-${++this.jobSeq}`, pool: "cpu" };
  }
  setLive(seconds: number) { this.live = seconds; this.log(`setLive(${seconds})`); }
  async submitFreeze() {
    this.log("submitFreeze()");
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-freeze-${++this.jobSeq}` };
  }
  async submitTrim(endSeconds: number) {
    this.log(`submitTrim(${endSeconds})`);
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-trim-${++this.jobSeq}` };
  }
  setVoField(field: VoField, value: unknown) {
    this.vo[field] = value;
    this.log(`setVoField(${field},${JSON.stringify(value)})`);
  }
  async submitVo() {
    this.log("submitVo()");
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-vo-${++this.jobSeq}` };
  }
  cue: Record<string, unknown> = {};
  setCueField(kind: CueKind, field: CueField, value: unknown) {
    this.cue[`${kind}.${field}`] = value;
    this.log(`setCueField(${kind},${field},${JSON.stringify(value)})`);
  }
  async submitMusic() {
    this.log("submitMusic()");
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-music-${++this.jobSeq}` };
  }
  async submitSfx() {
    this.log("submitSfx()");
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-sfx-${++this.jobSeq}` };
  }
  async addCue(cue: CuePlacement) {
    this.log(`addCue(${cue.kind},${cue.shot ?? cue.start ?? 0})`);
    if (this.failCue) throw new Error(this.failCue);
    return this.cues.add(cue);
  }
  async removeCue(id: string) {
    this.log(`removeCue(${id})`);
    this.cues.remove(id);
  }
  /** Set to a message to make the next addCue throw. */
  failCue: string | null = null;

  /** The References strip, standing in for POST …/shots/{sid}/refs. */
  get refs(): ShotReference[] { return FIXTURE_REFS[this.sid] ||= []; }
  set refs(rows: ShotReference[]) { FIXTURE_REFS[this.sid] = rows; }
  /** Set to a message to make the next addReference throw. */
  failReference: string | null = null;
  references() { return this.refs; }
  async addReference(ref: ShotReference) {
    this.log(`addReference(${ref.path},${ref.role})`);
    if (this.failReference) throw new Error(this.failReference);
    if (this.refs.length >= 4 && !this.refs.some((r) => r.path === ref.path)) {
      throw new Error("a shot carries at most 4 references — remove one first");
    }
    this.refs = [...this.refs.filter((r) => r.path !== ref.path), ref];
    return this.refs;
  }
  async removeReference(which: string) {
    this.log(`removeReference(${which})`);
    const w = which.trim().toLowerCase();
    this.refs = w === "all" ? []
      : this.refs.filter((r) => r.role !== w && r.path !== which
                         && r.path.split("/").pop() !== which);
    return this.refs;
  }

  async setKeeper(path: string, note?: string) {
    this.log(`setKeeper(${path}${note ? `,${note}` : ""})`);
    const d = FIXTURE_DETAIL[this.sid];
    if (d) d.keeper = path;                       // the server stores the pick
  }
  async setSource(path: string | null) { this.log(`setSource(${path})`); }
  async setOverride(patch: Record<string, unknown>) {
    this.log(`setOverride(${JSON.stringify(patch)})`);
  }
  async direct(instruction: string) {
    this.log(`direct(${instruction})`);
    return this.directResult;
  }
  async applyPlan(plan: unknown) {
    this.log(`applyPlan(${JSON.stringify(plan).slice(0, 60)})`);
    return this.applyResult;
  }
  async refresh() { this.log("refresh()"); }
}

export class FakeFilmPage implements FilmPageHandles {
  kind = "film" as const;
  selected: string | null = null;
  scope = "full";
  res = "720";
  jobSeq = 0;
  failCut: string | null = null;

  constructor(public pid: string, private rec: string[],
              private cues: FakeCueStore = new FakeCueStore()) {}
  private log(s: string) { this.rec.push(s); }
  /** Set to a message to make the next addCue throw. */
  failCue: string | null = null;

  getState() {
    const shots: FilmShotLite[] = Object.values(FIXTURE_SHOTS).map((s) => ({
      sid: s.sid, ordinal: s.ordinal, beat: s.beat, act: s.act ?? undefined,
      type: s.type, seconds: s.seconds ?? undefined,
      keeper: s.has_keeper ? "renders/keeper.png" : null,
      active_source: s.plays,
    }));
    return { selected: this.selected, scope: this.scope, res: this.res, shots,
             cues: this.cues.rows };
  }
  async addCue(cue: CuePlacement) {
    this.log(`addCue(${cue.kind},${cue.shot ?? cue.start ?? 0})`);
    if (this.failCue) throw new Error(this.failCue);
    return this.cues.add(cue);
  }
  async removeCue(id: string) {
    this.log(`removeCue(${id})`);
    this.cues.remove(id);
  }
  selectShot(sid: string | null) { this.selected = sid; this.log(`selectShot(${sid})`); }
  setScope(scope: string) { this.scope = scope; this.log(`setScope(${scope})`); }
  setRes(res: "720" | "1080") { this.res = res; this.log(`setRes(${res})`); }
  async cutFilm() {
    this.log("cutFilm()");
    if (this.failCut) throw new Error(this.failCut);
    return { job: `job-cut-${++this.jobSeq}` };
  }
  async setOverride(sid: string, patch: Record<string, unknown>) {
    this.log(`setOverride(${sid},${JSON.stringify(patch)})`);
  }
  async refresh() { this.log("refresh()"); }
}

/**
 * The cel workbench. Layers live here so a tool's patch/remove is observable,
 * and every mutation is recorded like a page-handle call.
 */
export class FakeCompPage implements CompPageHandles {
  kind = "comp" as const;
  layers: CompLayerLite[] = [
    { id: "L1", clip: "renders/B10-S2/motion/cel-L1.webm",
      region: [320, 96, 640, 352], prompt: "only the eyes blink",
      z: 1, opacity: 1, matte: "window", variants: 2 },
  ];
  selected: string | null = null;
  duration = 4;
  background = "renders/B10-S2/stills/keeper.png";
  backgrounds = ["renders/B10-S2/stills/keeper.png"];
  render: string | null = "renders/fx/comp-B10-S2-1.mp4";
  newRegion: number[] | null = null;
  newPrompt = "";
  bg: Record<string, unknown> = {};
  jobSeq = 0;
  /** Set to a message to make the next submit throw. */
  failSubmit: string | null = null;

  constructor(public pid: string, public cid: string, public sid: string | null,
              private rec: string[]) {}

  private log(s: string) { this.rec.push(s); }

  getState() {
    return {
      cid: this.cid, shot: this.sid, background: this.background,
      backgroundKind: (/\.(mp4|webm|mov)$/i.test(this.background)
        ? "video" : "still") as "still" | "video",
      duration: this.duration,
      plate: [960, 544] as [number, number],
      layers: this.layers.map((L) => ({ ...L })),
      selected: this.selected,
      backgrounds: [...this.backgrounds],
      render: this.render,
    };
  }
  selectLayer(id: string | null) { this.selected = id; this.log(`selectLayer(${id})`); }
  setNewRegion(region: number[] | null) {
    this.newRegion = region;
    this.log(`setNewRegion(${region ? region.join(",") : "null"})`);
  }
  setNewPrompt(prompt: string) { this.newPrompt = prompt; this.log(`setNewPrompt(${prompt})`); }
  async submitLayer(extra: Record<string, unknown> = {}) {
    this.log(`submitLayer(${JSON.stringify(extra)})`);
    if (this.failSubmit) throw new Error(this.failSubmit);
    const id = `L${this.layers.length + 1}`;
    this.layers.push({ id, clip: null, region: this.newRegion || [0, 0, 32, 32],
                       prompt: this.newPrompt, z: this.layers.length + 1,
                       opacity: 1, matte: "window", variants: 0 });
    this.newRegion = null; this.newPrompt = "";
    return { job: `job-cel-${++this.jobSeq}`, layer: id };
  }
  async patchLayer(id: string, patch: Record<string, unknown>) {
    this.log(`patchLayer(${id},${JSON.stringify(patch)})`);
    this.layers = this.layers.map((L) => (L.id === id ? { ...L, ...patch } : L));
  }
  async removeLayer(id: string) {
    this.log(`removeLayer(${id})`);
    this.layers = this.layers.filter((L) => L.id !== id);
  }
  async rerollLayer(id: string, opts: Record<string, unknown> = {}) {
    this.log(`rerollLayer(${id},${JSON.stringify(opts)})`);
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-reroll-${++this.jobSeq}` };
  }
  async setBackground(rel: string) {
    this.log(`setBackground(${rel})`);
    if (!this.backgrounds.includes(this.background)) this.backgrounds.push(this.background);
    this.background = rel;
  }
  setBgField(field: BgField, value: unknown) {
    this.bg[field] = value;
    this.log(`setBgField(${field},${JSON.stringify(value)})`);
  }
  async submitBackground() {
    this.log("submitBackground()");
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-bg-${++this.jobSeq}` };
  }
  async setDuration(seconds: number) { this.duration = seconds; this.log(`setDuration(${seconds})`); }
  async renderComp() {
    this.log("renderComp()");
    if (this.failSubmit) throw new Error(this.failSubmit);
    return { job: `job-comprender-${++this.jobSeq}` };
  }
  async promote(path?: string) {
    this.log(`promote(${path ?? this.render})`);
    return { path: path || this.render || "" };
  }
  async refresh() { this.log("refresh()"); }
}

/**
 * The Projects page — the front door, and the only page an agent can reach
 * before any film exists. `createProject` records the call and adds a card.
 */
/**
 * The Timeline's transport (workstream M). Frames are the page's business; the
 * handles are seconds, so this double is seconds all the way through.
 */
export class FakeTimelinePage implements TimelinePageHandles {
  readonly kind = "timeline" as const;
  t = 0;
  playing = false;
  scope: number | null = 24;
  selected: string | null = null;
  rows: TimelineClipLite[] = [
    { sid: "B10-S2", start: 0, seconds: 4, kind: "video" },
    { sid: "B11-S4", start: 4, seconds: 3, kind: "image" },
  ];
  /** Make play() refuse, the way a browser refuses autoplay. */
  refusePlay = false;

  constructor(public pid: string, private rec: string[]) {}
  private log(s: string) { this.rec.push(s); }

  currentTime() { return this.t; }
  duration() {
    const last = this.rows[this.rows.length - 1];
    return last ? last.start + last.seconds : 0;
  }
  seek(t: number) { this.t = t; this.log(`timeline.seek(${t})`); }
  async play() {
    this.log("timeline.play()");
    this.playing = !this.refusePlay;
    return this.playing;
  }
  pause() { this.playing = false; this.log("timeline.pause()"); }
  toggle() { this.playing = !this.playing; this.log("timeline.toggle()"); }
  selectClip(sid: string) { this.selected = sid; this.log(`timeline.selectClip(${sid})`); }
  clips() { return this.rows; }
  setScope(seconds: number | null) {
    this.scope = seconds;
    this.log(`timeline.setScope(${seconds})`);
  }
}

export class FakeProjectsPage implements ProjectsPageHandles {
  kind = "projects" as const;
  projects: ProjectLite[] = [
    { id: "next-year", label: "Next Year", shots: 2, paused: false },
  ];
  newId = "";
  /** Set to a message (or an ApiError-shaped object) to make create throw. */
  failCreate: unknown = null;

  constructor(private rec: string[]) {}
  private log(s: string) { this.rec.push(s); }

  getState() { return { projects: this.projects.map((p) => ({ ...p })), newId: this.newId }; }

  async createProject(id: string, body: Record<string, unknown> = {}) {
    this.newId = id;
    this.log(`createProject(${id},${JSON.stringify(body)})`);
    if (this.failCreate) {
      throw typeof this.failCreate === "string"
        ? new Error(this.failCreate) : this.failCreate;
    }
    const made: ProjectLite = { id, label: String(body.label ?? id), shots: 0 };
    this.projects.push(made);
    this.newId = "";
    return made;
  }

  async refresh() { this.log("refresh()"); }
}

// ---------------------------------------------------------------- resolver fake

export interface ResolverFixture {
  /** Exact query → resolution. Falls through to the heuristics below. */
  [query: string]: Resolution;
}

const cand = (s: ResolvedShot, score: number, why: string): Candidate =>
  ({ ...s, score, why });

const res = (best: ResolvedShot | null, candidates: Candidate[], confidence: Confidence): Resolution =>
  ({ best, candidates, confidence });

/**
 * The §3.4 pins: "the David Ross close-up" → B10-S2, "37" → B11-S4, and both
 * together → ambiguous with both candidates.
 */
export function fakeResolve(query: string): Resolution {
  const q = query.trim().toLowerCase();
  const ross = FIXTURE_SHOTS["B10-S2"];
  const cem = FIXTURE_SHOTS["B11-S4"];
  const hasName = /ross|david|catcher/.test(q);
  const hasNumber = /\b(37|#37|shot 37)\b/.test(q);

  if (hasName && hasNumber) {
    return res(null, [
      cand(ross, 80, "David Ross by name"),
      cand(cem, 78, "37th shot in film order"),
    ], "ambiguous");
  }
  if (/^b10[-\s]?s2$/i.test(q)) return res(ross, [cand(ross, 100, "exact sid")], "exact");
  if (/^b11[-\s]?s4$/i.test(q)) return res(cem, [cand(cem, 100, "exact sid")], "exact");
  if (hasName) return res(ross, [cand(ross, 90, "cast alias")], "high");
  if (hasNumber) return res(cem, [cand(cem, 90, "film order")], "high");
  if (/cemetery|dusk|wide/.test(q)) return res(cem, [cand(cem, 70, "prompt words")], "high");
  if (/dugout|close.?up|hero/.test(q)) return res(ross, [cand(ross, 70, "prompt words")], "high");
  return res(null, [], "none");
}

// ---------------------------------------------------------------- api fake

export type ApiFixtures = Record<string, unknown> | ((path: string, body?: unknown) => unknown);

/** Comps as `GET /api/projects/{pid}/comps?shot=` returns them. */
export const FIXTURE_COMPS: Record<string, Record<string, unknown>[]> = {
  "B10-S2": [{
    cid: "B10-S2-1", shot: "B10-S2",
    background: "renders/B10-S2/stills/keeper.png",
    background_kind: "still", width: 960, height: 544, duration: 4,
    background_history: [],
    layers: [{ id: "L1", clip: "renders/B10-S2/motion/cel-L1.webm",
               region: [320, 96, 640, 352], prompt: "only the eyes blink",
               z: 1, opacity: 1, matte: "window",
               variants: [{ clip: "renders/B10-S2/motion/cel-L1.webm" },
                          { clip: "renders/B10-S2/motion/cel-L1b.webm" }] }],
  }],
  "B11-S4": [],
};

function defaultApi(path: string, body?: unknown): unknown {
  const compsMatch = /\/api\/projects\/[^/]+\/comps(\?shot=([^&]+))?$/.exec(path);
  if (compsMatch) {
    if (body !== undefined) {                       // POST = create
      const b = (body || {}) as Record<string, unknown>;
      const made = {
        cid: `${b.shot ?? "comp"}-new`, shot: b.shot ?? null,
        background: b.background, width: b.width ?? 960, height: b.height ?? 544,
        duration: b.duration ?? 4, layers: [], background_history: [],
        background_kind: /\.(mp4|webm|mov)$/i.test(String(b.background))
          ? "video" : "still",
      };
      const sid = String(b.shot ?? "");
      (FIXTURE_COMPS[sid] ||= []).push(made);
      return made;
    }
    const sid = compsMatch[2] ? decodeURIComponent(compsMatch[2]) : "";
    return sid ? (FIXTURE_COMPS[sid] || []) : Object.values(FIXTURE_COMPS).flat();
  }
  if (/\/api\/projects\/[^/]+\/dims\//.test(path)) return { width: 960, height: 544 };
  // The style register (workstream P). GET reads it; POST patches and echoes.
  const styleMatch = /\/api\/projects\/([^/]+)\/style$/.exec(path);
  if (styleMatch) {
    const b = (body || {}) as Record<string, unknown>;
    const name = String(b.preset || (b.prefix ? "custom" : "") || "anime-cel");
    return {
      style: {
        name,
        prefix: String(b.prefix
          || "Cinematic anime film still, 1990s TV anime cel look: clean ink outlines."),
        suffix: "",
        avoid: String(b.avoid || "text, lettering, photorealistic, caricature"),
        refs: (b.refs as string[]) ?? ["anime-01.jpg", "anime-02.jpg", "anime-03.jpg"],
      },
      presets: ["anime-cel", "anime-noir", "anime-pastel"],
      stored: true,
    };
  }
  if (path === "/api/projects") {
    if (body !== undefined) {
      const b = (body || {}) as Record<string, unknown>;
      return { id: b.id, label: b.label ?? b.id, lanes: { still: { backend: "mock" } } };
    }
    return [{ id: "next-year", label: "Next Year", shots: 2, paused: false }];
  }
  const batchMatch = /\/api\/projects\/([^/]+)\/shots\/batch$/.exec(path);
  if (batchMatch) {
    const rows = (((body || {}) as Record<string, unknown>).shots || []) as Record<string, unknown>[];
    let n = 0;
    const sids = rows.map((r) => String(r.sid || `B01-S${++n}`));
    return { count: rows.length, sids,
             total_seconds: rows.reduce((t, r) => t + (Number(r.seconds) || 6), 0) };
  }
  const castMatch = /\/api\/projects\/([^/]+)\/cast$/.exec(path);
  if (castMatch && body !== undefined) {
    const rows = (((body || {}) as Record<string, unknown>).characters || []) as Record<string, unknown>[];
    return { ok: true, cast: rows.map((r) => {
      const text = String(r.character || "");
      const name = text.split("—")[0].trim();
      return { id: r.id || `CHAR-${name.toLowerCase()}`, name,
               aliases: [name.toLowerCase(), ...((r.aliases as string[]) || [])],
               descriptor: text };
    }) };
  }
  if (path === "/api/backends") {
    return [{ id: "mock", type: "mock", label: "Mock", enabled: true,
              lanes: ["still", "i2i", "motion", "vo", "music", "sfx"],
              api_key_set: false, options: {} },
            { id: "fal", type: "fal", label: "fal.ai", enabled: true,
              lanes: ["motion"], api_key_set: true, options: { cost_usd: 0.2 } }];
  }
  if (/\/api\/projects\/[^/]+\/timeline\/otio$/.test(path)) {
    return { OTIO_SCHEMA: "Timeline.1", name: "next-year",
             tracks: { children: [{ children: [{ name: "B10-S2" }, { name: "B11-S4" }] }] } };
  }
  if (/\/api\/projects\/[^/]+\/timeline\/render$/.test(path)) return { job: "job-engine-1" };
  const shotMatch = /\/api\/projects\/[^/]+\/shots\/([^/?]+)$/.exec(path);
  if (shotMatch) {
    const d = FIXTURE_DETAIL[shotMatch[1]];
    if (!d) throw new Error(`404 ${shotMatch[1]}`);
    // The server normalizes `override.refs` into `references` on the way out.
    return { ...d, references: FIXTURE_REFS[shotMatch[1]] || [] };
  }
  const refFetch = /\/api\/projects\/([^/]+)\/refs\/fetch$/.exec(path);
  if (refFetch) {
    const url = String(((body || {}) as Record<string, unknown>).url || "");
    if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) urls can be fetched");
    if (/\.html?$/i.test(url)) throw new Error("that url is text/html, not an image");
    return { ok: true, rel: `refs/${url.split("/").pop() || "reference.png"}` };
  }
  // The Cuts gallery, newest first (workstream M).
  if (/\/api\/projects\/[^/]+\/takes\?kind=animatic/.test(path)) {
    return [
      { id: 91, kind: "animatic", path: "assembly/animatic-full-720p-2.mp4",
        created_at: 3000, meta: { total: 7, shots: 2 } },
      { id: 90, kind: "animatic", path: "assembly/animatic-act3-720p.mp4",
        created_at: 2000, meta: { total: 7, shots: 2 } },
    ];
  }
  const edlMatch = /\/api\/projects\/[^/]+\/cuts\/(.+)\/edl$/.exec(path);
  if (edlMatch) {
    return {
      cut: decodeURIComponent(edlMatch[1]), scope: "full", total: 7, shots: 2,
      edl: [
        { sid: "B10-S2", start: 0, seconds: 4, source: "renders/B10-S2/motion/a.mp4" },
        { sid: "B11-S4", start: 4, seconds: 3, source: "renders/B11-S4/stills/k.png" },
      ],
    };
  }
  if (/\/api\/projects\/[^/]+\/film$/.test(path)) {
    return Object.values(FIXTURE_SHOTS)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((s) => ({ sid: s.sid, act: s.act, beat: s.beat, seconds: s.seconds }));
  }
  const takesMatch = /\/api\/projects\/[^/]+\/takes\?shot=([^&]+)/.exec(path);
  if (takesMatch) return takeRows(decodeURIComponent(takesMatch[1]));
  if (path.startsWith("/api/jobs?")) return [];
  if (/^\/api\/jobs\/[^/]+\/log/.test(path)) return { status: "done", lines: [] };
  if (/^\/api\/jobs\/[^/]+$/.test(path)) {
    return { id: path.split("/").pop(), status: "done", type: "gen.still", result: {} };
  }
  if (path === "/api/image-models") {
    // The still lane's registry, as the server serves it (workstream U).
    return {
      default: "flash", text_model: "pro",
      registers: ["legible_text", "typography", "complex_composition",
                  "cheap_default"],
      models: [
        { id: "google/gemini-2.5-flash-image", key: "flash", rank: 1,
          label: "Gemini 2.5 Flash Image", note: "the cheap default",
          cost_per_still_usd: 0.0387, fallback: "pro",
          failure_modes: "drops a letter when the frame carries several strings",
          registers: ["cheap_default"], enabled: true },
        { id: "google/gemini-3-pro-image", key: "pro", rank: 2,
          label: "Gemini 3 Pro Image", note: "readable text",
          cost_per_still_usd: 0.1387, fallback: "flash3",
          failure_modes: "bakes letterbox bars into the frame",
          registers: ["legible_text", "typography", "complex_composition"],
          enabled: true },
      ],
    };
  }
  if (path === "/api/lanes") {
    return {
      still: [{ id: "mock", type: "mock", enabled: true }],
      i2i: [{ id: "mock", type: "mock", enabled: true }],
      motion: [{ id: "mock", type: "mock", enabled: true }],
      vo: [{ id: "mock", type: "mock", enabled: true }],
      sfx: [{ id: "mock", type: "mock", enabled: true }],
      music: [{ id: "mock", type: "mock", enabled: true }],
    };
  }
  if (/\/api\/projects\/[^/]+\/lanes$/.test(path)) {
    return { still: { backend: "mock", model: null }, motion: { backend: "mock", model: null } };
  }
  return {};
}

// ---------------------------------------------------------------- the context

export interface FakeOptions {
  project?: string | null;
  speed?: "watch" | "fast";
  /** Page the router "lands on"; defaults to matching the nav target. */
  page?: AnyPageHandles | null;
  api?: ApiFixtures;
  resolve?: (query: string) => Resolution;
  /** Make waitFor reject, to exercise the page_did_not_mount envelope. */
  failWaitFor?: boolean;
  /** Share a cue store across contexts, or pre-seed one. */
  cues?: FakeCueStore;
  settle?: SettledJob[] | ((ids: string[]) => SettledJob[]);
  backend?: BackendChoice;
}

export interface FakeContext {
  ctx: ActionContext;
  rec: FakeRecord;
  shotPage: FakeShotPage;
  filmPage: FakeFilmPage;
  compPage: FakeCompPage;
  projectsPage: FakeProjectsPage;
  timelinePage: FakeTimelinePage;
  cues: FakeCueStore;
  /** Restore the real deps after a test that installed fakes. */
  restore(): void;
}

export function makeFakeContext(opts: FakeOptions = {}): FakeContext {
  const project = opts.project === undefined ? "next-year" : opts.project;
  const pageCalls: string[] = [];
  const rec: FakeRecord = {
    nav: [], steps: [], page: pageCalls, api: [],
    anchors: () => rec.steps.map((s) => s.anchor),
    calls: (prefix) => (prefix ? pageCalls.filter((c) => c.startsWith(prefix)) : pageCalls),
  };

  resetReferences();
  resetKeepers();
  const cues = opts.cues ?? new FakeCueStore();
  const shotPage = new FakeShotPage(project || "next-year", "B10-S2", pageCalls, cues);
  const filmPage = new FakeFilmPage(project || "next-year", pageCalls, cues);
  const compPage = new FakeCompPage(project || "next-year", "B10-S2-1", "B10-S2", pageCalls);
  const projectsPage = new FakeProjectsPage(pageCalls);
  const timelinePage = new FakeTimelinePage(project || "next-year", pageCalls);
  let current: AnyPageHandles | null = opts.page ?? null;

  const api = <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
    rec.api.push({ path, body, method });
    if (/\/api\/projects\/[^/]+\/cues(\?|$)/.test(path)) {
      return Promise.resolve(cues.sheet() as T);
    }
    try {
      if (typeof opts.api === "function") return Promise.resolve(opts.api(path, body) as T);
      if (opts.api && path in opts.api) return Promise.resolve(opts.api[path] as T);
      return Promise.resolve(defaultApi(path, body) as T);
    } catch (e) { return Promise.reject(e); }
  };

  const ctx: ActionContext = {
    signal: new AbortController().signal,
    project,
    async nav(to: string) {
      rec.nav.push(to);
      // Mimic the router: routes are relative to the app base, so strip it first.
      const at = to.startsWith(APP_BASE) ? to.slice(APP_BASE.length) : to;
      if (/^\/p\/[^/]+\/timeline(\?|$)/.test(at)) { current = timelinePage; return; }
      const m = /^\/p\/([^/]+)\/shot\/([^/?]+)/.exec(at);
      if (m) {
        shotPage.sid = m[2];
        const take = new URLSearchParams(at.split("?")[1] || "").get("take");
        if (take) shotPage.selected = take;
        current = shotPage;
      } else if (/^\/p\/[^/]+(\?|$)/.test(at)) {
        current = filmPage;
      } else if (at === "/" || at === "") {
        current = projectsPage;
      }
    },
    page: {
      current: () => current,
      // Overload-compatible implementation; the contract narrows it for callers.
      waitFor: ((kind: "shot" | "film" | "comp" | "projects" | "timeline" | "screen",
                 match?: { sid?: string; cid?: string }) => {
        if (opts.failWaitFor) return Promise.reject(new Error("page did not mount"));
        if (kind === "timeline") {
          current = timelinePage;
          return Promise.resolve(timelinePage);
        }
        if (kind === "screen") {
          return Promise.reject(new Error("the screening room is an overlay, not a fake page"));
        }
        if (kind === "projects") {
          current = projectsPage;
          return Promise.resolve(projectsPage);
        }
        if (kind === "comp") {
          if (match?.cid) compPage.cid = match.cid;
          // The workbench mounts INSIDE the shot page: `current` stays the shot.
          return Promise.resolve(compPage);
        }
        if (kind === "shot") {
          if (match?.sid) shotPage.sid = match.sid;
          current = shotPage;
          return Promise.resolve(shotPage);
        }
        current = filmPage;
        return Promise.resolve(filmPage);
      }) as ActionContext["page"]["waitFor"],
    },
    api,
    resolve: {
      index: async () => Object.values(FIXTURE_SHOTS),
      resolve: async (_pid: string, query: string) =>
        (opts.resolve ?? fakeResolve)(query),
    },
    trail: {
      async step(s) { rec.steps.push(s); },
      steps: () => rec.steps.map((s, i) => ({ id: String(i), t: i, ...s })),
      clear: () => { rec.steps.length = 0; },
    },
    speed: opts.speed ?? "fast",
  };

  const settle: AgentDeps["settleJobs"] = async (ids) => {
    if (typeof opts.settle === "function") return opts.settle(ids);
    if (opts.settle) return opts.settle;
    return ids.map((job) => ({
      job, status: "done",
      result: { takes: [`renders/out/${job}.png`] },
      takes: [{ path: `renders/out/${job}.png`, kind: "still" }],
    }));
  };
  const classify: AgentDeps["classifyBackend"] = async (_pid, _lane, explicit) =>
    opts.backend ?? { backend: explicit || "mock", cost_class: "free" };

  installDeps({ settleJobs: settle, classifyBackend: classify });

  return { ctx, rec, shotPage, filmPage, compPage, projectsPage, timelinePage,
           cues, restore: resetDeps };
}

/** A paid-backend classifier, for the needs_confirmation paths. */
export const PAID_BACKEND: BackendChoice = {
  backend: "openrouter-image", model: "flux-schnell", cost_class: "paid", cost_usd: 0.04,
};
