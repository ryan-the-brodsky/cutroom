/**
 * Music & SFX — generate a score or a sound effect and place it on the film.
 *
 * Workstream H. Every cue lands in the project's cue sheet
 * (`music_cues` / `sfx_cues`), which the assembler mixes into the cut and the
 * timeline compiles onto its MUSIC / SFX tracks. Gain is DECIBELS throughout:
 * 0 is unity, negative rides under the VO.
 */
import type { ActionDef, CuePlacement, CueRecord, ResolvedShot, ToolResult } from "../contract";
import { ANCHORS, err, ok, shotTabAnchor } from "../contract";
import { deps, type BackendChoice } from "./deps";
import {
  FILM_ROUTE, SHOT_ROUTE, asError, basename, costGate, cut, lookupShot,
  maybeNum, numOr, openFilmPage, openShotPage,
} from "./util";

// ---------------------------------------------------------------- shared

/** Doctrine defaults: music is a bed, SFX is an accent. */
const DEFAULT_GAIN = { music: -8, sfx: -4 } as const;   // measured on the hosted demo: -16 buried a -17 dB RMS bed under the VO

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

const timecode = (s: number | null | undefined): string => {
  if (s == null || !Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

interface CueSheet { music: CueRecord[]; sfx: CueRecord[] }

const compactCue = (c: CueRecord) => ({
  id: c.id,
  at: timecode(c.at),
  file: cut(basename(c.path), 30),
  ...(c.shot ? { shot: c.shot } : {}),
  gain: `${c.gain ?? 0}dB`,
  ...(c.duration ? { seconds: c.duration } : {}),
  ...(c.exists === false ? { missing: true } : {}),
});

/** The film's opening shot — where music goes when nobody names a place. */
async function firstShot(
  ctx: { resolve: { index(pid: string): Promise<ResolvedShot[]> } }, pid: string,
): Promise<ResolvedShot | null> {
  try {
    const all = await ctx.resolve.index(pid);
    return [...all].sort((a, b) => a.ordinal - b.ordinal)[0] ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------- generate_music

interface MusicArgs {
  prompt: string;
  seconds?: number;
  instrumental?: boolean;
  shot?: string;
  start?: number;
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  place?: boolean;
  backend?: string;
  confirm_cost?: boolean;
}

export const generateMusic: ActionDef<MusicArgs> = {
  name: "generate_music",
  title: "Score a stretch of the film",
  description:
    "Compose a music cue for the film and lay it on the audio bed. Opens a " +
    "shot's Audio tab, fills the Music console, presses ▶ music, then places " +
    "the finished piece as a cue — at that shot's start, at a time you name, " +
    "or at the head of the film. Describe the music the way a director would " +
    "(instrument, tempo, feeling). Gain is decibels: -8 is a bed under " +
    "narration, 0 is a hero cue. Paid backends require confirm_cost. Set " +
    "place false to audition it without touching the cut.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The music, in plain words: instruments, tempo, mood — e.g. 'slow upright bass and brushed snare, elegiac'." },
      seconds: { type: "number", minimum: 5, maximum: 120, default: 30, description: "How long the piece runs. The ElevenLabs music model's floor is 10s; shorter asks are raised to it." },
      instrumental: { type: "boolean", description: "True forbids vocals — the right default for anything sitting under dialogue." },
      shot: { type: "string", description: "Place the cue at this shot's start: a sid (B10-S2), its number in the cut, a beat, or a description." },
      start: { type: "number", description: "Place the cue at this many seconds into the film instead. Ignored when shot is given." },
      gain: { type: "number", description: "Cue level in dB. 0 is unity, negative is quieter. Defaults to -8, a bed under the voice-over." },
      fade_in: { type: "number", description: "Fade the cue up over this many seconds." },
      fade_out: { type: "number", description: "Fade the cue down over this many seconds at its end." },
      place: { type: "boolean", default: true, description: "False generates the take but leaves the cut alone — audition first, place later with place_cue." },
      backend: { type: "string", description: "Force a music backend id instead of the project's lane default." },
      confirm_cost: { type: "boolean", description: "Set true to approve a paid music backend. Required whenever the music lane bills money." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "audio" }, anchor: ANCHORS.musicSubmit,
    label: "Shot Editor → Audio → Music & SFX → ▶ music",
  },
  keywords: ["music", "score", "soundtrack", "theme", "cue", "bed", "underscore", "compose"],
  howTo:
    "Open any shot's Audio tab, scroll to Music & SFX, type what the music " +
    "should be, set the seconds, and press ▶ music. The finished piece is " +
    "added to the shot's cue list and shows up on the Film Editor cue strip.",
  summarize: (a) => `Score ${numOr(a?.seconds, 30)}s — ${cut(a?.prompt, 40)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) {
      return err("no_project", { hint: "Open a project first, or call get_context." });
    }
    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) {
      return err("needs_prompt", {
        hint: "Describe the music — instruments, tempo, feeling.",
      });
    }
    const seconds = clamp(numOr(args?.seconds, 30), 5, 120);

    let choice: BackendChoice;
    try { choice = await deps.classifyBackend(pid, "music", args?.backend, ctx.api); }
    catch { choice = { backend: args?.backend || "mock", cost_class: "free" }; }
    const gate = costGate(choice, 1, "music cue", args?.confirm_cost === true);
    if (gate) return gate;

    // The Music console lives on a shot's Audio tab, so pick the shot the cue
    // will hang off — the named one, else the film's opening shot.
    let anchor: ResolvedShot | null = null;
    if (args?.shot) {
      const found = await lookupShot(ctx, args.shot);
      if (!found.ok) return found.res;
      anchor = found.shot;
    } else {
      anchor = await firstShot(ctx, pid);
    }
    if (!anchor) {
      return err("no_shots", {
        hint: "This project has no shots yet — import or add one before scoring it.",
      });
    }

    const opened = await openShotPage(ctx, "generate_music", pid, anchor.sid, { tab: "audio" });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    page.setTab("audio");
    await ctx.trail.step({
      tool: "generate_music", title: "Open the Audio tab", anchor: shotTabAnchor("audio"),
    });
    page.setCueField("music", "prompt", prompt);
    await ctx.trail.step({
      tool: "generate_music", title: "Describe the music",
      anchor: ANCHORS.musicPrompt, detail: cut(prompt, 120),
    });
    page.setCueField("music", "seconds", seconds);
    await ctx.trail.step({
      tool: "generate_music", title: `${seconds}s`, anchor: ANCHORS.musicSeconds,
    });
    if (typeof args?.instrumental === "boolean") {
      page.setCueField("music", "instrumental", args.instrumental);
      await ctx.trail.step({
        tool: "generate_music", title: args.instrumental ? "Instrumental" : "Vocals allowed",
        anchor: ANCHORS.musicInstrumental,
      });
    }

    let job: string;
    try { ({ job } = await page.submitMusic()); }
    catch (e) { return asError(e, "music_failed", "The music backend refused the prompt"); }
    await ctx.trail.step({
      tool: "generate_music", title: "▶ music", anchor: ANCHORS.musicSubmit, job,
    });

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try {
      settled = await deps.settleJobs([job], {
        settleMs: 45000, signal: ctx.signal, api: ctx.api,
      });
    } catch { /* queued regardless */ }
    const s0 = settled[0];
    if (s0?.status === "error" || s0?.status === "failed") {
      return err("music_failed", {
        job, jobs: [job], backend: choice.backend,
        hint: cut(s0.error, 160) || "The music job failed — open Jobs for the log.",
      });
    }
    const take = s0?.takes?.[0]?.path ?? null;
    if (!take) {
      return ok(`Music queued (${seconds}s)`, {
        job, jobs: [job], backend: choice.backend, cost_class: choice.cost_class,
        status: s0?.status ?? "queued", placed: false,
        hint: "Still composing — call wait_for_jobs, then place_cue with the take path.",
      });
    }

    const place = args?.place !== false;
    let cue: CueRecord | null = null;
    if (place) {
      const placement: CuePlacement = {
        kind: "music", path: take, gain: numOr(args?.gain, DEFAULT_GAIN.music),
        duration: seconds,
      };
      if (args?.shot) placement.shot = anchor.sid;
      else placement.start = Math.max(0, numOr(args?.start, 0));
      const fi = maybeNum(args?.fade_in);
      const fo = maybeNum(args?.fade_out);
      if (fi) placement.fade_in = fi;
      if (fo) placement.fade_out = fo;
      try { cue = await page.addCue(placement); }
      catch (e) {
        return ok(`Music is ready but not placed — ${cut(basename(take), 40)}`, {
          job, jobs: [job], take: cut(take, 64), placed: false,
          backend: choice.backend,
          hint: `Placing failed (${cut((e as Error)?.message, 80)}) — retry with place_cue.`,
        });
      }
      await ctx.trail.step({
        tool: "generate_music", title: `Cue at ${timecode(cue?.at ?? placement.start ?? 0)}`,
        anchor: ANCHORS.shotCues,
      });
    }
    try { await page.refresh(); } catch { /* fine */ }

    return ok(
      place
        ? `${seconds}s of music placed at ${timecode(cue?.at ?? args?.start ?? 0)}`
        : `${seconds}s of music ready (not placed)`,
      {
        job, jobs: [job], take: cut(take, 64),
        backend: choice.backend, cost_class: choice.cost_class,
        seconds, instrumental: !!args?.instrumental,
        placed: place,
        ...(cue ? { cue: compactCue(cue) } : {}),
        hint: place
          ? "Call cut_film to hear it in the cut, or list_cues for the whole sheet."
          : "Place it later with place_cue using this take path.",
      },
    );
  },
};

// ---------------------------------------------------------------- generate_sfx

interface SfxArgs {
  shot: string;
  prompt: string;
  seconds?: number;
  offset?: number;
  gain?: number;
  prompt_influence?: number;
  place?: boolean;
  backend?: string;
  confirm_cost?: boolean;
}

export const generateSfx: ActionDef<SfxArgs> = {
  name: "generate_sfx",
  title: "Add a sound effect to a shot",
  description:
    "Make a sound effect for one shot and pin it there. Opens that shot's " +
    "Audio tab, fills the SFX console, presses ▶ sfx, then places the result " +
    "as a cue at the shot's start plus any offset you give — so it follows " +
    "the shot when the timing changes. Describe the sound, not the feeling: " +
    "'a heavy wooden door slamming in a stone hall'. Gain is decibels; -4 is " +
    "an accent, -18 is a bed. Paid backends require confirm_cost.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      prompt: { type: "string", description: "The sound itself — source, material and space, e.g. 'chalk scraping on brick, close, dry room'." },
      seconds: { type: "number", minimum: 1, maximum: 10, default: 3, description: "How long the effect runs. Keep it tight; the backend's ceiling is 30s." },
      offset: { type: "number", description: "Seconds after the shot's first frame to trigger it. Defaults to 0, right on the cut." },
      gain: { type: "number", description: "Cue level in dB. 0 is unity, negative is quieter. Defaults to -4, an accent over the bed." },
      prompt_influence: { type: "number", minimum: 0, maximum: 1, description: "How literally the model follows the words. Higher is obedient, lower is inventive." },
      place: { type: "boolean", default: true, description: "False generates the take but leaves the cut alone — audition first, place later with place_cue." },
      backend: { type: "string", description: "Force an SFX backend id instead of the project's lane default." },
      confirm_cost: { type: "boolean", description: "Set true to approve a paid SFX backend. Required whenever the SFX lane bills money." },
    },
    required: ["shot", "prompt"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "audio" },
    anchor: ANCHORS.sfxSubmit,
    label: "Shot Editor → Audio → Music & SFX → ▶ sfx",
  },
  keywords: ["sfx", "sound", "effect", "foley", "noise", "ambience", "cue", "audio"],
  howTo:
    "Open the shot's Audio tab, scroll to Music & SFX, describe the sound in " +
    "the SFX box, set the seconds, and press ▶ sfx. The take is pinned to " +
    "this shot as a cue and listed underneath.",
  summarize: (a) => `SFX for ${cut(a?.shot, 20)} — ${cut(a?.prompt, 34)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) {
      return err("needs_prompt", { hint: "Describe the sound — source, material, space." });
    }
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;
    const seconds = clamp(numOr(args?.seconds, 3), 1, 10);

    let choice: BackendChoice;
    try { choice = await deps.classifyBackend(pid, "sfx", args?.backend, ctx.api); }
    catch { choice = { backend: args?.backend || "mock", cost_class: "free" }; }
    const gate = costGate(choice, 1, "sound effect", args?.confirm_cost === true);
    if (gate) return gate;

    const opened = await openShotPage(ctx, "generate_sfx", pid, shot.sid, { tab: "audio" });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    page.setTab("audio");
    await ctx.trail.step({
      tool: "generate_sfx", title: "Open the Audio tab", anchor: shotTabAnchor("audio"),
    });
    page.setCueField("sfx", "prompt", prompt);
    await ctx.trail.step({
      tool: "generate_sfx", title: "Describe the sound",
      anchor: ANCHORS.sfxPrompt, detail: cut(prompt, 120),
    });
    page.setCueField("sfx", "seconds", seconds);
    const influence = maybeNum(args?.prompt_influence);
    if (influence !== undefined) page.setCueField("sfx", "influence", clamp(influence, 0, 1));
    await ctx.trail.step({
      tool: "generate_sfx", title: `${seconds}s`, anchor: ANCHORS.sfxSeconds,
    });

    let job: string;
    try { ({ job } = await page.submitSfx()); }
    catch (e) { return asError(e, "sfx_failed", "The SFX backend refused the prompt"); }
    await ctx.trail.step({
      tool: "generate_sfx", title: "▶ sfx", anchor: ANCHORS.sfxSubmit, job,
    });

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try {
      settled = await deps.settleJobs([job], {
        settleMs: 20000, signal: ctx.signal, api: ctx.api,
      });
    } catch { /* queued regardless */ }
    const s0 = settled[0];
    if (s0?.status === "error" || s0?.status === "failed") {
      return err("sfx_failed", {
        shot: shot.sid, job, jobs: [job], backend: choice.backend,
        hint: cut(s0.error, 160) || "The SFX job failed — open Jobs for the log.",
      });
    }
    const take = s0?.takes?.[0]?.path ?? null;
    if (!take) {
      return ok(`SFX queued for ${shot.sid}`, {
        shot: shot.sid, job, jobs: [job], backend: choice.backend,
        cost_class: choice.cost_class, status: s0?.status ?? "queued", placed: false,
        hint: "Still rendering — call wait_for_jobs, then place_cue with the take path.",
      });
    }

    const place = args?.place !== false;
    let cue: CueRecord | null = null;
    if (place) {
      const placement: CuePlacement = {
        kind: "sfx", path: take, shot: shot.sid,
        offset: Math.max(0, numOr(args?.offset, 0)),
        gain: numOr(args?.gain, DEFAULT_GAIN.sfx),
      };
      try { cue = await page.addCue(placement); }
      catch (e) {
        return ok(`SFX ready but not placed — ${cut(basename(take), 40)}`, {
          shot: shot.sid, job, jobs: [job], take: cut(take, 64), placed: false,
          hint: `Placing failed (${cut((e as Error)?.message, 80)}) — retry with place_cue.`,
        });
      }
      await ctx.trail.step({
        tool: "generate_sfx", title: `Cue on ${shot.sid}`, anchor: ANCHORS.shotCues,
      });
    }
    try { await page.refresh(); } catch { /* fine */ }

    return ok(
      place ? `SFX pinned to ${shot.sid} at ${timecode(cue?.at)}`
        : `SFX ready for ${shot.sid} (not placed)`,
      {
        shot: shot.sid, job, jobs: [job], take: cut(take, 64),
        backend: choice.backend, cost_class: choice.cost_class,
        seconds, placed: place,
        ...(cue ? { cue: compactCue(cue) } : {}),
        hint: place
          ? "Call cut_film to hear it in the cut."
          : "Place it later with place_cue using this take path.",
      },
    );
  },
};

// ---------------------------------------------------------------- place_cue

interface PlaceArgs {
  kind?: "music" | "sfx";
  take?: string;
  path?: string;
  shot?: string;
  start?: number;
  offset?: number;
  duration?: number;
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  loop?: boolean;
  label?: string;
}

export const placeCue: ActionDef<PlaceArgs> = {
  name: "place_cue",
  title: "Place an audio cue on the film",
  description:
    "Lay an existing audio file on the film's music or SFX track. Give it a " +
    "take path and either a shot (the cue rides that shot's start and moves " +
    "with it) or a start time in film seconds. Opens the Film Editor's cue " +
    "strip so the placement is visible. Gain is decibels — 0 unity, -8 a " +
    "bed. Use it to re-place a take you generated with place false, or to " +
    "move a piece of music you already have. Returns the cue with its id.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["music", "sfx"], description: "Which track the cue rides. Inferred from the path (audio/music/… or audio/sfx/…) when omitted." },
      take: { type: "string", description: "The audio file, project-relative — e.g. audio/music/theme.mp3. A generate_music or generate_sfx take path." },
      path: { type: "string", description: "Alias for take. The project-relative audio file to place." },
      shot: { type: "string", description: "Anchor the cue to this shot's start: a sid, its number in the cut, a beat, or a description." },
      start: { type: "number", description: "Anchor the cue this many seconds into the film instead. Ignored when shot is given." },
      offset: { type: "number", description: "Seconds added to whichever anchor won. Use it to sit a hit just after the cut." },
      duration: { type: "number", description: "Trim the cue to this many seconds. Required when loop is true." },
      gain: { type: "number", description: "Cue level in dB. 0 is unity, negative is quieter. Defaults to -8 for music, -4 for SFX." },
      fade_in: { type: "number", description: "Fade the cue up over this many seconds." },
      fade_out: { type: "number", description: "Fade the cue down over this many seconds at its end." },
      loop: { type: "boolean", description: "Repeat the file until duration is filled — for room tone and ambience beds." },
      label: { type: "string", description: "A short note shown on the cue strip, e.g. 'main theme' or 'door slam'." },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmCues, label: "Film Editor → cue strip" },
  keywords: ["cue", "place", "music", "sfx", "audio", "bed", "sound", "timeline"],
  howTo:
    "On the Film Editor, scroll to the cue strip under the Cuts gallery and " +
    "add the file with a time or a shot; or place it from the shot's Audio " +
    "tab, where every take has a “place as cue” button.",
  summarize: (a) => `Place ${cut(basename(String(a?.take || a?.path || "cue")), 26)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) {
      return err("no_project", { hint: "Open a project first, or call get_context." });
    }
    const path = String(args?.take ?? args?.path ?? "").trim();
    if (!path) {
      return err("needs_take", {
        hint: "Pass `take` — the project-relative audio file, e.g. audio/music/theme.mp3.",
      });
    }
    const kind = args?.kind === "music" || args?.kind === "sfx" ? args.kind
      : path.includes("/music/") ? "music"
        : path.includes("/sfx/") ? "sfx" : null;
    if (!kind) {
      return err("needs_kind", {
        hint: `Pass kind:"music" or kind:"sfx" — ${cut(basename(path), 40)} does not say which.`,
      });
    }
    if (args?.loop && !maybeNum(args?.duration)) {
      return err("loop_needs_duration", {
        hint: "A looping cue needs `duration` — how many seconds to fill.",
      });
    }

    let sid: string | null = null;
    if (args?.shot) {
      const found = await lookupShot(ctx, args.shot);
      if (!found.ok) return found.res;
      sid = found.shot.sid;
    }
    if (!sid && args?.start === undefined) {
      return err("needs_place", {
        hint: "Say where: `shot` to ride a shot's start, or `start` in film seconds.",
      });
    }

    const opened = await openFilmPage(ctx, "place_cue", pid);
    if (!opened.ok) return opened.res;
    const page = opened.page;

    const placement: CuePlacement = {
      kind, path, gain: numOr(args?.gain, DEFAULT_GAIN[kind]),
    };
    if (sid) placement.shot = sid;
    else placement.start = Math.max(0, numOr(args?.start, 0));
    const offset = maybeNum(args?.offset);
    if (offset !== undefined) placement.offset = offset;
    for (const k of ["duration", "fade_in", "fade_out"] as const) {
      const v = maybeNum(args?.[k]);
      if (v !== undefined) placement[k] = v;
    }
    if (args?.loop) placement.loop = true;
    if (args?.label) placement.label = cut(args.label, 60);

    let cue: CueRecord;
    try { cue = await page.addCue(placement); }
    catch (e) { return asError(e, "place_failed", "The cue was refused"); }
    await ctx.trail.step({
      tool: "place_cue",
      title: `${kind} cue at ${timecode(cue?.at ?? placement.start ?? 0)}`,
      anchor: ANCHORS.filmCues, detail: cut(basename(path), 40),
    });
    try { await page.refresh(); } catch { /* fine */ }

    return ok(
      `${kind} cue placed at ${timecode(cue?.at ?? placement.start ?? 0)}` +
      (sid ? ` (on ${sid})` : ""),
      {
        cue: compactCue(cue),
        ...(cue?.exists === false
          ? { warning: "no such file in the project yet — the cut will skip it" }
          : {}),
        hint: "Call cut_film to hear it, list_cues for the sheet.",
      },
    );
  },
};

// ---------------------------------------------------------------- list_cues

interface ListArgs { kind?: "music" | "sfx"; scope?: string }

export const listCues: ActionDef<ListArgs> = {
  name: "list_cues",
  title: "Read the cue sheet",
  description:
    "Read the film's cue sheet — every music and SFX cue with the time it " +
    "fires, the shot it rides, its level in dB and its length. Use it before " +
    "scoring to see what is already there, after placing to confirm, and to " +
    "get the cue ids that remove one. A cue whose file is missing is flagged; " +
    "a cue anchored outside the current scope shows no time.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["music", "sfx"], description: "Only this track. Omit for both." },
      scope: { type: "string", description: "Resolve times against a single act (act1..act4) instead of the whole film." },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmCues, label: "Film Editor → cue strip" },
  keywords: ["cues", "cue sheet", "music", "sfx", "audio", "list", "bed"],
  howTo:
    "The cue strip under the Film Editor's Cuts gallery lists every cue with " +
    "its start time; each shot's Audio tab lists just that shot's cues.",
  summarize: (a) => (a?.kind ? `List ${a.kind} cues` : "List the cue sheet"),
  async execute(args, ctx): Promise<ToolResult> {
    const pid = ctx.project;
    if (!pid) {
      return err("no_project", { hint: "Open a project first, or call get_context." });
    }
    const scope = typeof args?.scope === "string" && /^act[1-9]$/.test(args.scope)
      ? args.scope : "full";
    let sheet: CueSheet;
    try {
      sheet = await ctx.api<CueSheet>(
        `/api/projects/${pid}/cues${scope === "full" ? "" : `?scope=${scope}`}`);
    } catch (e) { return asError(e, "cues_unavailable", "Could not read the cue sheet"); }

    const music = (sheet?.music || []).map(compactCue);
    const sfx = (sheet?.sfx || []).map(compactCue);
    const want = args?.kind;
    const total = music.length + sfx.length;
    if (!total) {
      return ok("No cues yet — the cut runs on VO alone.", {
        music: [], sfx: [],
        hint: "generate_music scores a stretch; generate_sfx pins a sound to a shot.",
      });
    }
    return ok(
      `${music.length} music cue${music.length === 1 ? "" : "s"}, ` +
      `${sfx.length} SFX cue${sfx.length === 1 ? "" : "s"}`,
      {
        ...(want !== "sfx" ? { music: music.slice(0, 10) } : {}),
        ...(want !== "music" ? { sfx: sfx.slice(0, 12) } : {}),
        ...(scope !== "full" ? { scope } : {}),
        hint: "Gain is dB (0 unity). place_cue adds one; cut_film mixes them in.",
      },
    );
  },
};
