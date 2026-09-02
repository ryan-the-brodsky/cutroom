/**
 * The image model registry, agent side: the still lane's twin of the motion
 * registry in `plan.ts`.
 *
 * A director asked for two monitors showing the word GOODBYE in perfectly
 * legible letters and the agent used the default model, because nothing told
 * it that legibility is a place these models differ. This module is what
 * tells it: the live list from `GET /api/image-models` with measured prices,
 * plus the detector that notices a prompt is asking for letters someone has
 * to read.
 *
 * Owned by workstream U. See docs/BACKENDS.md "Image models".
 */
import type { ActionContext } from "../contract";

export type ImageRegister = "legible_text" | "typography"
  | "complex_composition" | "cheap_default";

/** One record from `GET /api/image-models`. */
export interface ImageModel {
  id: string;
  key: string;
  label: string;
  rank: number;
  note?: string;
  cost_per_still_usd?: number;
  seconds_typical?: number;
  strengths?: string[];
  limits?: string[];
  failure_modes?: string;
  fallback?: string;
  registers?: ImageRegister[];
  enabled?: boolean;
}

/**
 * Mirrors the server registry so the tools still read sensibly offline. The
 * live list from `GET /api/image-models` always wins. Prices are measured
 * (docs/research/image-models/RESULTS.md, 2026-09-02).
 */
export const FALLBACK_IMAGE_REGISTRY: ImageModel[] = [
  { id: "google/gemini-2.5-flash-image", key: "flash",
    label: "Gemini 2.5 Flash Image (Nano Banana)", rank: 1,
    note: "the cheap default", cost_per_still_usd: 0.0387,
    failure_modes: "drops a letter when the frame carries several strings",
    fallback: "pro", registers: ["cheap_default"] },
  { id: "google/gemini-3-pro-image", key: "pro",
    label: "Gemini 3 Pro Image (Nano Banana Pro)", rank: 2,
    note: "the one to use when the text has to be readable",
    cost_per_still_usd: 0.1387,
    failure_modes: "bakes letterbox bars into the frame; takes a minute",
    fallback: "flash3",
    registers: ["legible_text", "typography", "complex_composition"] },
  { id: "google/gemini-3.1-flash-image", key: "flash3",
    label: "Gemini 3.1 Flash Image (Nano Banana 2)", rank: 3,
    note: "middle rung: spells like pro at half the price",
    cost_per_still_usd: 0.0672,
    failure_modes: "repeated lines ghost into each other",
    fallback: "pro", registers: ["typography", "complex_composition"] },
];

/** The sentence every still tool carries. */
export const TEXT_DOCTRINE =
  "Text that must be readable (signs, screens, titles) needs the text-capable " +
  "model: pass model:\"pro\". The default is the cheap model; it misspells the " +
  "moment a frame carries more than one string.";

export async function imageModels(ctx: ActionContext): Promise<ImageModel[]> {
  try {
    const r = await ctx.api<{ models: ImageModel[] }>("/api/image-models");
    const rows = (r?.models || []).filter((m) => m.enabled !== false);
    return rows.length ? rows.slice().sort((a, b) => a.rank - b.rank)
      : FALLBACK_IMAGE_REGISTRY;
  } catch { return FALLBACK_IMAGE_REGISTRY; }
}

export function findImageModel(models: ImageModel[], ref?: string | null) {
  if (!ref) return null;
  return models.find((m) => m.key === ref || m.id === ref) ?? null;
}

/** The model to reach for when the letters have to be readable. */
export function textModel(models: ImageModel[]): ImageModel | null {
  return models.find((m) => m.registers?.includes("legible_text")) ?? null;
}

/** Dollars for one still on this model. */
export function stillCost(m: ImageModel | null | undefined): number {
  return m?.cost_per_still_usd ?? 0;
}

/**
 * Words that mean the frame has letters a viewer must read. Prefixes, not
 * whole words, so "monitors", "captions" and "lettering" all count.
 */
const TEXT_RE =
  /\b(text|word|letter|lettering|sign|signage|title|caption|subtitle|headline|label|banner|logo|typograph|spell|readable|legible|screen text|handwrit|written|writing|poster|newspaper|graffiti)/i;

export function wantsText(...prompts: (string | null | undefined)[]): boolean {
  return prompts.some((p) => !!p && TEXT_RE.test(String(p)));
}

/**
 * The line a still result carries when the shot asked for readable text and
 * the cheap model drew it. Undefined when the model already handles text, or
 * when the registry has no text model to point at.
 */
export function textHint(
  models: ImageModel[], ref?: string | null,
): string | undefined {
  const used = findImageModel(models, ref) ?? models.find((m) => m.rank === 1) ?? null;
  if (used?.registers?.includes("legible_text")) return undefined;
  const pro = textModel(models);
  if (!pro) return undefined;
  return `This shot asks for readable text: consider model:"${pro.key}" ` +
    `(≈$${stillCost(pro).toFixed(2)} per still).`;
}

/** The registry as a tool result lists it: key, price, what it wins. */
export function imageModelRows(models: ImageModel[]) {
  return models.map((m) => ({
    key: m.key,
    usd: stillCost(m),
    good_at: (m.registers || []).join("/"),
    note: m.note,
    fallback: m.fallback,
  }));
}
