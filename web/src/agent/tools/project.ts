/**
 * Starting a film from nothing (workstream K).
 *
 * Every other tool in this catalogue assumes a film already exists. These four
 * are the ones a visitor's agent reaches for first: make a project, write the
 * script into it, name the cast, and see what is already here. `write_script`
 * is the load-bearing one — its descriptions carry the house prompt style, so
 * an LLM that has never seen this app writes prompts the still lane can use.
 *
 * The script write is one POST (`/shots/batch`), not one per shot: forty
 * round trips through the UI would be a worse demo and a worse product.
 */
import type { ActionDef, ProjectsPageHandles, ToolResult } from "../contract";
import { ANCHORS, err, ok } from "../contract";
import { cut, filmUrl, maybeNum, shotUrl } from "./util";

const PROJECTS_ROUTE = "/";
const FILM_ROUTE = "/p/:pid";
const SHOT_ROUTE = "/p/:pid/shot/:sid";

const MAX_SHOTS = 40;
const MAX_SECONDS = 300;

const statusOf = (e: unknown): number => Number((e as { status?: number })?.status) || 0;
const messageOf = (e: unknown): string =>
  cut((e as { message?: string })?.message ?? String(e), 220);

/** The server slugifies too; doing it here means the tool can report the id. */
export const slugify = (raw: unknown): string =>
  String(raw ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

/** 403 / 429 / 409 all mean something specific to a visitor. Relay the words. */
function serverError(e: unknown, fallback: string): ReturnType<typeof err> {
  const status = statusOf(e);
  const hint = messageOf(e);
  if (status === 429) return err("rate_limited", { hint });
  if (status === 403) return err("forbidden", { hint });
  if (status === 409) return err("project_exists", { hint });
  if (status === 400) return err("rejected", { hint });
  return err(fallback, { hint });
}

// ---------------------------------------------------------------- create_project

interface CreateArgs { id?: string; title: string; fps?: number }

export const createProject: ActionDef<CreateArgs> = {
  name: "create_project",
  title: "Start a new film",
  description:
    "Start a new, empty film in Cutroom and open its Film Editor. Give it a " +
    "title; the id is a slug derived from that unless you pass one. The new " +
    "project inherits this instance's lane defaults, so generating on it goes " +
    "to the configured providers rather than whatever backend happens to be " +
    "first. Hosted demos cap how many films one visitor may start per day and " +
    "say so plainly. Follow it with write_script to fill the film with shots.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the film is called, e.g. \"The Bread Riot\". Shown on the project card." },
      id: { type: "string", description: "URL slug for the project. Lowercase letters, digits and dashes. Derived from the title when omitted." },
      fps: { type: "number", minimum: 1, maximum: 60, description: "Frames per second for the cut. Default 24; leave it alone unless the director asks." },
    },
    required: ["title"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: PROJECTS_ROUTE, anchor: ANCHORS.projectsCreate,
           label: "Projects → New empty project" },
  keywords: ["new project", "new film", "create", "start", "empty", "slug", "make a short"],
  howTo: "On the Projects page, type a slug under \"New empty project\" and press create; the card appears and links to its Film Editor.",
  summarize: (a) => `Start a new film — ${cut(a?.title || a?.id, 40)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const title = String(args?.title ?? "").trim();
    const id = slugify(args?.id || title);
    if (!id) {
      return err("needs_title", {
        hint: "Give the film a title, e.g. create_project {title:\"The Bread Riot\"}.",
      });
    }
    const fps = maybeNum(args?.fps);

    let page: ProjectsPageHandles | null = null;
    try {
      await ctx.nav(PROJECTS_ROUTE);
      page = await ctx.page.waitFor("projects", undefined, 4000);
    } catch { /* the write still stands; it just will not be typed on screen */ }
    await ctx.trail.step({
      tool: "create_project", title: `Projects → new project “${cut(title || id, 30)}”`,
      anchor: ANCHORS.projectsNewId, detail: id,
    });

    const body = { id, label: title || id, title: title || id,
                   ...(fps ? { fps } : {}) };
    try {
      if (page) await page.createProject(id, body);
      else await ctx.api("/api/projects", body);
    } catch (e) {
      const res = serverError(e, "create_failed");
      if (res.error === "project_exists") {
        res.hint = `${messageOf(e)} — open it with list_projects, or pick another id.`;
      }
      return res;
    }
    await ctx.trail.step({
      tool: "create_project", title: `create ${id}`, anchor: ANCHORS.projectsCreate,
    });

    let lanes: Record<string, { backend?: string | null; model?: string | null }> = {};
    try {
      lanes = await ctx.api<typeof lanes>(`/api/projects/${id}/lanes`) || {};
    } catch { /* lane defaults are reportable, not required */ }

    const url = filmUrl(id);
    try {
      await ctx.nav(url);
      await ctx.trail.step({ tool: "create_project", title: `Open Film Editor — ${id}`,
                             detail: url });
    } catch { /* the project exists either way */ }

    return ok(`“${cut(title || id, 40)}” is open and empty`, {
      project: id,
      title: title || id,
      url,
      ...(fps ? { fps } : {}),
      lanes: Object.fromEntries(Object.entries(lanes)
        .filter(([, v]) => v?.backend)
        .map(([k, v]) => [k, v.model ? `${v.backend}:${cut(v.model, 24)}` : v.backend!])),
      next: "call write_script with the shots — the film has none yet",
    });
  },
};

// ---------------------------------------------------------------- write_script

interface ShotIn {
  sid?: string; beat?: string; act?: number; type?: string; seconds?: number;
  register?: string; image_prompt?: string; negative?: string;
  motion_prompt?: string; radio?: string;
  dialogue?: ({ character?: string; line?: string } | string)[];
  sfx?: string; ambient?: string; cut?: string; render_notes?: string;
}
interface ScriptArgs { project?: string; shots: ShotIn[]; replace?: boolean }

const SHOT_FIELDS = [
  "sid", "beat", "act", "type", "seconds", "register", "image_prompt",
  "negative", "motion_prompt", "radio", "dialogue", "sfx", "ambient", "cut",
  "render_notes",
] as const;

/** "ROBESPIERRE: not again" is what an LLM writes when the schema slips. */
const normalizeDialogue = (rows: unknown): unknown => {
  if (!Array.isArray(rows)) return undefined;
  return rows.map((r) => {
    if (typeof r === "string") {
      const at = r.indexOf(":");
      return at > 0
        ? { character: r.slice(0, at).trim(), line: r.slice(at + 1).trim() }
        : { character: "", line: r.trim() };
    }
    const row = (r || {}) as { character?: string; line?: string; text?: string };
    return { character: String(row.character ?? "").trim(),
             line: String(row.line ?? row.text ?? "").trim() };
  }).filter((d) => d.line);
};

const SHOT_SCHEMA = {
  type: "object" as const,
  properties: {
    sid: { type: "string" as const, description: "Shot id like B01-S3 (beat, then shot within it). Omit and they are numbered for you." },
    act: { type: "integer" as const, minimum: 1, description: "Which act this shot belongs to, 1-4. Shots with no beat get one beat per act." },
    beat: { type: "string" as const, description: "Beat id like B02 — a scene inside an act. Optional; the act supplies one." },
    type: { type: "string" as const, enum: ["STILL", "HERO"], description: "STILL for a plain shot, HERO for the one the eye lands on. Default STILL." },
    seconds: { type: "number" as const, minimum: 2, maximum: 20, description: "How long the shot holds, 2 to 20 seconds. Default 6. The whole film must stay under 300." },
    register: { type: "string" as const, description: "The colour and light register of this run of shots, e.g. \"R2 (warm lamplight, the bakery)\"." },
    image_prompt: { type: "string" as const, description: "Setting sentence. Then \"Subject: …\" for what the camera is on. Then the framing. End with \"cinematic anime film still\"." },
    negative: { type: "string" as const, description: "What must not appear: \"text, watermark, extra limbs, photorealistic, 3D render\"." },
    motion_prompt: { type: "string" as const, description: "The one thing that moves, if anything: \"only the wig trembles\". Leave it out for a held still." },
    radio: { type: "string" as const, description: "Narration over the shot. Twenty-five words at most — it has to fit the hold." },
    dialogue: { type: "array" as const, description: "Lines spoken in the shot, in order. Twelve words each at most.",
                items: { type: "object" as const, properties: {
                  character: { type: "string" as const, description: "Who speaks, e.g. \"MARGOT\"." },
                  line: { type: "string" as const, description: "What they say. Twelve words at most." } } } },
    sfx: { type: "string" as const, description: "One sound effect, in words: \"a distant crowd, one cart wheel\"." },
    ambient: { type: "string" as const, description: "The bed under the shot: \"street noise, rain on stone\"." },
    cut: { type: "string" as const, description: "How this shot leaves: \"hard\", \"freeze then cut\"." },
    render_notes: { type: "string" as const, description: "A rule for whoever renders it: \"no visible faces anywhere in the film\"." },
  },
  required: ["image_prompt"],
};

export const writeScript: ActionDef<ScriptArgs> = {
  name: "write_script",
  title: "Write the script",
  description:
    "Write a film's whole shot list in one call — the list IS the cut, in " +
    "order. House style for image_prompt: a sentence of setting, then " +
    "\"Subject: …\" for what the camera is on, then the framing, then " +
    "\"cinematic anime film still\". Keep radio narration under 25 words and " +
    "each dialogue line under 12. Up to 40 shots, 2-20 seconds each, 300 " +
    "seconds in total. Opens the Film Editor, writes, and shows the first " +
    "shot's Script tab. Use replace to throw out the old script.",
  inputSchema: {
    type: "object",
    properties: {
      shots: { type: "array", minItems: 1, maxItems: MAX_SHOTS, items: SHOT_SCHEMA,
               description: "The shots, in the order they play. Each needs an image_prompt; everything else has a sensible default." },
      project: { type: "string", description: "Project id to write into. Defaults to the film that is open." },
      replace: { type: "boolean", description: "True deletes every shot this script does not name — a rewrite, not an edit. Default false." },
    },
    required: ["shots"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmShot, label: "Film Editor → the strip" },
  keywords: ["script", "shots", "write", "screenplay", "shot list", "beats", "story", "outline"],
  howTo: "Scripts arrive with an import today; by hand you would write prompts/shots.jsonl and import the folder from the Projects page.",
  summarize: (a) => `Write ${a?.shots?.length ?? 0} shots into the script`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = slugify(args?.project) || ctx.project;
    if (!pid) {
      return err("no_project", {
        hint: "Name the project, or call create_project first — a script needs a film to live in.",
      });
    }
    const rows = Array.isArray(args?.shots) ? args.shots : [];
    if (!rows.length) {
      return err("needs_shots", {
        hint: "Pass shots: [{image_prompt, seconds, radio, …}, …] in the order they play.",
      });
    }
    if (rows.length > MAX_SHOTS) {
      return err("too_many_shots", {
        hint: `${rows.length} shots — the cap is ${MAX_SHOTS}. Write the first act, then call write_script again.`,
      });
    }

    const shots = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const f of SHOT_FIELDS) {
        const v = (row as Record<string, unknown>)[f];
        if (v === undefined || v === null || v === "") continue;
        out[f] = f === "dialogue" ? normalizeDialogue(v) : v;
      }
      return out;
    });
    const missing = shots.findIndex((s) => !String(s.image_prompt ?? "").trim());
    if (missing >= 0) {
      return err("needs_image_prompt", {
        hint: `Shot ${missing + 1} has no image_prompt. Every shot needs one: setting, "Subject: …", framing, "cinematic anime film still".`,
      });
    }

    const film = filmUrl(pid);
    try {
      await ctx.nav(film);
      await ctx.page.waitFor("film", undefined, 4000);
    } catch { /* the write does not depend on the view */ }
    await ctx.trail.step({
      tool: "write_script", title: `Film Editor → writing ${shots.length} shots`,
      anchor: ANCHORS.filmShot, detail: film,
    });

    let wrote: { count?: number; sids?: string[]; total_seconds?: number };
    try {
      wrote = await ctx.api<typeof wrote>(`/api/projects/${pid}/shots/batch`, {
        shots, ...(args?.replace ? { replace: true } : {}),
      });
    } catch (e) {
      return serverError(e, "script_write_failed");
    }
    const sids = wrote?.sids || [];
    if (!sids.length) {
      return err("script_write_failed", { hint: "The server accepted the call but wrote no shots." });
    }

    // The strip and the shot resolver are both stale until they refetch.
    try {
      const page = await ctx.page.waitFor("film", undefined, 1500);
      await page.refresh();
    } catch { /* the human may be elsewhere */ }
    try { await ctx.resolve.index(pid, { force: true }); } catch { /* best effort */ }

    const first = sids[0];
    const scriptUrl = shotUrl(pid, first, { tab: "script" });
    try {
      await ctx.nav(scriptUrl);
      await ctx.page.waitFor("shot", { sid: first }, 4000);
      await ctx.trail.step({
        tool: "write_script", title: `Script — ${first}`,
        anchor: ANCHORS.scriptPanel, detail: scriptUrl,
      });
    } catch { /* the script is written whether or not we got to look at it */ }

    const seconds = wrote?.total_seconds ?? shots.reduce(
      (t, s) => t + (maybeNum(s.seconds) ?? 6), 0);
    return ok(`${sids.length} shots written — ${Math.round(seconds)}s of film`, {
      project: pid,
      count: wrote?.count ?? sids.length,
      sids: sids.slice(0, MAX_SHOTS),
      total_seconds: Math.round(seconds * 10) / 10,
      replaced: !!args?.replace,
      url: scriptUrl,
      next: "call generate_takes per shot, synthesize_vo for radio lines, generate_music, then cut_film",
    });
  },
};

// ---------------------------------------------------------------- set_project_cast

interface CharacterIn { id?: string; name?: string; descriptor?: string; aliases?: string[] }
interface CastArgs { project?: string; characters: CharacterIn[] }

export const setProjectCast: ActionDef<CastArgs> = {
  name: "set_project_cast",
  title: "Name the cast",
  description:
    "Register who is in the film so shots can be found by character later: " +
    "\"the Margot close-up\" resolves because the cast index knows Margot is " +
    "the baker. Each entry is a name plus a short descriptor of the role, and " +
    "aliases are derived from both. Write it right after write_script, using " +
    "the same names the prompts use. Replaces the whole cast each time, so " +
    "send everyone at once.",
  inputSchema: {
    type: "object",
    properties: {
      characters: {
        type: "array", minItems: 1, maxItems: 24,
        description: "Everyone in the film. Send them all: this replaces the cast rather than adding to it.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The character's name as the prompts write it, e.g. \"Margot\"." },
            descriptor: { type: "string", description: "The role in a few words: \"the baker who starts it\". Becomes searchable aliases." },
            id: { type: "string", description: "Stable id. Derived from the name when omitted." },
            aliases: { type: "array", items: { type: "string" }, description: "Extra ways the director might say this character: \"the baker\", \"her\"." },
          },
          required: ["name", "descriptor"],
        },
      },
      project: { type: "string", description: "Project id. Defaults to the film that is open." },
    },
    required: ["characters"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: { route: FILM_ROUTE, anchor: ANCHORS.filmShot, label: "Film Editor → the strip" },
  keywords: ["cast", "characters", "who", "names", "roles", "index", "dramatis personae"],
  howTo: "An imported project takes its cast from prompts/characters.jsonl; a project created here gets one through this tool.",
  summarize: (a) => `Name ${a?.characters?.length ?? 0} characters`,
  async execute(args, ctx): Promise<ToolResult> {
    const pid = slugify(args?.project) || ctx.project;
    if (!pid) return err("no_project", { hint: "Name the project, or open one first." });
    const rows = Array.isArray(args?.characters) ? args.characters : [];
    if (!rows.length) {
      return err("needs_characters", {
        hint: "Pass characters: [{name:\"Margot\", descriptor:\"the baker who starts it\"}, …].",
      });
    }

    const characters = rows.map((c) => {
      const name = String(c?.name ?? "").trim();
      const role = String(c?.descriptor ?? "").trim();
      return {
        ...(c?.id ? { id: String(c.id) } : {}),
        character: role ? `${name} — ${role}` : name,
        ...(Array.isArray(c?.aliases) && c.aliases.length
          ? { aliases: c.aliases.map((a) => String(a)).slice(0, 8) } : {}),
      };
    }).filter((c) => c.character);
    if (!characters.length) {
      return err("needs_characters", { hint: "Every character needs at least a name." });
    }

    let res: { cast?: { name: string; aliases: string[] }[] };
    try {
      res = await ctx.api<typeof res>(`/api/projects/${pid}/cast`, { characters });
    } catch (e) {
      return serverError(e, "cast_write_failed");
    }
    const cast = res?.cast || [];
    await ctx.trail.step({
      tool: "set_project_cast",
      title: `Cast — ${cast.map((c) => c.name).slice(0, 4).join(", ") || characters.length}`,
      anchor: ANCHORS.filmShot,
    });

    return ok(`${cast.length || characters.length} characters in the cast`, {
      project: pid,
      cast: cast.slice(0, 12).map((c) => ({
        name: c.name, aliases: (c.aliases || []).slice(0, 4),
      })),
      next: "find_shots can now resolve a character by name",
    });
  },
};

// ---------------------------------------------------------------- list_projects

interface ProjectRow { id: string; label?: string; shots?: number; paused?: boolean }

export const listProjects: ActionDef<Record<string, never>> = {
  name: "list_projects",
  title: "List the films",
  description:
    "List every film on this Cutroom: its id, its title, how many shots it " +
    "holds and whether it is paused. Use it to find out whether the film the " +
    "director means already exists before starting another one, and to get " +
    "the project id the other tools take. Reads only; nothing is opened and " +
    "nothing changes.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  where: { route: PROJECTS_ROUTE, anchor: ANCHORS.projectsCard, label: "Projects → the cards" },
  keywords: ["projects", "films", "list", "which project", "open", "switch"],
  howTo: "The Projects page is the front door — every film is a card with its shot count; click one to open its Film Editor.",
  summarize: () => "List the films on this Cutroom",
  async execute(_args, ctx): Promise<ToolResult> {
    let rows: ProjectRow[];
    try { rows = (await ctx.api<ProjectRow[]>("/api/projects")) || []; }
    catch (e) { return serverError(e, "projects_unavailable"); }

    return ok(rows.length ? `${rows.length} film${rows.length === 1 ? "" : "s"}`
                          : "no films yet", {
      open: ctx.project,
      projects: rows.slice(0, 20).map((p) => ({
        id: p.id, title: cut(p.label || p.id, 40), shots: p.shots ?? 0,
        ...(p.paused ? { paused: true } : {}),
        url: `/p/${p.id}`,
      })),
      hint: rows.length
        ? "Pass one of these ids as `project`, or open_shot to start work in it."
        : "create_project starts one, then write_script fills it.",
    });
  },
};

export const MAX_SCRIPT_SHOTS = MAX_SHOTS;
export const MAX_SCRIPT_SECONDS = MAX_SECONDS;
