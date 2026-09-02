/**
 * The image model registry, agent side (workstream U).
 *
 * The ask underneath: a director wanted two monitors reading GOODBYE in
 * legible letters and the agent used the default model, because nothing in
 * the tool surface said image models differ on whether text comes out
 * readable, or which one to pass.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BUDGETS } from "../../contract";
import {
  FALLBACK_IMAGE_REGISTRY, findImageModel, imageModelRows, imageModels,
  stillCost, textHint, textModel, wantsText,
} from "../images";
import { describeShot } from "../find";
import { generateTakes } from "../generate";
import { listBackends } from "../settings";
import { makeFakeContext } from "../fakeContext";

type Fake = ReturnType<typeof makeFakeContext>;
let f: Fake;

const asOk = (r: { ok: boolean } & Record<string, unknown>) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as { ok: true; summary: string } & Record<string, unknown>;
};

beforeEach(() => { f = makeFakeContext(); });

// ------------------------------------------------------------------ registry

describe("the registry", () => {
  it("reads the live list and falls back to the mirror offline", async () => {
    const live = await imageModels(f.ctx);
    expect(live.map((m) => m.key)).toEqual(["flash", "pro"]);
    expect(stillCost(findImageModel(live, "pro"))).toBe(0.1387);
    // a full OpenRouter id resolves to the same record as its key
    expect(findImageModel(live, "google/gemini-3-pro-image")?.key).toBe("pro");

    const offline = makeFakeContext({ api: () => { throw new Error("no server"); } });
    expect(await imageModels(offline.ctx)).toEqual(FALLBACK_IMAGE_REGISTRY);
    offline.restore();
  });

  it("names the text model, and the cheap default is not it", async () => {
    const models = await imageModels(f.ctx);
    expect(textModel(models)?.key).toBe("pro");
    expect(findImageModel(models, "flash")?.registers).not.toContain("legible_text");
    // and pro costs real money, which is why it is not the default
    expect(stillCost(findImageModel(models, "pro")))
      .toBeGreaterThan(stillCost(findImageModel(models, "flash")) * 3);
  });

  it("carries a price and a fallback on every row it reports", () => {
    for (const row of imageModelRows(FALLBACK_IMAGE_REGISTRY)) {
      expect(row.usd).toBeGreaterThan(0);
      expect(row.fallback).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------- text detector

describe("wantsText", () => {
  it("fires on the words a director uses for letters someone must read", () => {
    for (const p of [
      "two monitors show the word GOODBYE, perfectly legible",
      "a hand-painted sign over the door",
      "the title card reads FIN",
      "a newspaper on the table, headline visible",
      "closed captions burned into the frame",
      "graffiti on the shutter",
    ]) expect(wantsText(p), p).toBe(true);
  });

  it("stays quiet on a shot with no letters in it", () => {
    for (const p of [
      "Subject: David Ross in the dugout, close on the eyes, anime cel",
      "the cemetery at dusk, wide and empty",
      "rain on a window, night",
      null, undefined, "",
    ]) expect(wantsText(p), String(p)).toBe(false);
  });

  it("checks the shot's own prompt as well as the typed one", () => {
    expect(wantsText(null, "a departures board full of text")).toBe(true);
  });
});

describe("textHint", () => {
  it("names the model, the argument spelling and the price", () => {
    const hint = textHint(FALLBACK_IMAGE_REGISTRY, "flash");
    expect(hint).toContain('model:"pro"');
    expect(hint).toContain("$0.14");
    expect(hint).toMatch(/^This shot asks for readable text/);
  });

  it("says nothing when the model already spells, or when none does", () => {
    expect(textHint(FALLBACK_IMAGE_REGISTRY, "pro")).toBeUndefined();
    expect(textHint(FALLBACK_IMAGE_REGISTRY, "google/gemini-3-pro-image"))
      .toBeUndefined();
    const noText = FALLBACK_IMAGE_REGISTRY.filter((m) => m.key === "flash");
    expect(textHint(noText, "flash")).toBeUndefined();
  });

  it("assumes the rank-1 default when no model was named", () => {
    expect(textHint(FALLBACK_IMAGE_REGISTRY)).toContain('model:"pro"');
  });
});

// ------------------------------------------------------------- tool surface

describe("the tool surface", () => {
  it("keeps generate_takes inside the Chrome budgets while saying it", () => {
    expect(generateTakes.description.length)
      .toBeLessThanOrEqual(BUDGETS.description);
    expect(generateTakes.description).toContain('model:"pro"');
    expect(generateTakes.description).toMatch(/readable/i);
    const model = generateTakes.inputSchema.properties?.model;
    expect(model?.description?.length ?? 0).toBeLessThanOrEqual(BUDGETS.param);
    expect(model?.description).toContain('"pro"');
    expect(model?.description).toContain('"flash"');
  });

  it("hints at the text model when a still prompt asks for letters", async () => {
    const r = asOk(await generateTakes.execute(
      { shot: "B11-S4", count: 1,
        prompt: "two monitors, the word GOODBYE in legible letters" },
      f.ctx) as never);
    expect(String(r.hint)).toContain('model:"pro"');
  });

  it("does not hint when the agent already picked the text model", async () => {
    const r = asOk(await generateTakes.execute(
      { shot: "B11-S4", count: 1, model: "pro",
        prompt: "two monitors, the word GOODBYE in legible letters" },
      f.ctx) as never);
    expect(String(r.hint ?? "")).not.toContain('model:"pro"');
  });

  it("does not hint on a shot with no text in it", async () => {
    const r = asOk(await generateTakes.execute(
      { shot: "B11-S4", count: 1, prompt: "the cemetery at dusk, wide" },
      f.ctx) as never);
    expect(String(r.hint ?? "")).not.toContain("readable text");
  });

  it("does not hint on the animate lane, a still-lane property", async () => {
    const r = asOk(await generateTakes.execute(
      { shot: "B10-S2", lane: "animate", count: 1,
        prompt: "the screen text flickers" }, f.ctx) as never);
    expect(String(r.hint ?? "")).not.toContain("readable text");
  });

  it("lists the registry with prices in describe_shot", async () => {
    const r = asOk(await describeShot.execute({ shot: "B11-S4" }, f.ctx) as never);
    const rows = r.image_models as { key: string; usd: number }[];
    expect(rows.map((m) => m.key)).toEqual(["flash", "pro"]);
    expect(rows.find((m) => m.key === "pro")?.usd).toBe(0.1387);
  });

  it("lists the registry with prices in list_backends", async () => {
    const withImage = makeFakeContext({
      api: (path) => (path === "/api/backends"
        ? [{ id: "openrouter-image", type: "openrouter-image",
             label: "OpenRouter image", enabled: true, lanes: ["still", "i2i"],
             api_key_set: true, options: { cost_usd: 0.04 } }]
        : undefined) as never,
    });
    const r = asOk(await listBackends.execute({}, withImage.ctx) as never);
    const rows = r.image_models as { key: string; usd: number }[];
    // this fake serves no /api/image-models, so the offline mirror answers
    expect(rows.map((m) => m.key))
      .toEqual(FALLBACK_IMAGE_REGISTRY.map((m) => m.key));
    expect(rows.find((m) => m.key === "pro")?.usd).toBe(0.1387);
    expect(String(r.hint)).toContain('model:"pro"');
    withImage.restore();
  });
});
