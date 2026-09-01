import { afterEach, describe, expect, it, vi } from "vitest";
import { BUDGETS, clip, err, ok, type ActionContext, type ActionDef } from "../contract";
import { __reset, all, auditRegistry, get, perform, register, validateArgs, whereOf } from "../registry";

// ------------------------------------------------------------------ a context that records

function fakeCtx(): ActionContext & { steps: { tool: string; title: string }[] } {
  const steps: { tool: string; title: string }[] = [];
  const ctx = {
    signal: new AbortController().signal,
    project: "next-year",
    nav: vi.fn(async () => {}),
    page: { current: () => null, waitFor: vi.fn() },
    api: vi.fn(async () => ({})),
    resolve: { index: vi.fn(), resolve: vi.fn() },
    trail: {
      step: async (s: { tool: string; title: string }) => { steps.push(s); },
      steps: () => [],
      clear: () => {},
    },
    speed: "fast" as const,
    steps,
  };
  return ctx as unknown as ActionContext & { steps: { tool: string; title: string }[] };
}

const def = (over: Partial<ActionDef<any>> = {}): ActionDef<any> => ({
  name: "test_tool",
  title: "Test tool",
  description: "Do a test thing in Cutroom.",
  inputSchema: { type: "object", properties: {}, required: [] },
  where: { route: "/", label: "Nowhere" },
  howTo: "Press the button.",
  execute: async () => ok("done"),
  ...over,
});

afterEach(() => __reset());

// ------------------------------------------------------------------ registration

describe("registry", () => {
  it("registers, gets and lists", () => {
    register(def());
    expect(get("test_tool")?.title).toBe("Test tool");
    expect(all()).toHaveLength(1);
  });

  it("later registration of the same name wins (C's tools beat A's smoke tools)", () => {
    register(def({ title: "smoke" }));
    register(def({ title: "real" }));
    expect(all()).toHaveLength(1);
    expect(get("test_tool")?.title).toBe("real");
  });

  it("resolves a function `where` against args", () => {
    const d = def({ where: (a: any) => ({ route: "/p/:pid", label: `Shot ${a.shot ?? "?"}` }) });
    expect(whereOf(d, { shot: "B10-S2" }).label).toBe("Shot B10-S2");
  });
});

// ------------------------------------------------------------------ budgets

describe("registry budgets", () => {
  it("audits names, descriptions, param descriptions, where and howTo", () => {
    expect(auditRegistry([def()])).toEqual([]);
    const problems = auditRegistry([def({
      name: "Bad-Name",
      description: "x".repeat(BUDGETS.description + 1),
      howTo: undefined,
      inputSchema: {
        type: "object",
        properties: { a: { type: "string", description: "y".repeat(BUDGETS.param + 1) } },
      },
    })]);
    const text = problems.map((p) => p.problem).join(" | ");
    expect(text).toMatch(/name must match/);
    expect(text).toMatch(/description \d+ >/);
    expect(text).toMatch(/param "a"/);
    expect(text).toMatch(/howTo is required/);
  });

  it("flags duplicate names", () => {
    const problems = auditRegistry([def(), def()]);
    expect(problems.map((p) => p.problem)).toContain("duplicate name");
  });

  it("every registered tool passes the audit", () => {
    register(def());
    expect(auditRegistry()).toEqual([]);
  });
});

// ------------------------------------------------------------------ validation

describe("validateArgs", () => {
  const schema = {
    type: "object" as const,
    properties: {
      shot: { type: "string" as const },
      count: { type: "integer" as const, minimum: 1, maximum: 4, default: 3 },
      lane: { type: "string" as const, enum: ["still", "restyle", "animate"] },
      confirm: { type: "boolean" as const },
      region: { type: "array" as const, items: { type: "number" as const }, minItems: 4 },
    },
    required: ["shot"],
  };

  it("accepts good args and applies defaults", () => {
    const v = validateArgs(schema, { shot: "B10-S2" });
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.count).toBe(3);
  });

  it("rejects a missing required arg", () => {
    const v = validateArgs(schema, {});
    expect(v.ok).toBe(false);
    expect(!v.ok && v.hint).toMatch(/shot is required/);
  });

  it("rejects a bad enum value and names the alternatives", () => {
    const v = validateArgs(schema, { shot: "B10-S2", lane: "zoom" });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.hint).toMatch(/must be one of/);
  });

  it("enforces min/max", () => {
    expect(validateArgs(schema, { shot: "x", count: 9 }).ok).toBe(false);
    expect(validateArgs(schema, { shot: "x", count: 0 }).ok).toBe(false);
  });

  it("coerces the string forms agents actually send", () => {
    const v = validateArgs(schema, { shot: "x", count: "2", confirm: "true", region: "1,2,3,4" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.count).toBe(2);
    expect(v.value.confirm).toBe(true);
    expect(v.value.region).toEqual([1, 2, 3, 4]);
  });

  it("rejects a non-integer where an integer is wanted", () => {
    expect(validateArgs(schema, { shot: "x", count: 2.5 }).ok).toBe(false);
  });

  it("enforces minItems on arrays", () => {
    expect(validateArgs(schema, { shot: "x", region: [1, 2] }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ perform

describe("perform", () => {
  it("stamps a trail step named after the action, then executes", async () => {
    register(def({ execute: async () => ok("ran") }));
    const ctx = fakeCtx();
    const res = await perform("test_tool", {}, ctx);
    expect(res).toEqual({ ok: true, summary: "ran" });
    expect(ctx.steps[0]).toMatchObject({ tool: "test_tool", title: "→ Test tool" });
  });

  it("returns an envelope for an unknown tool instead of throwing", async () => {
    const res = await perform("nope", {}, fakeCtx());
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBe("unknown_tool");
  });

  it("never throws when execute throws", async () => {
    register(def({ execute: async () => { throw new Error("kaboom"); } }));
    const res = await perform("test_tool", {}, fakeCtx());
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/kaboom/);
  });

  it("never throws when execute rejects with a non-Error", async () => {
    register(def({ execute: async () => { throw "plain string"; } }));
    const res = await perform("test_tool", {}, fakeCtx());
    expect(res.ok).toBe(false);
  });

  it("never throws when the trail itself throws", async () => {
    register(def());
    const ctx = fakeCtx();
    (ctx.trail as any).step = () => { throw new Error("trail down"); };
    const res = await perform("test_tool", {}, ctx);
    expect(res.ok).toBe(true);
  });

  it("reports abort distinctly", async () => {
    register(def({ execute: async () => {
      const e = new Error("stopped");
      e.name = "AbortError";
      throw e;
    } }));
    const res = await perform("test_tool", {}, fakeCtx());
    expect(!res.ok && res.error).toBe("aborted");
  });

  it("validates before executing", async () => {
    const execute = vi.fn(async () => ok("nope"));
    register(def({
      inputSchema: { type: "object", properties: { shot: { type: "string" } }, required: ["shot"] },
      execute,
    }));
    const res = await perform("test_tool", {}, fakeCtx());
    expect(!res.ok && res.error).toBe("invalid_arguments");
    expect(execute).not.toHaveBeenCalled();
  });

  it("clips oversized results to the output budget", async () => {
    register(def({ execute: async () => ok("big", {
      rows: Array.from({ length: 400 }, (_, i) => ({ i, note: "z".repeat(120) })),
    }) }));
    const res = await perform("test_tool", {}, fakeCtx());
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(BUDGETS.output);
  });

  it("passes a bare error envelope through untouched", async () => {
    register(def({ execute: async () => err("needs_confirmation", { hint: "confirm_cost:true" }) }));
    const res = await perform("test_tool", {}, fakeCtx());
    expect(res).toEqual({ ok: false, error: "needs_confirmation", hint: "confirm_cost:true" });
  });

  it("tolerates undefined args", async () => {
    register(def());
    expect((await perform("test_tool", undefined, fakeCtx())).ok).toBe(true);
  });
});

describe("clip", () => {
  it("leaves small values alone", () => {
    const v = { ok: true, summary: "small" };
    expect(clip(v)).toEqual(v);
  });
  it("shrinks arrays before strings", () => {
    const out = clip({ ok: true, summary: "s", rows: Array.from({ length: 300 }, () => "a".repeat(40)) }) as any;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(BUDGETS.output);
    expect(Array.isArray(out.rows)).toBe(true);
  });
});
