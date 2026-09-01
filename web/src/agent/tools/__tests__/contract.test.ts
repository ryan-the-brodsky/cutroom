import { describe, expect, it } from "vitest";
import {
  ANCHORS, BUDGETS, TOOL_NAMES, TOOL_NAME_RE, clip, genFieldAnchor,
  genSubAnchor, shotTabAnchor,
  type GenSub, type JSONSchema, type ShotTab, type Where,
} from "../../contract";
import { TOOLS, TOOLS_BY_NAME, missingTools, registerAllTools } from "../index";
import { makeFakeContext } from "../fakeContext";

const TABS: ShotTab[] = ["compose", "generate", "motion", "audio", "script"];
const SUBS: GenSub[] = ["still", "restyle", "animate", "chain"];
const FIELDS = ["prompt", "negative", "seeds", "denoise", "frames", "steps", "cfg",
  "freeze_after", "fullFrame", "region", "backend", "model", "beats", "submit"] as const;

/** Every anchor the plan's §3.3 vocabulary can produce. */
const VALID_ANCHORS = new Set<string>([
  ...Object.values(ANCHORS),
  ...TABS.map(shotTabAnchor),
  ...SUBS.map(genSubAnchor),
  ...SUBS.flatMap((s) => FIELDS.map((f) => genFieldAnchor(s, f as never))),
]);

const whereOf = (d: (typeof TOOLS)[number], args: Record<string, unknown> = {}): Where =>
  (typeof d.where === "function" ? d.where(args) : d.where);

describe("tool catalogue", () => {
  it("covers every name in TOOL_NAMES, in order, with no extras", () => {
    expect(missingTools()).toEqual([]);
    expect(TOOLS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("registers all 19 tools through registerAllTools", () => {
    const seen: string[] = [];
    registerAllTools((d) => seen.push(d.name));
    expect(seen).toEqual([...TOOL_NAMES]);
    expect(seen.length).toBe(19);
  });

  it("has unique names that match the WebMCP name regex", () => {
    for (const d of TOOLS) {
      expect(d.name, d.name).toMatch(TOOL_NAME_RE);
      expect(d.name.length, d.name).toBeLessThanOrEqual(BUDGETS.name);
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });
});

describe("budgets (Chrome guidance)", () => {
  it.each(TOOLS.map((d) => [d.name, d] as const))(
    "%s: description ≤ 500 chars and verb-first", (_name, d) => {
      expect(d.description.length).toBeLessThanOrEqual(BUDGETS.description);
      expect(d.description.length).toBeGreaterThan(120);
      // House style: opens with a verb, not "This tool…" / "A tool that…".
      expect(d.description).not.toMatch(/^(This|A |An |The tool)/);
      expect(d.description[0]).toBe(d.description[0].toUpperCase());
    });

  it.each(TOOLS.map((d) => [d.name, d] as const))(
    "%s: every param description ≤ 150 chars", (_name, d) => {
      const props = (d.inputSchema.properties || {}) as Record<string, JSONSchema>;
      for (const [k, v] of Object.entries(props)) {
        expect(typeof v.description, `${d.name}.${k}`).toBe("string");
        expect(v.description!.length, `${d.name}.${k}`).toBeLessThanOrEqual(BUDGETS.param);
        expect(v.description!.length, `${d.name}.${k}`).toBeGreaterThan(10);
      }
    });

  it.each(TOOLS.map((d) => [d.name, d] as const))(
    "%s: inputSchema is an object schema with declared required fields", (_name, d) => {
      expect(d.inputSchema.type).toBe("object");
      const props = (d.inputSchema.properties || {}) as Record<string, JSONSchema>;
      for (const r of d.inputSchema.required || []) expect(props).toHaveProperty(r);
    });
});

describe("registry metadata", () => {
  it.each(TOOLS.map((d) => [d.name, d] as const))(
    "%s: has title, howTo, keywords and a resolvable where", (_name, d) => {
      expect(d.title.length).toBeGreaterThan(2);
      expect(d.howTo, `${d.name}.howTo`).toBeTruthy();
      expect(d.howTo!.length).toBeGreaterThan(30);
      expect((d.keywords || []).length).toBeGreaterThan(2);
      const w = whereOf(d);
      expect(w.route.startsWith("/")).toBe(true);
      expect(w.label.length).toBeGreaterThan(3);
      if (w.anchor) expect(VALID_ANCHORS.has(w.anchor), `${d.name}: ${w.anchor}`).toBe(true);
    });

  it("marks read-only tools readOnlyHint and mutating tools consequentialHint", () => {
    const readOnly = ["find_shots", "describe_shot", "get_context", "list_features",
      "direct_shot", "get_jobs", "wait_for_jobs"];
    const consequential = ["generate_takes", "freeze_tail", "trim_clip", "set_keeper",
      "set_timeline_source", "set_shot_timing", "synthesize_vo", "apply_plan", "cut_film"];
    for (const n of readOnly) {
      expect(TOOLS_BY_NAME[n].annotations?.readOnlyHint, n).toBe(true);
      expect(TOOLS_BY_NAME[n].annotations?.consequentialHint, n).toBeFalsy();
    }
    for (const n of consequential) {
      expect(TOOLS_BY_NAME[n].annotations?.consequentialHint, n).toBe(true);
      expect(TOOLS_BY_NAME[n].annotations?.readOnlyHint, n).toBeFalsy();
    }
  });

  it("summarize never throws, even on empty args", () => {
    for (const d of TOOLS) {
      if (!d.summarize) continue;
      expect(() => d.summarize!({} as never), d.name).not.toThrow();
      expect(typeof d.summarize!({} as never)).toBe("string");
    }
  });

  it("where() never throws for partial args", () => {
    for (const d of TOOLS) {
      expect(() => whereOf(d, { lane: "animate", tab: "audio", sub: "restyle" }), d.name).not.toThrow();
    }
  });
});

// Plausible args per tool, so every execute path can be size-checked.
const ARGS: Record<string, Record<string, unknown>> = {
  find_shots: { query: "David Ross close-up" },
  describe_shot: { shot: "B10-S2" },
  get_context: {},
  list_features: {},
  show_me: { feature: "freeze tail", shot: "B10-S2" },
  open_shot: { shot: "B10-S2", tab: "generate", sub: "still" },
  generate_takes: { shot: "B10-S2", lane: "still", count: 4 },
  freeze_tail: { shot: "B10-S2", live_seconds: 1 },
  trim_clip: { shot: "B10-S2", end_seconds: 1.5 },
  select_take: { shot: "B10-S2", take: "latest" },
  set_keeper: { shot: "B10-S2", take: "newest still", note: "eyes read" },
  set_timeline_source: { shot: "B10-S2", take: "newest motion" },
  set_shot_timing: { shot: "B10-S2", seconds: 4.5, vo_offset: 0.2, mute_vo: false },
  synthesize_vo: { shot: "B11-S4" },
  direct_shot: { shot: "B10-S2", instruction: "keep the first second and hold the pose" },
  apply_plan: { shot: "B10-S2", plan: { ops: [{ op: "freeze_tail", clip: "a.mp4", live: 1 }] } },
  cut_film: { scope: "act1", res: "720" },
  get_jobs: { jobs: ["job-still-1", "job-still-2"] },
  wait_for_jobs: { jobs: ["job-still-1"], timeout_s: 1 },
};

describe("outputs stay under 1.5K chars", () => {
  it.each(TOOLS.map((d) => [d.name, d] as const))("%s", async (name, d) => {
    const { ctx, restore } = makeFakeContext();
    const res = await d.execute(ARGS[name] as never, ctx);
    restore();
    expect(res, name).toBeTruthy();
    expect(typeof res.ok).toBe("boolean");
    const size = JSON.stringify(res).length;
    expect(size, `${name} produced ${size} chars`).toBeLessThanOrEqual(BUDGETS.output);
    // clip() is the safety net, not the plan: it must be a no-op here.
    expect(JSON.stringify(clip(res)).length).toBe(size);
  });
});

describe("nothing throws or rejects", () => {
  it.each(TOOLS.map((d) => [d.name, d] as const))(
    "%s resolves an envelope for junk args", async (name, d) => {
      const { ctx, restore } = makeFakeContext({ project: null });
      const res = await d.execute({ shot: "", nonsense: true } as never, ctx);
      restore();
      expect(res).toHaveProperty("ok");
      if (!res.ok) expect(typeof res.error, name).toBe("string");
    });

  it("returns an envelope when the page never mounts", async () => {
    const { ctx, restore } = makeFakeContext({ failWaitFor: true });
    const res = await TOOLS_BY_NAME.freeze_tail.execute({ shot: "B10-S2" } as never, ctx);
    restore();
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("page_did_not_mount");
  });
});
