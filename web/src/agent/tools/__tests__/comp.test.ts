/**
 * The cel workbench tools (workstream I) against the fake context: what they
 * navigate to, which page handles they call, and the envelopes they return.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS } from "../../contract";
import {
  addCelLayer, listLayers, removeLayer, renderComp, rerollLayer,
  restyleBackground, setBackground, setLayer, snapRegion,
} from "../comp";
import { FIXTURE_COMPS, PAID_BACKEND, makeFakeContext } from "../fakeContext";

type Fake = ReturnType<typeof makeFakeContext>;
let f: Fake;

const asOk = (r: { ok: boolean } & Record<string, unknown>) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as { ok: true; summary: string } & Record<string, unknown>;
};
const asErr = (r: { ok: boolean } & Record<string, unknown>) => {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  return r as { ok: false; error: string; hint?: string };
};

/** The fixture comps are module state, so reset them between tests. */
const resetComps = () => {
  FIXTURE_COMPS["B10-S2"] = [{
    cid: "B10-S2-1", shot: "B10-S2",
    background: "renders/B10-S2/stills/keeper.png",
    background_kind: "still", width: 960, height: 544, duration: 4,
    background_history: [],
    layers: [{ id: "L1", clip: "renders/B10-S2/motion/cel-L1.webm",
               region: [320, 96, 640, 352], prompt: "only the eyes blink",
               z: 1, opacity: 1, matte: "window",
               variants: [{ clip: "a.webm" }, { clip: "b.webm" }] }],
  }];
  FIXTURE_COMPS["B11-S4"] = [];
};

beforeEach(() => { resetComps(); f = makeFakeContext(); });

// ---------------------------------------------------------------- regions

describe("snapRegion", () => {
  it("grows a box to /32 on both axes and stays on the plate", () => {
    const [l, t, r, b] = snapRegion([100, 100, 200, 205], 960, 544);
    expect((r - l) % 32).toBe(0);
    expect((b - t) % 32).toBe(0);
    expect(l).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(960);
    expect(b).toBeLessThanOrEqual(544);
  });

  it("reads 0-1 as fractions of the TRUE plate, not of 1080p", () => {
    expect(snapRegion([0, 0, 1, 1], 960, 544)).toEqual([0, 0, 960, 544]);
    const half = snapRegion([0.5, 0.5, 1, 1], 960, 544);
    expect(half[0]).toBeGreaterThan(400);
    expect(half[2]).toBe(960);
  });

  it("orders a backwards box instead of producing a negative region", () => {
    const [l, t, r, b] = snapRegion([400, 300, 100, 100], 960, 544);
    expect(r).toBeGreaterThan(l);
    expect(b).toBeGreaterThan(t);
  });
});

// ---------------------------------------------------------------- add_cel_layer

describe("add_cel_layer", () => {
  it("opens the workbench, draws the region, fills the prompt and submits", async () => {
    const r = asOk(await addCelLayer.execute(
      { shot: "B10-S2", region: [320, 96, 640, 352], prompt: "only the hand turns the dial" },
      f.ctx));
    expect(f.rec.nav[0]).toBe("/p/next-year/shot/B10-S2?tab=compose&comp=B10-S2-1");
    expect(f.rec.calls()).toEqual(expect.arrayContaining([
      "setNewRegion(320,96,640,352)",
      "setNewPrompt(only the hand turns the dial)",
    ]));
    expect(f.rec.calls().some((c) => c.startsWith("submitLayer("))).toBe(true);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.compStage, ANCHORS.compNewPrompt, ANCHORS.compNewSubmit,
    ]));
    expect(r.layer).toBe("L2");
    expect(r.comp).toBe("B10-S2-1");
    expect((r.jobs as string[]).length).toBe(1);
  });

  it("defaults to 49 frames — the doctrine cel length", async () => {
    await addCelLayer.execute({ shot: "B10-S2", region: [0, 0, 64, 64], prompt: "a blink" }, f.ctx);
    const call = f.rec.calls().find((c) => c.startsWith("submitLayer("))!;
    expect(call).toContain('"frames":49');
    const explicit = makeFakeContext();
    await addCelLayer.execute(
      { shot: "B10-S2", region: [0, 0, 64, 64], prompt: "a blink", frames: 97 }, explicit.ctx);
    expect(explicit.rec.calls().find((c) => c.startsWith("submitLayer("))!).toContain('"frames":97');
    explicit.restore();
  });

  it("stages a comp from the keeper when the shot has none", async () => {
    FIXTURE_COMPS["B10-S2"] = [];
    const r = asOk(await addCelLayer.execute(
      { shot: "B10-S2", region: [0.3, 0.2, 0.7, 0.8], prompt: "the flag ripples" }, f.ctx));
    expect(r.comp_created).toBe(true);
    expect(String(r.background)).toContain("keeper.png");
    expect(r.background_kind).toBe("still");
    const post = f.rec.api.find((c) => c.path.endsWith("/comps") && c.body);
    expect((post!.body as { background: string }).background).toContain("keeper.png");
  });

  it("can stage the new comp on a CLIP, for a moving background", async () => {
    FIXTURE_COMPS["B10-S2"] = [];
    const r = asOk(await addCelLayer.execute(
      { shot: "B10-S2", region: [0, 0, 320, 320], prompt: "the hand", background: "newest motion" },
      f.ctx));
    expect(r.background_kind).toBe("video");
    expect(String(r.background)).toMatch(/\.mp4$/);
  });

  it("snaps the region to /32 before it reaches the server", async () => {
    const r = asOk(await addCelLayer.execute(
      { shot: "B10-S2", region: [101, 99, 203, 207], prompt: "a blink" }, f.ctx));
    const [l, t, rr, b] = r.region as number[];
    expect((rr - l) % 32).toBe(0);
    expect((b - t) % 32).toBe(0);
  });

  it("refuses a paid motion backend without confirm_cost, before moving the view", async () => {
    const paid = makeFakeContext({ backend: PAID_BACKEND });
    const r = asErr(await addCelLayer.execute(
      { shot: "B10-S2", region: [0, 0, 64, 64], prompt: "a blink" }, paid.ctx));
    expect(r.error).toBe("needs_confirmation");
    expect(paid.rec.nav).toEqual([]);
    paid.restore();
  });

  it("asks for a prompt and a region rather than guessing", async () => {
    expect(asErr(await addCelLayer.execute(
      { shot: "B10-S2", region: [0, 0, 64, 64], prompt: "" }, f.ctx)).error).toBe("needs_prompt");
    expect(asErr(await addCelLayer.execute(
      { shot: "B10-S2", region: [0, 0] as never, prompt: "x" }, f.ctx)).error).toBe("needs_region");
  });
});

// ---------------------------------------------------------------- reroll_layer

describe("reroll_layer", () => {
  it("selects the newest layer and rerolls it with a fresh seed", async () => {
    const r = asOk(await rerollLayer.execute({ shot: "B10-S2" }, f.ctx));
    expect(r.layer).toBe("L1");
    expect(r.directed).toBe(false);
    expect(f.rec.calls()).toContain("selectLayer(L1)");
    expect(f.rec.calls()).toContain("rerollLayer(L1,{})");
    expect(f.rec.anchors()).toContain(ANCHORS.compLayerReroll);
  });

  it("passes prompt, seed, backend and model through as a directed reroll", async () => {
    const r = asOk(await rerollLayer.execute(
      { shot: "B10-S2", layer: "L1", prompt: "slower blink", seed: 7, backend: "mock" }, f.ctx));
    expect(r.directed).toBe(true);
    const call = f.rec.calls().find((c) => c.startsWith("rerollLayer("))!;
    expect(call).toContain('"prompt":"slower blink"');
    expect(call).toContain('"seed":7');
    expect(f.rec.anchors()).toContain(ANCHORS.compRerollSubmit);
  });

  it("names the layers that do exist when asked for one that does not", async () => {
    const r = asErr(await rerollLayer.execute({ shot: "B10-S2", layer: "L9" }, f.ctx));
    expect(r.error).toBe("layer_not_found");
    expect(r.hint).toContain("L1");
  });

  it("says there is no comp rather than staging one behind the director's back", async () => {
    const r = asErr(await rerollLayer.execute({ shot: "B11-S4" }, f.ctx));
    expect(r.error).toBe("no_comp");
  });
});

// ---------------------------------------------------------------- restyle_background

describe("restyle_background", () => {
  it("sets mode, prompt and strength, then submits", async () => {
    const r = asOk(await restyleBackground.execute(
      { shot: "B10-S2", prompt: "warmer, late dusk", strength: 0.7 }, f.ctx));
    expect(r.mode).toBe("edit");
    expect(r.strength).toBe(0.7);
    expect(f.rec.calls()).toEqual(expect.arrayContaining([
      'setBgField(mode,"edit")',
      'setBgField(prompt,"warmer, late dusk")',
      "setBgField(strength,0.7)",
      "submitBackground()",
    ]));
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.compBgMode, ANCHORS.compBgPrompt, ANCHORS.compBgSubmit,
    ]));
  });

  it("regen goes to the still lane and carries no strength", async () => {
    const r = asOk(await restyleBackground.execute(
      { shot: "B10-S2", prompt: "a wide empty dugout at dusk", mode: "regen" }, f.ctx));
    expect(r.lane).toBe("still");
    expect(r.strength).toBeUndefined();
  });

  it("refuses a clip background and says what to do instead", async () => {
    FIXTURE_COMPS["B10-S2"][0].background = "renders/B10-S2/motion/a.mp4";
    FIXTURE_COMPS["B10-S2"][0].background_kind = "video";
    const r = asErr(await restyleBackground.execute(
      { shot: "B10-S2", prompt: "warmer" }, f.ctx));
    expect(r.error).toBe("background_is_a_clip");
    expect(r.hint).toContain("set_background");
    expect(f.rec.nav).toEqual([]);
  });
});

// ---------------------------------------------------------------- set_background

describe("set_background", () => {
  it("points the comp at a clip and reports a moving background", async () => {
    const r = asOk(await setBackground.execute(
      { shot: "B10-S2", take: "newest motion" }, f.ctx));
    expect(r.background_kind).toBe("video");
    expect(f.rec.calls().some((c) => c.startsWith("setBackground("))).toBe(true);
    expect(f.rec.anchors()).toContain(ANCHORS.compBgPlate);
    expect(r.hint).toContain("restyle_background");
  });

  it("is a no-op when the comp already runs on that take", async () => {
    const r = asOk(await setBackground.execute(
      { shot: "B10-S2", take: "renders/B10-S2/stills/keeper.png" }, f.ctx));
    expect(r.changed).toBe(false);
    expect(f.rec.calls().some((c) => c.startsWith("setBackground("))).toBe(false);
  });
});

// ---------------------------------------------------------------- set_layer

describe("set_layer", () => {
  it("writes opacity, z and matte in ONE patch, so the comp re-renders once", async () => {
    const r = asOk(await setLayer.execute(
      { shot: "B10-S2", layer: "L1", opacity: 0.6, z: "front", matte: "figure" }, f.ctx));
    const patches = f.rec.calls().filter((c) => c.startsWith("patchLayer("));
    expect(patches.length).toBe(1);
    expect(patches[0]).toContain('"opacity":0.6');
    expect(patches[0]).toContain('"matte":"figure"');
    expect(patches[0]).toContain('"z":2');
    expect((r.applied as Record<string, unknown>).z).toBe(2);
    expect((r.before as Record<string, unknown>).opacity).toBe(1);
  });

  it('resolves z "back" below every existing layer', async () => {
    await setLayer.execute({ shot: "B10-S2", layer: "L1", z: "back" }, f.ctx);
    expect(f.rec.calls().find((c) => c.startsWith("patchLayer("))!).toContain('"z":-1');
  });

  it("snaps a region and clamps opacity", async () => {
    const r = asOk(await setLayer.execute(
      { shot: "B10-S2", layer: "L1", region: [100, 100, 201, 203], opacity: 5 }, f.ctx));
    const applied = r.applied as { region: number[]; opacity: number };
    expect((applied.region[2] - applied.region[0]) % 32).toBe(0);
    expect(applied.opacity).toBe(1);
  });

  it("says what it needs when nothing was passed", async () => {
    const r = asErr(await setLayer.execute({ shot: "B10-S2", layer: "L1" }, f.ctx));
    expect(r.error).toBe("nothing_to_set");
  });
});

// ---------------------------------------------------------------- remove_layer

describe("remove_layer", () => {
  it("removes the layer and reports what is left", async () => {
    const r = asOk(await removeLayer.execute({ shot: "B10-S2", layer: "L1" }, f.ctx));
    expect(r.removed).toBe("L1");
    expect(r.layers_left).toBe(0);
    expect(f.rec.calls()).toContain("removeLayer(L1)");
    expect(f.rec.anchors()).toContain(ANCHORS.compLayerRemove);
  });
});

// ---------------------------------------------------------------- render_comp

describe("render_comp", () => {
  it("renders and, with promote, makes the composite what the shot plays", async () => {
    const r = asOk(await renderComp.execute({ shot: "B10-S2", promote: true }, f.ctx));
    expect(f.rec.calls()).toContain("renderComp()");
    expect(f.rec.calls().some((c) => c.startsWith("promote("))).toBe(true);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.compRender, ANCHORS.compPromote,
    ]));
    expect(r.plays).toBeTruthy();
  });

  it("reports a failed render as a failure, with the engine's own message", async () => {
    const broken = makeFakeContext({
      settle: (ids) => ids.map((job) => ({
        job, status: "error",
        error: "the encoder exited mid-stream (BrokenPipeError) after 0 frame(s) at 1024x1024",
      })),
    });
    const r = asErr(await renderComp.execute({ shot: "B10-S2", promote: true }, broken.ctx));
    expect(r.error).toBe("render_failed");
    expect(r.hint).toContain("1024x1024");
    expect(broken.rec.calls().some((c) => c.startsWith("promote("))).toBe(false);
    broken.restore();
  });

  it("does not promote a render that has not finished", async () => {
    const slow = makeFakeContext({
      settle: (ids) => ids.map((job) => ({ job, status: "running" })),
    });
    const r = asOk(await renderComp.execute({ shot: "B10-S2", promote: true }, slow.ctx));
    expect(r.promoted).toBe(false);
    expect(slow.rec.calls().some((c) => c.startsWith("promote("))).toBe(false);
    expect(r.hint).toBe("call wait_for_jobs, then set_timeline_source with the rendered take");
    slow.restore();
  });
});

// ---------------------------------------------------------------- list_layers

describe("list_layers", () => {
  it("reads the comps without touching the view", async () => {
    const r = asOk(await listLayers.execute({ shot: "B10-S2" }, f.ctx));
    expect(f.rec.nav).toEqual([]);
    const comps = r.comps as { cid: string; background_kind: string; layers: { id: string }[] }[];
    expect(comps[0].cid).toBe("B10-S2-1");
    expect(comps[0].background_kind).toBe("still");
    expect(comps[0].layers[0].id).toBe("L1");
  });

  it("reports a clip background as video", async () => {
    FIXTURE_COMPS["B10-S2"][0].background = "renders/B10-S2/motion/a.mp4";
    delete FIXTURE_COMPS["B10-S2"][0].background_kind;
    const r = asOk(await listLayers.execute({ shot: "B10-S2" }, f.ctx));
    expect((r.comps as { background_kind: string }[])[0].background_kind).toBe("video");
  });

  it("points at add_cel_layer when a shot has no comps", async () => {
    const r = asOk(await listLayers.execute({ shot: "B11-S4" }, f.ctx));
    expect(r.comps).toEqual([]);
    expect(String(r.hint)).toContain("add_cel_layer");
  });
});
