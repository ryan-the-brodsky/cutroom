/**
 * Reference images (workstream S): attach_reference, remove_reference,
 * list_references, and the one-off `references` argument on generate_takes.
 *
 * The ask underneath: "if I want to revise an image using a reference image,
 * can the agent do that?" Before this, no — restyle could edit a frame, but
 * nothing could say "this is the room" and have the picture reach the model.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS, BUDGETS, TOOL_NAMES, TOOL_NAME_RE } from "../../contract";
import { attachReference, listReferences, removeReference } from "../references";
import { describeShot } from "../find";
import { generateTakes } from "../generate";
import { TOOLS_BY_NAME } from "../index";
import { makeFakeContext } from "../fakeContext";

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

beforeEach(() => { f = makeFakeContext(); });

// ------------------------------------------------------------------ catalogue

describe("the catalogue", () => {
  it("carries the three tools under names and anchors the registry knows", () => {
    for (const name of ["attach_reference", "remove_reference", "list_references"]) {
      expect(TOOL_NAMES).toContain(name);
      expect(TOOLS_BY_NAME[name], name).toBeTruthy();
      expect(name).toMatch(TOOL_NAME_RE);
    }
    expect(ANCHORS.genRefs).toBe("shot.gen.refs");
    expect(ANCHORS.genRef).toBe("shot.gen.ref");
    expect(TOOLS_BY_NAME.attach_reference.where).toMatchObject({
      anchor: ANCHORS.genRefs,
    });
  });

  it("keeps every string inside the Chrome budgets", () => {
    for (const d of [attachReference, removeReference, listReferences]) {
      expect(d.description.length, d.name).toBeLessThanOrEqual(BUDGETS.description);
      for (const [k, p] of Object.entries(d.inputSchema.properties || {})) {
        expect(p.description?.length ?? 0, `${d.name}.${k}`)
          .toBeLessThanOrEqual(BUDGETS.param);
      }
    }
    expect(generateTakes.description.length).toBeLessThanOrEqual(BUDGETS.description);
    expect(generateTakes.inputSchema.properties?.references?.description?.length ?? 0)
      .toBeLessThanOrEqual(BUDGETS.param);
  });

  it("says in generate_takes when to reach for a reference instead of a restyle", () => {
    expect(generateTakes.description).toContain("attach_reference");
    expect(generateTakes.description).toContain("restyle edits a frame");
  });

  it("marks list_references read-only and the other two consequential", () => {
    expect(listReferences.annotations?.readOnlyHint).toBe(true);
    expect(attachReference.annotations?.consequentialHint).toBe(true);
    expect(removeReference.annotations?.consequentialHint).toBe(true);
  });
});

// ------------------------------------------------------------ attach_reference

describe("attach_reference", () => {
  it("attaches a take by path and says what the role means", async () => {
    const r = asOk(await attachReference.execute(
      { shot: "B10-S2", image: "renders/B10-S2/stills/keeper.png", role: "setting" },
      f.ctx));
    expect(r.reference).toMatchObject({ role: "setting" });
    expect(String(r.means)).toContain("architecture");
    expect(f.rec.calls("addReference")[0])
      .toBe("addReference(renders/B10-S2/stills/keeper.png,setting)");
    expect(f.rec.anchors()).toContain(ANCHORS.genRef);
    // it lands on the Generate tab, where the strip lives
    expect(f.rec.nav.at(-1)).toContain("tab=generate");
    expect(f.rec.calls("setTab")).toContain("setTab(generate)");
  });

  it("takes the words a director uses, on this shot or another", async () => {
    asOk(await attachReference.execute(
      { shot: "B10-S2", image: "keeper", role: "character" }, f.ctx));
    expect(f.rec.calls("addReference")[0]).toContain("stills/keeper.png");

    const g = makeFakeContext();
    asOk(await attachReference.execute(
      { shot: "B10-S2", image: "the keeper of B11-S4", role: "setting" }, g.ctx));
    // resolved against B11-S4's takes, attached to B10-S2
    expect(g.rec.calls("addReference")[0]).toContain("renders/B11-S4/stills/k.png");
    g.restore();
  });

  it("defaults the role to character rather than refusing an unknown word", async () => {
    const r = asOk(await attachReference.execute(
      { shot: "B10-S2", image: "keeper", role: "her outfit" }, f.ctx));
    expect(r.reference).toMatchObject({ role: "character" });
  });

  it("reads a director's word for a role", async () => {
    const r = asOk(await attachReference.execute(
      { shot: "B10-S2", image: "keeper", role: "the location" }, f.ctx));
    expect(r.reference).toMatchObject({ role: "setting" });
  });

  it("downloads an http url through the server rather than trusting the link", async () => {
    const r = asOk(await attachReference.execute(
      { shot: "B10-S2", image: "https://example.com/dorm.png", role: "setting" },
      f.ctx));
    expect(r.downloaded).toBe(true);
    expect(f.rec.api.some((c) => /\/refs\/fetch$/.test(c.path))).toBe(true);
    expect(String(r.reference && (r.reference as { image: string }).image))
      .toContain("refs/");
  });

  it("reports a link the server refuses, without pretending it worked", async () => {
    const r = asErr(await attachReference.execute(
      { shot: "B10-S2", image: "https://example.com/page.html" }, f.ctx));
    expect(r.error).toBe("fetch_failed");
    expect(r.hint).toContain("not an image");
  });

  it("refuses a clip: a reference is a picture", async () => {
    const r = asErr(await attachReference.execute(
      { shot: "B10-S2", image: "renders/B10-S2/motion/a.mp4" }, f.ctx));
    expect(r.error).toBe("reference_must_be_a_still");
    expect(r.hint).toContain("freeze");
  });

  it("asks for the picture instead of guessing when nothing matches", async () => {
    expect(asErr(await attachReference.execute(
      { shot: "B10-S2", image: "" }, f.ctx)).error).toBe("needs_image");
    expect(asErr(await attachReference.execute(
      { shot: "B10-S2", image: "the blue one" }, f.ctx)).error).toBe("image_not_found");
  });

  it("passes the server's four-reference limit through as its own error", async () => {
    for (const p of ["a.png", "b.png", "c.png", "d.png"]) {
      await attachReference.execute({ shot: "B10-S2", image: `renders/${p}` }, f.ctx);
    }
    const r = asErr(await attachReference.execute(
      { shot: "B10-S2", image: "renders/e.png" }, f.ctx));
    expect(r.error).toBe("too_many_references");
    expect(r.hint).toContain("at most 4");
  });

  it("never guesses through an ambiguous shot", async () => {
    const r = asErr(await attachReference.execute(
      { shot: "shot 37 with Ross in it", image: "keeper" }, f.ctx));
    expect(r.error).toBe("ambiguous_shot");
    expect(f.rec.calls("addReference")).toHaveLength(0);
  });
});

// ------------------------------------------------------- list and remove

describe("list_references and remove_reference", () => {
  it("lists what is attached, with roles and the slots left", async () => {
    await attachReference.execute(
      { shot: "B10-S2", image: "renders/room.png", role: "setting" }, f.ctx);
    await attachReference.execute(
      { shot: "B10-S2", image: "renders/mug.png", role: "prop" }, f.ctx);
    const r = asOk(await listReferences.execute({ shot: "B10-S2" }, f.ctx));
    expect(r.summary).toContain("setting, prop");
    expect(r.slots_left).toBe(2);
    expect(r.references).toEqual([
      { image: "room.png", role: "setting" },
      { image: "mug.png", role: "prop" },
    ]);
  });

  it("says plainly when a shot has none", async () => {
    const r = asOk(await listReferences.execute({ shot: "B11-S4" }, f.ctx));
    expect(r.references).toEqual([]);
    expect(String(r.hint)).toContain("attach_reference");
  });

  it("removes by file name, by role, and all at once", async () => {
    const attach = (image: string, role: string) =>
      attachReference.execute({ shot: "B10-S2", image, role }, f.ctx);
    await attach("renders/room.png", "setting");
    await attach("renders/mug.png", "prop");
    await attach("renders/her.png", "character");

    let r = asOk(await removeReference.execute(
      { shot: "B10-S2", image: "mug.png" }, f.ctx));
    expect(r.removed).toBe(1);
    r = asOk(await removeReference.execute({ shot: "B10-S2", role: "setting" }, f.ctx));
    expect(r.references).toEqual([{ image: "her.png", role: "character" }]);
    r = asOk(await removeReference.execute({ shot: "B10-S2", image: "all" }, f.ctx));
    expect(r.references).toEqual([]);
    expect(f.rec.anchors()).toContain(ANCHORS.genRefRemove);
  });

  it("says nothing matched rather than reporting a removal that did not happen", async () => {
    await attachReference.execute(
      { shot: "B10-S2", image: "renders/room.png", role: "setting" }, f.ctx);
    const r = asErr(await removeReference.execute(
      { shot: "B10-S2", image: "nope.png" }, f.ctx));
    expect(r.error).toBe("reference_not_found");
  });

  it("is a no-op, not an error, on a shot with nothing attached", async () => {
    const r = asOk(await removeReference.execute(
      { shot: "B11-S4", image: "all" }, f.ctx));
    expect(r.references).toEqual([]);
  });

  it("needs to be told what to drop", async () => {
    expect(asErr(await removeReference.execute({ shot: "B10-S2" }, f.ctx)).error)
      .toBe("needs_target");
  });
});

// -------------------------------------------------------------- describe_shot

describe("describe_shot", () => {
  it("lists the references with their roles", async () => {
    await attachReference.execute(
      { shot: "B10-S2", image: "renders/room.png", role: "setting" }, f.ctx);
    const r = asOk(await describeShot.execute({ shot: "B10-S2" }, f.ctx));
    expect(r.references).toEqual(["setting: room.png"]);
  });

  it("says nothing about references when a shot has none", async () => {
    const r = asOk(await describeShot.execute({ shot: "B11-S4" }, f.ctx));
    expect(r.references).toBeUndefined();
  });
});

// ------------------------------------------------------- generate_takes

describe("generate_takes references", () => {
  it("resolves one-off references and fills them into the console", async () => {
    const r = asOk(await generateTakes.execute({
      shot: "B10-S2", count: 1,
      references: [{ image: "keeper", role: "setting" },
                   { image: "renders/mug.png", role: "prop" }],
    }, f.ctx));
    const filled = f.rec.calls("setGenField(still,references");
    expect(filled).toHaveLength(1);
    expect(filled[0]).toContain("\"role\":\"setting\"");
    expect(filled[0]).toContain("renders/mug.png");
    expect(r.references).toEqual([
      "setting: keeper.png", "prop: mug.png",
    ]);
    // the strip is the anchor the trail pulses for them
    expect(f.rec.anchors()).toContain(ANCHORS.genRefs);
  });

  it("drops a reference it cannot find and still generates", async () => {
    const r = asOk(await generateTakes.execute({
      shot: "B10-S2", count: 1,
      references: [{ image: "the blue one", role: "prop" }],
    }, f.ctx));
    expect(r.references_not_found).toEqual(["the blue one"]);
    expect(f.rec.calls("setGenField(still,references")).toHaveLength(0);
    expect(r.jobs).toHaveLength(1);
  });

  it("does not send references on the animate lane, which cannot use them", async () => {
    await generateTakes.execute({
      shot: "B10-S2", lane: "animate", count: 1,
      references: [{ image: "keeper", role: "setting" }],
    }, f.ctx);
    expect(f.rec.calls("setGenField(animate,references")).toHaveLength(0);
  });

  it("sends no references at all when the call carries none", async () => {
    const r = asOk(await generateTakes.execute({ shot: "B10-S2", count: 1 }, f.ctx));
    expect(r.references).toBeUndefined();
    expect(f.rec.calls("setGenField(still,references")).toHaveLength(0);
  });
});
