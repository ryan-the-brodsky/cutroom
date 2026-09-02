/**
 * Starting a film from nothing (workstream K): create_project, write_script,
 * set_project_cast, list_projects.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS } from "../../contract";
import {
  createProject, listProjects, setProjectCast, slugify, writeScript,
} from "../project";
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

/** An ApiError-shaped rejection, the way `web/src/api.ts` throws one. */
const httpError = (status: number, detail: string) =>
  Object.assign(new Error(detail), { status });

const SHOT = {
  act: 1,
  image_prompt: "A Paris street at dawn, grey stone and bread smoke. " +
    "Subject: a baker with flour on her sleeves, arms crossed. Framed as a " +
    "wide static tableau. cinematic anime film still",
  seconds: 6,
  radio: "The bread ran out on a Tuesday.",
};

beforeEach(() => { f = makeFakeContext(); });

// ---------------------------------------------------------------- create_project

describe("create_project", () => {
  it("types the slug on the Projects page, creates, then opens the film", async () => {
    const r = asOk(await createProject.execute(
      { title: "The Bread Riot" }, f.ctx));
    expect(f.rec.nav).toEqual(["/", "/p/the-bread-riot"]);
    expect(f.rec.calls("createProject")[0]).toContain("createProject(the-bread-riot");
    expect(r.project).toBe("the-bread-riot");
    expect(r.url).toBe("/p/the-bread-riot");
    expect(f.rec.anchors()).toContain(ANCHORS.projectsCreate);
    expect(r.next).toContain("write_script");
  });

  it("takes an explicit id and slugifies it, and carries fps", async () => {
    const r = asOk(await createProject.execute(
      { id: "Bread Riot!!", title: "The Bread Riot", fps: 24 }, f.ctx));
    expect(r.project).toBe("bread-riot");
    expect(r.fps).toBe(24);
  });

  it("reports the lane defaults the new project inherited", async () => {
    const g = makeFakeContext({
      api: (path) => (/\/lanes$/.test(path)
        ? { still: { backend: "openrouter-image", model: "gemini" },
            motion: { backend: null } }
        : { id: "x" }),
    });
    const r = asOk(await createProject.execute({ title: "Lanes" }, g.ctx));
    expect(r.lanes).toEqual({ still: "openrouter-image:gemini" });
    g.restore();
  });

  it("relays the demo cap verbatim on a 429, and never rejects", async () => {
    f.projectsPage.failCreate = httpError(429, "demo limit: 3 new projects per day per visitor.");
    const r = asErr(await createProject.execute({ title: "Fourth" }, f.ctx));
    expect(r.error).toBe("rate_limited");
    expect(r.hint).toContain("3 new projects per day");
  });

  it("relays a 403 as forbidden and a 409 as project_exists", async () => {
    f.projectsPage.failCreate = httpError(403, "reserved for the studio owner");
    expect(asErr(await createProject.execute({ title: "No" }, f.ctx)).error)
      .toBe("forbidden");
    f.projectsPage.failCreate = httpError(409, "project bread exists");
    const r = asErr(await createProject.execute({ title: "Bread" }, f.ctx));
    expect(r.error).toBe("project_exists");
    expect(r.hint).toContain("another id");
  });

  it("asks for a title instead of creating a nameless film", async () => {
    expect(asErr(await createProject.execute({ title: "  " }, f.ctx)).error)
      .toBe("needs_title");
  });

  it("still writes when the Projects page never mounts", async () => {
    const g = makeFakeContext({ failWaitFor: true });
    const r = asOk(await createProject.execute({ title: "Headless" }, g.ctx));
    expect(g.rec.api.some((c) => c.path === "/api/projects")).toBe(true);
    expect(r.project).toBe("headless");
    g.restore();
  });
});

// ---------------------------------------------------------------- write_script

describe("write_script", () => {
  it("opens the film, posts one batch, then shows the first Script tab", async () => {
    const r = asOk(await writeScript.execute(
      { shots: [SHOT, { ...SHOT, image_prompt: "Second shot. cinematic anime film still" }] },
      f.ctx));
    const batch = f.rec.api.find((c) => c.path.endsWith("/shots/batch"))!;
    expect(batch, "one POST for the whole script").toBeTruthy();
    expect(f.rec.api.filter((c) => c.path.endsWith("/shots/batch")).length).toBe(1);
    expect((batch.body as { shots: unknown[] }).shots.length).toBe(2);
    expect(f.rec.nav[0]).toBe("/p/next-year");
    expect(f.rec.nav[f.rec.nav.length - 1]).toBe("/p/next-year/shot/B01-S1?tab=script");
    expect(f.rec.anchors()).toContain(ANCHORS.filmShot);
    expect(f.rec.anchors()).toContain(ANCHORS.scriptPanel);
    expect(r.count).toBe(2);
    expect(r.sids).toEqual(["B01-S1", "B01-S2"]);
    expect(r.total_seconds).toBe(12);
    expect(r.next).toContain("generate_takes");
  });

  it("refreshes the strip and the shot index so later tools see the new shots", async () => {
    await writeScript.execute({ shots: [SHOT] }, f.ctx);
    expect(f.rec.calls()).toContain("refresh()");
  });

  it("passes every script field through and drops the empties", async () => {
    await writeScript.execute({ shots: [{
      ...SHOT, sid: "B02-S1", beat: "B02", act: 2, type: "HERO", seconds: 9,
      register: "R2", negative: "text, watermark", motion_prompt: "the wig trembles",
      sfx: "a distant crowd", ambient: "street noise", cut: "hard",
      render_notes: "no visible faces", dialogue: [{ character: "MARGOT", line: "Bread first." }],
    }] }, f.ctx);
    const body = f.rec.api.find((c) => c.path.endsWith("/shots/batch"))!.body as
      { shots: Record<string, unknown>[] };
    expect(body.shots[0]).toMatchObject({
      sid: "B02-S1", beat: "B02", act: 2, type: "HERO", seconds: 9,
      register: "R2", cut: "hard", render_notes: "no visible faces",
    });
    expect(body.shots[0].dialogue).toEqual([{ character: "MARGOT", line: "Bread first." }]);
  });

  it("normalizes \"NAME: line\" dialogue an LLM writes as strings", async () => {
    await writeScript.execute(
      { shots: [{ ...SHOT, dialogue: ["MARGOT: Bread first.", "  "] as never }] }, f.ctx);
    const body = f.rec.api.find((c) => c.path.endsWith("/shots/batch"))!.body as
      { shots: Record<string, unknown>[] };
    expect(body.shots[0].dialogue).toEqual([{ character: "MARGOT", line: "Bread first." }]);
  });

  it("sends replace only when asked", async () => {
    await writeScript.execute({ shots: [SHOT] }, f.ctx);
    expect((f.rec.api.at(-1)?.body as Record<string, unknown>)?.replace).toBeUndefined();
    const g = makeFakeContext();
    await writeScript.execute({ shots: [SHOT], replace: true }, g.ctx);
    const body = g.rec.api.find((c) => c.path.endsWith("/shots/batch"))!.body;
    expect((body as Record<string, unknown>).replace).toBe(true);
    g.restore();
  });

  it("writes into an explicitly named project", async () => {
    await writeScript.execute({ project: "The Bread Riot", shots: [SHOT] }, f.ctx);
    expect(f.rec.api.some((c) => c.path === "/api/projects/the-bread-riot/shots/batch"))
      .toBe(true);
  });

  it.each([
    [{ shots: [] }, "needs_shots"],
    [{ shots: Array.from({ length: 41 }, () => SHOT) }, "too_many_shots"],
    [{ shots: [{ seconds: 5 }] }, "needs_image_prompt"],
  ])("refuses %#: bad input becomes an envelope with a hint", async (args, error) => {
    const r = asErr(await writeScript.execute(args as never, f.ctx));
    expect(r.error).toBe(error);
    expect(r.hint).toBeTruthy();
    expect(f.rec.api.some((c) => c.path.endsWith("/shots/batch"))).toBe(false);
  });

  it("asks for a project when none is open", async () => {
    const g = makeFakeContext({ project: null });
    const r = asErr(await writeScript.execute({ shots: [SHOT] }, g.ctx));
    expect(r.error).toBe("no_project");
    expect(r.hint).toContain("create_project");
    g.restore();
  });

  it("relays the server's own words when the batch is refused", async () => {
    const g = makeFakeContext({
      api: (path) => {
        if (path.endsWith("/shots/batch")) throw httpError(400, "the script runs past 300s at B01-S9");
        return {};
      },
    });
    const r = asErr(await writeScript.execute({ shots: [SHOT] }, g.ctx));
    expect(r.error).toBe("rejected");
    expect(r.hint).toContain("past 300s");
    g.restore();
  });
});

// ---------------------------------------------------------------- set_project_cast

describe("set_project_cast", () => {
  it("posts name — descriptor rows and reports the derived aliases", async () => {
    const r = asOk(await setProjectCast.execute({ characters: [
      { name: "Margot", descriptor: "the baker who starts it", aliases: ["the baker"] },
      { name: "Robespierre", descriptor: "the lawyer with the list" },
    ] }, f.ctx));
    const body = f.rec.api.find((c) => c.path.endsWith("/cast"))!.body as
      { characters: { character: string; aliases?: string[] }[] };
    expect(body.characters[0].character).toBe("Margot — the baker who starts it");
    expect(body.characters[0].aliases).toEqual(["the baker"]);
    expect(body.characters[1].character).toBe("Robespierre — the lawyer with the list");
    const cast = r.cast as { name: string }[];
    expect(cast.map((c) => c.name)).toEqual(["Margot", "Robespierre"]);
  });

  it("needs at least one named character", async () => {
    expect(asErr(await setProjectCast.execute({ characters: [] }, f.ctx)).error)
      .toBe("needs_characters");
    expect(asErr(await setProjectCast.execute(
      { characters: [{ name: "", descriptor: "" }] }, f.ctx)).error)
      .toBe("needs_characters");
  });

  it("relays a refusal rather than throwing", async () => {
    const g = makeFakeContext({ api: () => { throw httpError(403, "owner only"); } });
    const r = asErr(await setProjectCast.execute(
      { characters: [{ name: "M", descriptor: "the baker" }] }, g.ctx));
    expect(r.error).toBe("forbidden");
    expect(r.hint).toContain("owner only");
    g.restore();
  });
});

// ---------------------------------------------------------------- list_projects

describe("list_projects", () => {
  it("reads the films without navigating", async () => {
    const r = asOk(await listProjects.execute({}, f.ctx));
    expect(f.rec.nav).toEqual([]);
    expect(r.open).toBe("next-year");
    expect(r.projects).toEqual([
      { id: "next-year", title: "Next Year", shots: 2, url: "/p/next-year" },
    ]);
  });

  it("points at create_project when the instance is empty", async () => {
    const g = makeFakeContext({ api: { "/api/projects": [] } });
    const r = asOk(await listProjects.execute({}, g.ctx));
    expect(r.summary).toContain("no films");
    expect(r.hint).toContain("create_project");
    g.restore();
  });
});

// ---------------------------------------------------------------- slugify

describe("slugify", () => {
  it.each([
    ["The Bread Riot", "the-bread-riot"],
    ["Marie's Cake!", "maries-cake"],
    ["  spaced  out  ", "spaced-out"],
    ["", ""],
  ])("%s → %s", (raw, want) => { expect(slugify(raw)).toBe(want); });
});
