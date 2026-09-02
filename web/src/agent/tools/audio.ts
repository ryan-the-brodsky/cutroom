/**
 * synthesize_vo — the Audio tab. ElevenLabs v3 tags pass through untouched.
 */
import type { ActionDef, ToolResult } from "../contract";
import { ANCHORS, err, ok, shotTabAnchor } from "../contract";
import { deps, type BackendChoice } from "./deps";
import {
  SHOT_ROUTE, asError, costGate, cut, fetchShot, lookupShot, openShotPage,
} from "./util";

/** What a line can be heard through. Mirrors `engine.audio.TREATMENT_NAMES`. */
const VO_TREATMENTS = ["none", "radio", "phone", "megaphone", "hall"];

interface VoArgs {
  shot: string;
  text?: string;
  voice?: string;
  treatment?: string;
  backend?: string;
  confirm_cost?: boolean;
}

export const synthesizeVo: ActionDef<VoArgs> = {
  name: "synthesize_vo",
  title: "Synthesize a voice-over",
  description:
    "Record a voice-over line for a shot. Opens the shot's Audio tab, fills the " +
    "line, voice and treatment, and presses ▶ synthesize. Defaults to the line the " +
    "script already gives the shot — its narration or first piece of dialogue — so " +
    "you usually only pass the shot. `treatment` is what the line is heard " +
    "through: none (default), radio, phone, megaphone or hall. ElevenLabs v3 tags " +
    "pass through. Paid voice backends require confirm_cost. Returns job and take.",
  inputSchema: {
    type: "object",
    properties: {
      shot: { type: "string", description: "The shot: a sid (B10-S2), its number in the cut, a beat, or a description." },
      text: { type: "string", description: "The line to speak. Omit to use the shot's own narration or first dialogue line as written." },
      voice: { type: "string", description: "Voice id on the VO backend. Omit for the project's default voice." },
      treatment: {
        type: "string", enum: VO_TREATMENTS,
        description: "What the line is heard through: none (default), radio, phone, megaphone or hall.",
      },
      backend: { type: "string", description: "Force a specific VO backend id instead of the project's lane default." },
      confirm_cost: { type: "boolean", description: "Set true to approve a paid voice backend. Required whenever the VO lane bills money." },
    },
    required: ["shot"],
    additionalProperties: false,
  },
  annotations: { consequentialHint: true },
  where: {
    route: SHOT_ROUTE, query: { tab: "audio" },
    anchor: ANCHORS.audioSubmit, label: "Shot Editor → Audio → ▶ synthesize",
  },
  keywords: ["vo", "voice", "voice over", "line", "narration", "dialogue", "speak", "tts", "audio", "treatment", "radio", "phone", "megaphone", "hall"],
  howTo:
    "Open the shot's Audio tab, check the line in the text box, pick a voice, pick " +
    "a treatment if the line is heard through something, then press ▶ synthesize.",
  summarize: (a) => `Synthesize VO for ${cut(a?.shot, 26)}`,
  async execute(args, ctx): Promise<ToolResult> {
    const treatment = String(args?.treatment ?? "none").toLowerCase();
    if (!VO_TREATMENTS.includes(treatment)) {
      return err("unknown_treatment", {
        treatment, known: VO_TREATMENTS,
        hint: `No voice treatment called "${treatment}". Pick one of ${VO_TREATMENTS.join(", ")}.`,
      });
    }

    const found = await lookupShot(ctx, args?.shot);
    if (!found.ok) return found.res;
    const { pid, shot } = found;

    // Cost guard before anything visible happens.
    let choice: BackendChoice;
    try { choice = await deps.classifyBackend(pid, "vo", args?.backend, ctx.api); }
    catch { choice = { backend: args?.backend || "mock", cost_class: "free" }; }
    const gate = costGate(choice, 1, "VO line", args?.confirm_cost === true);
    if (gate) return gate;
    const backendId = choice.backend || "the lane default";

    let detail;
    try { detail = await fetchShot(ctx, pid, shot.sid); }
    catch (e) { return asError(e, "shot_fetch_failed", "Could not read the shot"); }

    const scripted = detail.narration ?? detail.radio ?? detail.dialogue?.[0]?.line ?? "";
    const text = String(args?.text ?? "").trim() || scripted;
    if (!text) {
      return err("needs_text", {
        hint: `${shot.sid} has no scripted line — pass \`text\` with what should be said.`,
      });
    }

    const opened = await openShotPage(ctx, "synthesize_vo", pid, shot.sid, { tab: "audio" });
    if (!opened.ok) return opened.res;
    const page = opened.page;

    page.setTab("audio");
    await ctx.trail.step({
      tool: "synthesize_vo", title: "Open the Audio tab", anchor: shotTabAnchor("audio"),
    });

    if (args?.backend) page.setVoField("backend", args.backend);
    if (args?.voice) {
      page.setVoField("voice", args.voice);
      await ctx.trail.step({
        tool: "synthesize_vo", title: `Voice ${cut(args.voice, 30)}`, anchor: ANCHORS.audioVoice,
      });
    }
    page.setVoField("text", text);
    await ctx.trail.step({
      tool: "synthesize_vo", title: "Fill the line", anchor: ANCHORS.audioText,
      detail: cut(text, 120),
    });
    if (treatment !== "none") {
      page.setVoField("treatment", treatment);
      await ctx.trail.step({
        tool: "synthesize_vo", title: `Treatment ${treatment}`,
        anchor: ANCHORS.audioTreatment,
      });
    }

    let job: string;
    try { ({ job } = await page.submitVo()); }
    catch (e) { return asError(e, "vo_failed", "The voice backend refused the line"); }
    await ctx.trail.step({
      tool: "synthesize_vo", title: "▶ synthesize", anchor: ANCHORS.audioSubmit, job,
    });

    let settled: Awaited<ReturnType<typeof deps.settleJobs>> = [];
    try { settled = await deps.settleJobs([job], { settleMs: 8000, signal: ctx.signal, api: ctx.api }); }
    catch { /* queued regardless */ }
    const s0 = settled[0];
    const take = s0?.takes?.[0]?.path ?? null;
    try { await page.refresh(); } catch { /* fine */ }

    if (s0?.status === "error" || s0?.status === "failed") {
      return err("vo_failed", {
        shot: shot.sid, job, jobs: [job], backend: backendId,
        hint: cut(s0.error, 160) || "The voice job failed — open Jobs for the log.",
      });
    }

    return ok(
      take ? `VO for ${shot.sid} is ready — ${cut(take.split("/").pop(), 40)}`
        : `VO queued for ${shot.sid}`,
      {
        shot: shot.sid,
        job,
        jobs: [job],
        backend: backendId,
        cost_class: choice.cost_class,
        text: cut(text, 140),
        treatment,
        status: s0?.status ?? "queued",
        take: take ? cut(take, 64) : null,
        ...(s0?.error ? { error_detail: cut(s0.error, 90) } : {}),
        ...(take
          ? { hint: "Use set_shot_timing vo_offset to slide it against the picture." }
          : { hint: "Still rendering — call wait_for_jobs with this job id." }),
      },
    );
  },
};
