import "./_env";
import { describe, expect, it } from "vitest";
import type { ActionDef } from "../contract";
import { filterActions, fuzzyScore, isArgless } from "../Palette";
import { normalizeInput } from "../webmcp";

const def = (name: string, title: string, over: Partial<ActionDef<any>> = {}): ActionDef<any> => ({
  name, title,
  description: `Do ${title.toLowerCase()} in Cutroom.`,
  inputSchema: { type: "object", properties: {}, required: [] },
  where: { route: "/", label: "Somewhere" },
  howTo: "Click it.",
  execute: async () => ({ ok: true, summary: "ok" }),
  ...over,
});

const CATALOGUE = [
  def("freeze_tail", "Freeze the tail", { keywords: ["hold", "held cel", "first second"] }),
  def("cut_film", "Cut the film", { keywords: ["animatic", "render", "assemble"] }),
  def("generate_takes", "Generate takes", {
    keywords: ["still", "restyle", "animate"],
    inputSchema: { type: "object", properties: { shot: { type: "string" } }, required: ["shot"] },
  }),
  def("get_jobs", "Job status"),
  def("secret_thing", "Hidden", { surfaces: { palette: false } }),
];

describe("fuzzyScore", () => {
  it("ranks exact over prefix over substring over subsequence", () => {
    expect(fuzzyScore("cut the film", "Cut the film"))
      .toBeGreaterThan(fuzzyScore("cut", "Cut the film"));
    expect(fuzzyScore("cut", "Cut the film"))
      .toBeGreaterThan(fuzzyScore("film", "Cut the film"));
    expect(fuzzyScore("film", "Cut the film"))
      .toBeGreaterThan(fuzzyScore("ctf", "Cut the film"));
  });
  it("returns 0 when the letters are not there in order", () => {
    expect(fuzzyScore("zzz", "Cut the film")).toBe(0);
  });
  it("an empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
  });
});

describe("filterActions", () => {
  it("lists everything palette-visible when the query is empty", () => {
    const rows = filterActions(CATALOGUE, "");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.def.name)).not.toContain("secret_thing");
  });

  it("finds by title", () => {
    expect(filterActions(CATALOGUE, "freeze")[0].def.name).toBe("freeze_tail");
  });

  it("finds by tool name", () => {
    expect(filterActions(CATALOGUE, "cut_film")[0].def.name).toBe("cut_film");
  });

  it("finds by keyword the title never mentions", () => {
    expect(filterActions(CATALOGUE, "animatic")[0].def.name).toBe("cut_film");
    expect(filterActions(CATALOGUE, "held cel")[0].def.name).toBe("freeze_tail");
  });

  it("drops non-matches", () => {
    expect(filterActions(CATALOGUE, "qqqq")).toHaveLength(0);
  });

  it("floats recents when nothing distinguishes the rows", () => {
    const rows = filterActions(CATALOGUE, "", ["get_jobs"]);
    expect(rows[0].def.name).toBe("get_jobs");
  });
});

describe("isArgless", () => {
  it("is true when nothing is required", () => {
    expect(isArgless(CATALOGUE[0])).toBe(true);
  });
  it("is false when the human must supply something", () => {
    expect(isArgless(CATALOGUE[2])).toBe(false);
  });
});

describe("normalizeInput (Chrome hands execute a JSON string)", () => {
  it("parses a JSON string", () => {
    expect(normalizeInput('{"shot":"B10-S2","count":3}')).toEqual({ shot: "B10-S2", count: 3 });
  });
  it("passes an object through", () => {
    expect(normalizeInput({ shot: "B10-S2" })).toEqual({ shot: "B10-S2" });
  });
  it("treats null/empty as no arguments", () => {
    expect(normalizeInput(null)).toEqual({});
    expect(normalizeInput("")).toEqual({});
    expect(normalizeInput("   ")).toEqual({});
  });
  it("does not throw on malformed JSON", () => {
    expect(normalizeInput("{not json")).toEqual({ value: "{not json" });
  });
});
