/**
 * Reference images (workstream S) — "make this shot match THIS picture".
 *
 * The style register says what the film looks like. A reference says who the
 * person is, which object is on the desk, what the room is. The server sends
 * each one to the model ahead of the prompt behind a sentence naming its role,
 * so a face is matched and a setting is matched, rather than both being copied.
 *
 * The image can be named the way a director names one: a take path, "keeper of
 * B02-S2", "newest still of B04-S2", "plays", or an http(s) link, which the
 * server fetches into the project first.
 */
import type {
  ActionContext, ActionDef, RefRole, ShotReference, ToolResult,
} from "../contract";
import { ANCHORS, err, ok } from "../contract";
import {
  SHOT_ROUTE, asError, cut, fetchShot, lookupShot, openShotPage, pickTake,
} from "./util";

const ROLES: RefRole[] = ["character", "prop", "setting", "style"];

const ROLE_NOTE: Record<RefRole, string> = {
  character: "match the face, hair, build and costume",
  prop: "match the object's shape, colour and markings",
  setting: "match the place's architecture, layout and light",
  style: "match line, shading and palette, not content",
};

const IMAGE_WORDS =
  "A take path, an http(s) image url, or words: \"keeper of B02-S2\", " +
  "\"newest still of B04-S2\", \"plays\", \"latest\".";

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** A sid mentioned inside a phrase like "the keeper of B02-S2". */
const sidIn = (s: string): string | null => {
  const m = String(s || "").match(/\b(B\d{1,2}[-_]?S\d{1,2})\b/i);
  return m ? m[1].toUpperCase().replace(/[-_]?S/, "-S") : null;
};

/** Strip the sid out so the rest reads as a take word ("keeper", "newest still"). */
const takeWord = (s: string): string =>
  String(s || "").replace(/\b(B\d{1,2}[-_]?S\d{1,2})\b/i, " ")
    .replace(/\b(of|from|on|the|in|shot)\b/gi, " ")
    .replace(/\s+/g, " ").trim() || "keeper";

export const roleOf = (raw: unknown, fallback: RefRole = "character"): RefRole => {
  const r = String(raw ?? "").trim().toLowerCase();
  if ((ROLES as string[]).includes(r)) return r as RefRole;
  if (/place|location|room|background|environment|set\b/.test(r)) return "setting";
  if (/object|item|thing/.test(r)) return "prop";
  if (/person|face|costume|cast|who/.test(r)) return "character";
  if (/look|palette|line|shading/.test(r)) return "style";
  return fallback;
};

const short = (rows: ShotReference[]) =>
  rows.map((r) => ({ image: cut(r.path.split("/").pop(), 44), role: r.role,
                     ...(r.note ? { note: cut(r.note, 50) } : {}) }));

/**
 * Turn what a caller said into a project path: a link is fetched into the
 * project, "keeper of B02-S2" is looked up on that shot, anything else on
 * this one. Returns null when nothing matches — one-off references never
 * reject a generation, they just do not ride.
 */
export async function resolveRefImage(
  ctx: ActionContext, pid: string, sid: string, want: string,
  role: RefRole = "character",
): Promise<{ path: string; fetched?: boolean } | null> {
  const q = String(want ?? "").trim();
  if (!q) return null;
  if (isUrl(q)) {
    const r = await ctx.api<{ rel: string }>(
      `/api/projects/${pid}/refs/fetch`, { url: q, role, shot: sid });
    return r?.rel ? { path: r.rel, fetched: true } : null;
  }
  const otherSid = sidIn(q);
  const fromSid = otherSid && otherSid !== sid ? otherSid : sid;
  const word = otherSid ? takeWord(q) : q;
  const detail = await fetchShot(ctx, pid, fromSid);
  const hit = await pickTake(ctx, pid, detail, word, { prefer: "image" });
  return hit ? { path: hit.path } : null;
}

/** Read a shot's references, whichever shape the server sent them in. */
async function readRefs(
  ctx: ActionContext, pid: string, sid: string,
): Promise<ShotReference[]> {
  try {
    const d = await fetchShot(ctx, pid, sid);
    const rows = (d as { references?: ShotReference[] }).references
      ?? (d.override?.refs as ShotReference[] | undefined) ?? [];
    return rows.map((r) => (typeof r === "string"
      ? { path: r as string, role: "character" as RefRole } : r));
  } catch { return []; }
}

// ------------------------------------------------------------ attach_reference

interface AttachArgs {
  shot: string; image: string; role?: string; note?: string;
}

export const attachReference: ActionDef<AttachArgs> = {
  name: "attach_reference",
  title: "Attach a reference image",
  description:
    "Attach a reference image to a shot so every still and restyle generated " +
    "for it is sent that picture with the prompt. Say what it is for: " +
    "character (match the face and costume), prop (match the object), setting " +
    "(match the room), style (match line and palette only). The image can be a " +
    "take path, words like \"keeper of B02-S2\", or an http(s) link, which is " +
    "downloaded into the project. Four per shot. Shows in the Generate tab's " +
    "References strip. Backends that take no image input skip them.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot the reference belongs to: a sid (B10-S2), its number in the cut, a beat, or a description." },
      image: { type: "string", description: IMAGE_WORDS },
      role: { type: "string", enum: ROLES,
              description: "What to match: character (face, costume), prop (object), setting (place), style (line and palette only). Default character." },
      note: { type: "string", description: "Optional reminder of why this picture is attached, e.g. \"her coat is grey, not black\"." },
    },
    required: ["shot", "image"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "generate" }, anchor: ANCHORS.genRefs,
    label: "Shot Editor → Generate → References",
  },
  keywords: ["reference", "match", "same face", "same room", "consistency",
             "character", "prop", "setting", "look like", "use this image"],
  howTo:
    "Open the shot's Generate tab — the References strip sits above the console. " +
    "Pick a take, choose what it is for, and press + add.",
  summarize: (a) =>
    `Attach a ${roleOf(a?.role)} reference to ${cut(a?.shot, 24)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;
    const want = String(args?.image ?? "").trim();
    if (!want) {
      return err("needs_image", { hint: `Name the picture. ${IMAGE_WORDS}` });
    }
    const role = roleOf(args?.role);

    // ---- resolve the picture: a link is fetched, a word is looked up
    let found2: { path: string; fetched?: boolean } | null;
    try { found2 = await resolveRefImage(ctx, pid, shot.sid, want, role); }
    catch (e) {
      const msg = cut((e as Error)?.message, 180);
      return err(isUrl(want) ? "fetch_failed" : "shot_fetch_failed", {
        hint: msg || (isUrl(want)
          ? "That link could not be downloaded — save the image and upload it instead."
          : `Could not read the shot named in “${cut(want, 30)}”.`),
      });
    }
    if (!found2) {
      return err("image_not_found", {
        hint: `Nothing matches “${cut(want, 30)}”. ${IMAGE_WORDS}`,
      });
    }
    const { path, fetched } = found2;
    if (/\.(mp4|webm|mov)$/i.test(path)) {
      return err("reference_must_be_a_still", {
        image: cut(path, 60),
        hint: "A reference is a picture. Pick a still, or freeze a frame of that clip first.",
      });
    }

    // ---- drive the Generate tab's References strip
    const opened = await openShotPage(ctx, "attach_reference", pid, shot.sid,
      { tab: "generate" });
    if (!opened.ok) return opened.res;
    const page = opened.page;
    page.setTab("generate");

    let rows: ShotReference[];
    try {
      rows = await page.addReference({ path, role, ...(args?.note
        ? { note: String(args.note).slice(0, 200) } : {}) });
    } catch (e) {
      const msg = cut((e as Error)?.message, 180);
      return err(/at most/.test(msg) ? "too_many_references" : "reference_rejected", {
        hint: msg || "The server refused the reference.",
      });
    }
    await ctx.trail.step({
      tool: "attach_reference",
      title: `${role} reference — ${cut(path.split("/").pop(), 30)}`,
      anchor: ANCHORS.genRef, detail: path,
    });
    try { await page.refresh(); } catch { /* the strip repolls anyway */ }

    return ok(`${shot.sid} now has a ${role} reference: ` +
              `${cut(path.split("/").pop(), 40)}`, {
      shot: shot.sid,
      reference: { image: cut(path, 70), role },
      means: ROLE_NOTE[role],
      ...(fetched ? { downloaded: true } : {}),
      references: short(rows),
      next: "generate_takes on this shot now sends the reference with the prompt",
    });
  },
};

// ------------------------------------------------------------ remove_reference

interface RemoveArgs { shot: string; image?: string; role?: string }

export const removeReference: ActionDef<RemoveArgs> = {
  name: "remove_reference",
  title: "Remove a reference",
  description:
    "Take a reference image off a shot, so later generations stop being " +
    "conditioned on it. Name the image (a path or file name), or a role " +
    "(character, prop, setting, style) to drop every reference in that role, " +
    "or pass image:\"all\" to clear them. The picture itself stays in the " +
    "project's takes — only the attachment goes.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      image: { type: "string", description: "Which reference to drop: a path or file name, a role name, or \"all\" for every one on the shot." },
      role: { type: "string", enum: ROLES, description: "Drop every reference in this role instead of naming a file." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "generate" }, anchor: ANCHORS.genRefRemove,
    label: "Shot Editor → Generate → References → ✕",
  },
  keywords: ["remove", "reference", "detach", "drop", "clear", "stop matching"],
  howTo: "Press ✕ on the reference's thumbnail in the Generate tab's References strip.",
  summarize: (a) => `Remove ${cut(a?.image || a?.role || "every", 20)} reference from ${cut(a?.shot, 20)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;
    const which = String(args?.image ?? args?.role ?? "").trim();
    if (!which) {
      return err("needs_target", {
        hint: "Name the image, a role (character, prop, setting, style), or \"all\".",
      });
    }
    const before = await readRefs(ctx, pid, shot.sid);
    if (!before.length) {
      return ok(`${shot.sid} has no references`, { shot: shot.sid, references: [] });
    }

    const opened = await openShotPage(ctx, "remove_reference", pid, shot.sid,
      { tab: "generate" });
    if (!opened.ok) return opened.res;
    const page = opened.page;
    page.setTab("generate");

    let rows: ShotReference[];
    try { rows = await page.removeReference(which); }
    catch (e) { return asError(e, "reference_rejected", "The server refused the change"); }
    await ctx.trail.step({
      tool: "remove_reference", title: `Remove ${cut(which, 30)}`,
      anchor: ANCHORS.genRefRemove, detail: which,
    });
    try { await page.refresh(); } catch { /* fine */ }

    const gone = before.length - rows.length;
    if (!gone) {
      return err("reference_not_found", {
        references: short(before),
        hint: `Nothing on ${shot.sid} matches “${cut(which, 30)}”. Pass a file name, a role, or "all".`,
      });
    }
    return ok(`${shot.sid} dropped ${gone} reference${gone === 1 ? "" : "s"}`, {
      shot: shot.sid,
      removed: gone,
      references: short(rows),
      hint: "The images are still in the takes rail — only the attachment went.",
    });
  },
};

// ------------------------------------------------------------- list_references

interface ListArgs { shot: string }

export const listReferences: ActionDef<ListArgs> = {
  name: "list_references",
  title: "List the shot's references",
  description:
    "Read the reference images attached to a shot and what each one is for, " +
    "without changing anything. Use it before generating to see whether a " +
    "face, a prop or a room is already pinned to a picture, and before " +
    "attaching a fourth (four is the limit).",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "generate" }, anchor: ANCHORS.genRefs,
    label: "Shot Editor → Generate → References",
  },
  keywords: ["references", "list", "attached", "what is pinned", "matching"],
  howTo: "The Generate tab's References strip shows them, each with a role badge.",
  summarize: (a) => `List the references on ${cut(a?.shot, 26)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;
    const rows = await readRefs(ctx, pid, shot.sid);
    if (!rows.length) {
      return ok(`${shot.sid} has no references`, {
        shot: shot.sid, references: [],
        hint: "attach_reference pins a face, a prop or a room to a picture.",
      });
    }
    return ok(`${shot.sid} has ${rows.length} reference${rows.length === 1 ? "" : "s"}: ` +
              rows.map((r) => r.role).join(", "), {
      shot: shot.sid,
      references: short(rows),
      slots_left: Math.max(0, 4 - rows.length),
    });
  },
};
