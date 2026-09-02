/**
 * generate_takes — the hero tool. Drives the Shot Editor's Generate console on
 * screen and submits one job per take with a distinct seed.
 */
import type { ActionDef, GenSub, ToolResult } from "../contract";
import { ANCHORS, err, genFieldAnchor, genSubAnchor, ok } from "../contract";
import { deps, type BackendChoice } from "./deps";
import {
  clampSeconds, framesForSeconds, motionModels, motionProfile, unfaithfulHint,
  type MotionModel, type MotionProfile,
} from "./plan";
import { imageModels, textHint, wantsText, type ImageModel } from "./images";
import { resolveRefImage, roleOf } from "./references";
import {
  SHOT_ROUTE, asError, costGate, cut, fetchShot, freshSeeds, lookupShot, maybeNum,
  normalizeCount, openShotPage, pickTake, plateOf, safeState,
} from "./util";

export type Lane = "still" | "restyle" | "animate";

interface GenArgs {
  shot: string;
  lane?: Lane;
  count?: number | string;
  prompt?: string;
  prompt_mode?: "replace" | "append";
  source_take?: string;
  denoise?: number;
  region?: number[];
  frames?: number;
  seconds?: number;
  live_seconds?: number;
  freeze_after?: number;
  seeds?: number[] | string;
  backend?: string;
  model?: string;
  confirm_cost?: boolean;
  references?: { image: string; role?: string }[];
}

/** lane → (generate sub-tab, server lane id, noun). */
const LANES: Record<Lane, { sub: GenSub; apiLane: string; noun: string }> = {
  still: { sub: "still", apiLane: "still", noun: "still" },
  restyle: { sub: "restyle", apiLane: "i2i", noun: "restyle" },
  animate: { sub: "animate", apiLane: "motion", noun: "clip" },
};

/**
 * Doctrine (2026-09-02, §3.7 addendum): a clip PLAYS IN FULL. Its length is the
 * motion backend's own profile default (~2 s local, 5 s on fal's Wan turbo),
 * not a constant here. Nothing freezes unless the caller asks: `live_seconds`
 * is the explicit opt-in, for a clip that is good for N seconds and then
 * drifts. True freezes only, no zoom.
 */
const RESTYLE_DENOISE = 0.85;


/** A shot with no motion prompt still animates: small, continuous, locked-camera motion
 *  drawn from the plate's own subject clause. Freeze/chain remain repair tools. */
export function deriveMotionPrompt(imagePrompt?: string | null): string {
  const ip = String(imagePrompt ?? "").trim();
  if (!ip) return "";
  const m = ip.match(/Subject:\s*([^.]{10,160})/i);
  const subject = (m ? m[1] : ip.split(".")[0]).trim().slice(0, 160);
  return `Continuous, clearly visible motion for the whole clip, true to the plate: ${subject}. Locked camera; the subject keeps moving the entire time; nothing freezes.`;
}

export const generateTakes: ActionDef<GenArgs> = {
  name: "generate_takes",
  title: "Generate takes",
  description:
    "Generate new takes for a shot — stills, restyles of an existing take, or " +
    "animated cel clips. Opens the Generate console, fills it, and submits one " +
    "job per take with a fresh seed. Count 1–4 (default 3); the prompt defaults " +
    "to the shot's own; clips play in full; paid backends need confirm_cost. " +
    "Text that must be readable (signs, screens, titles) needs model:\"pro\"; " +
    "the cheap default misspells past one string. attach_reference pins a face " +
    "or place to an image; restyle edits a frame.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description like \"the Ross close-up\"." },
      lane: { type: "string", enum: ["still", "restyle", "animate"], description: "still = new image · restyle = image-to-image on an existing take · animate = motion clip. Default still." },
      count: { type: "integer", minimum: 1, maximum: 4, default: 3, description: "How many takes to submit, 1–4. Words like \"a few\" (3) or \"a couple\" (2) are accepted too." },
      prompt: { type: "string", description: "Prompt text. Omit to use the shot's written image or motion prompt exactly as the director wrote it." },
      prompt_mode: { type: "string", enum: ["replace", "append"], description: "replace = use only your prompt (default) · append = add yours to the shot's own prompt." },
      source_take: { type: "string", description: "For restyle: the take to restyle. A path, or \"latest\", \"newest still\", \"keeper\". Defaults to the selected take." },
      denoise: { type: "number", description: "Restyle strength, 0.35–0.95. 0.55 keeps the layout, 0.85 restyles. Default 0.85." },
      region: { type: "array", items: { type: "number" }, description: "For animate: the cel region as [left, top, right, bottom]. Omit to animate the full frame." },
      seconds: { type: "number", description: "For animate: clip length in seconds. Defaults to the backend's own clip length and is clamped to what it supports." },
      frames: { type: "integer", description: "For animate: exact frame count, when you need one. Normally leave it and pass seconds instead." },
      live_seconds: { type: "number", description: "For animate: freeze after this many seconds. Only for a model that drifts after N seconds — clips play in full otherwise." },
      seeds: { type: "array", items: { type: "integer" }, description: "Exact seeds to use, one per take. Omit for fresh random seeds (the usual case)." },
      backend: { type: "string", description: "Force a specific backend id instead of the project's lane default (e.g. \"mock\", \"comfyui\", \"fal\")." },
      model: { type: "string", description: "Force a model. Stills: \"pro\" for readable text, \"flash\" (cheap default). Motion: \"seedance\", \"wan\". A full endpoint id works too." },
      confirm_cost: { type: "boolean", description: "Set true to approve a paid backend. Required whenever the lane resolves to a backend that bills money." },
      references: { type: "array", items: { type: "object" }, description: "One-off reference images for this call only: [{image, role}], role character/prop/setting/style. attach_reference makes one stick." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: (a) => {
    const sub = LANES[(a?.lane as Lane) || "still"]?.sub ?? "still";
    return {
      route: SHOT_ROUTE,
      query: { tab: "generate", sub },
      anchor: genFieldAnchor(sub, "submit"),
      label: `Shot Editor → Generate → ${sub}`,
    };
  },
  keywords: ["generate", "render", "takes", "cuts", "variations", "still", "restyle",
             "i2i", "animate", "motion", "more", "another"],
  howTo:
    "Open the shot, press the Generate tab and its still / restyle / animate sub-tab, " +
    "type a prompt (or keep the shot's own), then press ▶ once per take — each press " +
    "queues a job with a new seed.",
  summarize: (a) =>
    `Generate ${normalizeCount(a?.count)} ${LANES[(a?.lane as Lane) || "still"]?.noun ?? "take"}s for ${cut(a?.shot, 24)}`,
  async execute(args, ctx): Promise<ToolResult> {
    // ---- 1. resolve the shot (never guess through an ambiguity)
    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    const lane: Lane = (["still", "restyle", "animate"] as Lane[])
      .includes(args?.lane as Lane) ? (args!.lane as Lane) : "still";
    const { sub, apiLane, noun } = LANES[lane];
    const count = normalizeCount(args?.count, 3, 4);

    // ---- 2. cost guard, BEFORE anything visible happens
    let choice: BackendChoice;
    try { choice = await deps.classifyBackend(pid, apiLane, args?.backend, ctx.api); }
    catch { choice = { backend: args?.backend || "mock", cost_class: "free" }; }
    const gate = costGate(choice, count, noun, args?.confirm_cost === true);
    if (gate) return gate;
    const backendId = choice.backend || "the lane default";
    // The live window is a backend property, so read it before filling frames.
    let profile: MotionProfile = {};
    let models: MotionModel[] = [];
    let seconds = 0;
    if (lane === "animate") {
      profile = await motionProfile(ctx, choice.backend);
      if (choice.type === "fal" || choice.backend === "fal") {
        models = await motionModels(ctx);
      }
    }

    // ---- 3. read the shot so the prompt builds on what the director wrote
    let detail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const base = lane === "animate" ? (detail.motion_prompt || deriveMotionPrompt(detail.image_prompt))
      : lane === "restyle" ? (args?.prompt ? "" : detail.image_prompt || "")
        : (detail.image_prompt || "");
    const typed = String(args?.prompt ?? "").trim();
    const prompt = !typed ? base
      : args?.prompt_mode === "append" && base ? `${base}, ${typed}`
        : typed;
    if (!prompt) {
      return err("needs_prompt", {
        hint: lane === "animate"
          ? "This shot has no motion prompt — pass `prompt` naming only what moves."
          : "This shot has no written prompt — pass `prompt`.",
      });
    }

    // ---- 4. lane preconditions (cheap failures before we move the view)
    let source: string | null = null;
    if (lane === "restyle") {
      const hit = await pickTake(ctx, pid, detail, args?.source_take, { prefer: "image" });
      if (!hit) {
        return err("needs_source_take", {
          hint: "Restyle needs a source image — select a take, set a keeper, or pass source_take.",
        });
      }
      source = hit.path;
    }
    if (lane === "animate" && !plateOf(detail)) {
      return err("needs_plate", {
        hint: "Animate needs an approved plate — set a keeper still on this shot first (set_keeper).",
      });
    }

    // ---- 4a. legibility is a model property. A shot whose prompt asks for
    // letters someone has to read, drawn on the cheap model, gets told which
    // model spells, once, in the result, with the price attached.
    let stillHint: string | undefined;
    if (lane !== "animate" && wantsText(prompt, detail.image_prompt)) {
      const imgModels: ImageModel[] = await imageModels(ctx);
      stillHint = textHint(imgModels, args?.model);
    }

    // ---- 4b. one-off references, resolved before the view moves. A reference
    // that cannot be found is dropped, never fatal: the shot still generates.
    const oneOff: { image: string; role: string }[] = [];
    const missedRefs: string[] = [];
    if (lane !== "animate" && Array.isArray(args?.references)) {
      for (const row of args!.references!.slice(0, 4)) {
        const want = String(row?.image ?? "").trim();
        if (!want) continue;
        const role = roleOf(row?.role);
        try {
          const hit = await resolveRefImage(ctx, pid, shot.sid, want, role);
          if (hit) oneOff.push({ image: hit.path, role });
          else missedRefs.push(cut(want, 40));
        } catch { missedRefs.push(cut(want, 40)); }
      }
    }

    // ---- 5. drive the UI
    // `take` goes in the URL too: the restyle submit reads the page's selected
    // take, and the query param is applied before the page hands back handles.
    const opened = await openShotPage(ctx, "generate_takes", pid, shot.sid,
      { tab: "generate", sub, ...(source ? { take: source } : {}) });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    page.setTab("generate");
    page.setSub(sub);
    await ctx.trail.step({
      tool: "generate_takes",
      title: `Open Generate → ${sub}`,
      anchor: genSubAnchor(sub),
    });

    if (args?.backend || args?.model) {
      if (args.backend) page.setGenField(sub, "backend", args.backend);
      if (args.model) page.setGenField(sub, "model", args.model);
      await ctx.trail.step({
        tool: "generate_takes",
        title: `Backend ${args.backend || backendId}${args.model ? ` · ${args.model}` : ""}`,
        anchor: ANCHORS.genModel,
      });
    }

    page.setGenField(sub, "prompt", prompt);
    await ctx.trail.step({
      tool: "generate_takes",
      title: args?.prompt_mode === "append" && typed ? "Append to the shot's prompt" : "Fill the prompt",
      anchor: genFieldAnchor(sub, "prompt"),
      detail: cut(prompt, 140),
    });

    if (oneOff.length) {
      page.setGenField(sub, "references", oneOff);
      await ctx.trail.step({
        tool: "generate_takes",
        title: `${oneOff.length} reference${oneOff.length === 1 ? "" : "s"} — ` +
          oneOff.map((r) => r.role).join(", "),
        anchor: ANCHORS.genRefs,
      });
    }

    if (lane === "restyle" && source) {
      page.selectTake(source);
      const denoise = maybeNum(args?.denoise) ?? RESTYLE_DENOISE;
      page.setGenField(sub, "denoise", denoise);
      await ctx.trail.step({
        tool: "generate_takes",
        title: `Restyle ${cut(source.split("/").pop(), 28)} at denoise ${denoise}`,
        anchor: genFieldAnchor(sub, "denoise"),
      });
    }

    if (lane === "animate") {
      const region = Array.isArray(args?.region) && args!.region!.length === 4
        ? args!.region! : null;
      page.setGenField(sub, "fullFrame", !region);
      if (region) page.setGenField(sub, "region", region);
      // Clamp against the model that will actually run, not the backend's default:
      // Seedance makes 12 s clips while the fal default (Wan) stops at 5.
      const wantKey = String(args?.model ?? "").trim().toLowerCase();
      const pickedModel = wantKey
        ? models.find((m) => m.key === wantKey || m.id.toLowerCase() === wantKey)
        : undefined;
      const effProfile = pickedModel && pickedModel.seconds_max
        ? { ...profile, seconds_max: pickedModel.seconds_max, seconds_options: undefined }
        : profile;
      seconds = clampSeconds(effProfile, maybeNum(args?.seconds)
        ?? profile.seconds_default ?? 2);
      const typedFrames = maybeNum(args?.frames);
      const frames = typedFrames ?? framesForSeconds(profile, seconds);
      // Freeze ONLY on request: a repair for a clip that drifts, never a default.
      const live = maybeNum(args?.live_seconds) ?? maybeNum(args?.freeze_after);
      // Seconds travel to the server as seconds. Frames go only when the director typed
      // them: a frame count computed here against one model's grid and read back on
      // another's turned 5 s requests into 3 s clips.
      page.setGenField(sub, "seconds", seconds);
      page.setGenField(sub, "frames", typedFrames ?? "");
      page.setGenField(sub, "freeze_after", live ?? 0);
      await ctx.trail.step({
        tool: "generate_takes",
        title: `${region ? "Cel region" : "Full frame"} · ${seconds}s · ${frames}f` +
          (live ? ` · freeze after ${live}s` : ""),
        anchor: genFieldAnchor(sub, "frames"),
      });
    }

    // ---- 6. one submit per take, distinct seeds
    const seeds = freshSeeds(count, args?.seeds);
    const jobs: string[] = [];
    const failures: string[] = [];
    for (let i = 0; i < count; i++) {
      if (ctx.signal?.aborted) break;
      page.setGenField(sub, "seeds", String(seeds[i]));
      await ctx.trail.step({
        tool: "generate_takes",
        title: `Seed ${seeds[i]}`,
        anchor: genFieldAnchor(sub, "seeds"),
      });
      try {
        const res = await page.submitGenerate(sub);
        if (res?.job) jobs.push(res.job);
        await ctx.trail.step({
          tool: "generate_takes",
          title: `Submit ${noun} ${i + 1} of ${count}`,
          anchor: genFieldAnchor(sub, "submit"),
          job: res?.job,
        });
      } catch (e) {
        failures.push(cut((e as Error)?.message, 90));
      }
    }

    if (!jobs.length) {
      return err("submit_failed", {
        hint: failures[0] || "The Generate console rejected every submit — check the Jobs page.",
      });
    }

    // ---- 7. settle briefly so mock backends land inside the turn
    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try { settled = await deps.settleJobs(jobs, { settleMs: 8000, signal: ctx.signal, api: ctx.api }); }
    catch { /* the jobs are queued regardless */ }

    const takes = settled.flatMap((s) => s.takes || [])
      .slice(0, count).map((t) => ({ path: cut(t.path, 64), kind: t.kind }));
    const done = settled.filter((s) => s.status === "done").length;
    const failed = settled.filter((s) => s.status === "error" || s.status === "failed");
    const running = jobs.length - done - failed.length;

    try { await page.refresh(); } catch { /* the rail refreshes on its own too */ }

    const s = safeState(page);
    return ok(
      `Submitted ${jobs.length} ${noun}${jobs.length === 1 ? "" : "s"} for ${shot.sid} on ${backendId}` +
      (done ? ` — ${done} landed` : "") + (running > 0 ? `, ${running} still running` : ""),
      {
        shot: shot.sid,
        lane,
        jobs,
        backend: backendId,
        cost_class: choice.cost_class,
        ...(lane === "animate"
          ? { seconds, motion_profile: {
                seconds_default: profile.seconds_default,
                seconds_max: profile.seconds_max,
                fps: profile.fps,
                holds_seconds: profile.live_seconds_default,
              } }
          : {}),
        ...(lane === "animate" && unfaithfulHint(models, args?.model)
          ? { next_if_unfaithful: unfaithfulHint(models, args?.model) }
          : {}),
        seeds,
        takes,
        ...(oneOff.length
          ? { references: oneOff.map((r) => `${r.role}: ${cut(r.image.split("/").pop(), 32)}`) }
          : {}),
        ...(missedRefs.length ? { references_not_found: missedRefs } : {}),
        tab: `${s.tab} → ${s.sub}`,
        ...(failed.length ? { failed: failed.map((f) => cut(f.error, 80)) } : {}),
        ...(failures.length ? { submit_errors: failures.slice(0, 2) } : {}),
        ...((() => {
          const parts = [
            stillHint,
            running > 0
              ? `${running} job${running === 1 ? "" : "s"} still running — call wait_for_jobs with these ids.`
              : "",
          ].filter(Boolean);
          return parts.length ? { hint: parts.join(" ") } : {};
        })()),
      },
    );
  },
};
