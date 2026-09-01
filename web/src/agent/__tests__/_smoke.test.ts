import { describe, expect, it } from "vitest";
import { BUDGETS, TOOL_NAMES, TOOL_NAME_RE, anchorSelector, clip } from "../contract";

describe("harness smoke", () => {
  it("runs in jsdom", () => {
    expect(typeof document).toBe("object");
    expect(anchorSelector("shot.tab", { tab: "generate" })).toBe('[data-action="shot.tab"][data-tab="generate"]');
  });
  it("contract tool names are legal and >= 16", () => {
    expect(TOOL_NAMES.length).toBeGreaterThanOrEqual(16);
    for (const n of TOOL_NAMES) expect(TOOL_NAME_RE.test(n)).toBe(true);
  });
  it("clip keeps output under budget", () => {
    const big = { ok: true, summary: "x", rows: Array.from({ length: 500 }, (_, i) => ({ i, s: "y".repeat(80) })) };
    expect(JSON.stringify(clip(big)).length).toBeLessThanOrEqual(BUDGETS.output);
  });
});
