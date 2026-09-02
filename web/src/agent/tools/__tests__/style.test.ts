/**
 * The style register (workstream P): set_style, the guidance the script tools
 * carry, and the budgets every string in this catalogue has to fit.
 *
 * The regression under all of it: an agent that has never seen this pipeline
 * writes "hand-painted 2D satire" into a shot prompt because nothing told it
 * not to. The copy here is the part of the fix an LLM actually reads.
 */
import { APP_BASE } from "../../../routes";
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS, BUDGETS, TOOL_NAMES } from "../../contract";
import { createProject, writeScript } from "../project";
import { describeShot, getContext } from "../find";
import { STYLE_PRESETS, setStyle } from "../style";
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

describe("set_style", () => {
  it("is in the catalogue, under a name and anchor the registry knows", () => {
    expect(TOOL_NAMES).toContain("set_style");
    expect(TOOLS_BY_NAME.set_style).toBeTruthy();
    expect(TOOLS_BY_NAME.set_style.where).toMatchObject({
      anchor: ANCHORS.filmStyle,
    });
    expect(ANCHORS.filmStyle).toBe("film.style");
  });

  it("sets a named preset on the open film and says what the look is now", async () => {
    const r = asOk(await setStyle.execute({ preset: "anime-noir" }, f.ctx));
    expect(f.rec.nav.at(-1)).toBe(`${APP_BASE}/p/next-year/film`);
    expect(r.project).toBe("next-year");
    expect(r.style).toMatchObject({ name: "anime-noir" });
    expect(r.summary).toContain("anime-noir");
    expect(f.rec.anchors()).toContain(ANCHORS.filmStyle);
    expect(String(r.next)).toContain("no style words");
  });

  it("takes a custom prefix and calls the look custom", async () => {
    const r = asOk(await setStyle.execute(
      { prefix: "Cinematic anime film still, 1970s rotoscope, heavy grain." },
      f.ctx));
    expect(r.style).toMatchObject({ name: "custom" });
  });

  it("sends only the fields it was given, so a patch stays a patch", async () => {
    const seen: unknown[] = [];
    const g = makeFakeContext({
      api: (path, body) => {
        if (/\/style$/.test(path)) { seen.push(body); return { style: { name: "anime-cel" } }; }
        return {};
      },
    });
    await setStyle.execute({ avoid: "text, blur" }, g.ctx);
    expect(seen[0]).toEqual({ avoid: "text, blur" });
    g.restore();
  });

  it("turns reference conditioning off with an empty refs array", async () => {
    const seen: unknown[] = [];
    const g = makeFakeContext({
      api: (path, body) => {
        if (/\/style$/.test(path)) { seen.push(body); return { style: { name: "anime-cel", refs: [] } }; }
        return {};
      },
    });
    const r = asOk(await setStyle.execute({ refs: [] }, g.ctx));
    expect(seen[0]).toEqual({ refs: [] });
    expect((r.style as { refs: number }).refs).toBe(0);
    g.restore();
  });

  it("names the presets when asked for one that does not exist", async () => {
    const r = asErr(await setStyle.execute({ preset: "vaporwave" }, f.ctx));
    expect(r.error).toBe("unknown_preset");
    for (const p of STYLE_PRESETS) expect(r.hint).toContain(p);
  });

  it("refuses an empty call rather than writing nothing", async () => {
    expect(asErr(await setStyle.execute({}, f.ctx)).error).toBe("nothing_to_set");
  });

  it("says which film it needs when none is open", async () => {
    const g = makeFakeContext({ project: null });
    expect(asErr(await setStyle.execute({ preset: "anime-cel" }, g.ctx)).error)
      .toBe("no_project");
    g.restore();
  });

  it("relays a server refusal instead of claiming the look changed", async () => {
    const g = makeFakeContext({
      api: (path) => {
        if (/\/style$/.test(path)) {
          throw Object.assign(new Error("403: viewers may not"), { status: 403 });
        }
        return {};
      },
    });
    expect(asErr(await setStyle.execute({ preset: "anime-cel" }, g.ctx)).error)
      .toBe("forbidden");
    g.restore();
  });
});

describe("the register reaches the agent's other tools", () => {
  it("create_project reports the look the new film was seeded with", async () => {
    const r = asOk(await createProject.execute({ title: "The Bread Riot" }, f.ctx));
    expect(r.style).toBe("anime-cel");
    expect(String(r.next)).toContain("no style words");
  });

  it("create_project passes a requested style through to the server", async () => {
    const g = makeFakeContext({
      api: (path) => (/\/style$/.test(path) ? { style: { name: "anime-noir" } } : {}),
    });
    const r = asOk(await createProject.execute(
      { title: "Night Film", style: "anime-noir" }, g.ctx));
    expect(g.rec.calls("createProject")[0]).toContain('"style":"anime-noir"');
    expect(r.style).toBe("anime-noir");
    g.restore();
  });

  it("describe_shot and get_context both name the film's look", async () => {
    const d = asOk(await describeShot.execute({ shot: "B10-S2" }, f.ctx));
    expect(d.style).toBe("anime-cel");
    const c = asOk(await getContext.execute({}, f.ctx));
    expect(c.style).toBe("anime-cel");
  });
});

describe("script guidance (what the LLM actually reads)", () => {
  it("write_script forbids style words and text in frame, by name", () => {
    const d = writeScript.description;
    expect(d).toMatch(/hand-painted/);
    expect(d).toMatch(/caricature/);
    expect(d).toMatch(/never ask for text in frame/i);
    expect(d).toMatch(/style register is applied/i);
  });

  it("write_script's image_prompt field no longer asks for a style tail", () => {
    const props = writeScript.inputSchema.properties as Record<string, {
      items?: { properties?: Record<string, { description?: string }> } }>;
    const shot = props.shots.items!.properties!;
    expect(shot.image_prompt.description).toMatch(/No style words/);
    expect(shot.image_prompt.description).not.toMatch(/cinematic anime film still/);
    expect(shot.negative.description).toMatch(/style register/);
  });

  it("create_project's description mentions the register it seeds", () => {
    expect(createProject.description).toMatch(/style register/);
  });
});

describe("budgets", () => {
  it("set_style fits every Chrome budget", () => {
    expect(setStyle.name.length).toBeLessThanOrEqual(BUDGETS.name);
    expect(setStyle.description.length).toBeLessThanOrEqual(BUDGETS.description);
    expect(setStyle.description.length).toBeGreaterThan(120);
    const props = setStyle.inputSchema.properties as
      Record<string, { description?: string }>;
    expect(Object.keys(props)).toEqual(
      ["preset", "prefix", "avoid", "refs", "project"]);
    for (const [k, v] of Object.entries(props)) {
      expect(typeof v.description, k).toBe("string");
      expect(v.description!.length, k).toBeLessThanOrEqual(BUDGETS.param);
      expect(v.description!.length, k).toBeGreaterThan(10);
    }
  });

  it("the tools whose copy changed are still inside their budgets", () => {
    for (const d of [writeScript, createProject, describeShot, getContext]) {
      expect(d.description.length, d.name).toBeLessThanOrEqual(BUDGETS.description);
      expect(d.description.length, d.name).toBeGreaterThan(120);
      const props = (d.inputSchema.properties || {}) as
        Record<string, { description?: string }>;
      for (const [k, v] of Object.entries(props)) {
        expect(v.description!.length, `${d.name}.${k}`)
          .toBeLessThanOrEqual(BUDGETS.param);
      }
    }
  });
});
