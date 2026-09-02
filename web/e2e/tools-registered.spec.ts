import { expect, test } from "@playwright/test";
import { TOOL_NAMES, BUDGETS, TOOL_NAME_RE } from "../src/agent/contract";
import { agentMode, gotoApp, listTools } from "./agent";

/**
 * The contract, checked against what the browser actually holds.
 * This is the spec that proves "Cutroom is a WebMCP app" — everything else builds on it.
 */
test.describe("tool registration", () => {
  test("the page exposes a WebMCP surface", async ({ page }) => {
    await gotoApp(page, "/");
    const mode = await agentMode(page);
    // "none" means neither the native API nor the ?agent_debug=1 hook is there.
    expect(mode, "no agent surface — is Chrome running with --enable-features=WebMCP?").not.toBe("none");
    test.info().annotations.push({ type: "agent-mode", description: mode });
  });

  test("registers at least 16 tools, all from the frozen name list", async ({ page }) => {
    await gotoApp(page, "/");
    const { tools } = await listTools(page);
    const names = tools.map((t) => t.name).sort();

    expect(names.length).toBeGreaterThanOrEqual(16);
    // No tool may exist that the contract does not name.
    expect(names.filter((n) => !(TOOL_NAMES as readonly string[]).includes(n))).toEqual([]);
    // No duplicates (Chrome throws InvalidStateError on a dup, but a guard could mask it).
    expect(new Set(names).size).toBe(names.length);
  });

  test("every registered tool respects the Chrome budgets", async ({ page }) => {
    await gotoApp(page, "/");
    const { tools } = await listTools(page);
    expect(tools.length).toBeGreaterThan(0);

    for (const t of tools) {
      expect.soft(TOOL_NAME_RE.test(t.name), `name "${t.name}" fails TOOL_NAME_RE`).toBe(true);
      expect.soft(t.name.length, `name "${t.name}" too long`).toBeLessThanOrEqual(BUDGETS.name);
      expect.soft(t.description.length, `${t.name}: description ${t.description.length} > ${BUDGETS.description}`)
        .toBeLessThanOrEqual(BUDGETS.description);
      expect.soft(t.description.length, `${t.name}: description is empty`).toBeGreaterThan(0);

      // inputSchema arrives as a JSON string from Chrome; agent.ts parses it.
      const schema = t.inputSchema as { type?: string; properties?: Record<string, { description?: string }> } | null;
      expect.soft(schema, `${t.name}: inputSchema did not parse`).not.toBeNull();
      if (schema?.properties) {
        for (const [param, def] of Object.entries(schema.properties)) {
          const d = def?.description ?? "";
          expect.soft(d.length, `${t.name}.${param}: param description ${d.length} > ${BUDGETS.param}`)
            .toBeLessThanOrEqual(BUDGETS.param);
        }
      }
    }
  });

  test("read-only tools are annotated read-only", async ({ page }) => {
    await gotoApp(page, "/");
    const { mode, tools } = await listTools(page);
    // The debug hook may not carry annotations; only assert on a real WebMCP surface.
    test.skip(mode === "debug" || mode === "none", "annotations only round-trip through the native API");
    test.skip(test.info().project.name === "chromium-bundled", "bundled Chromium 151 drops annotations; system Chrome owns this check");

    const readOnly = ["find_shots", "describe_shot", "get_context", "list_features", "get_jobs", "wait_for_jobs"];
    for (const name of readOnly) {
      const t = tools.find((x) => x.name === name);
      if (!t) continue;                       // not landed yet; the count test owns coverage
      expect.soft(t.annotations?.readOnlyHint, `${name} should be readOnlyHint:true`).toBe(true);
    }
    // NOTE: consequentialHint is silently dropped by Chrome 152 (docs/TESTING-WEBMCP.md §1.3),
    // so we deliberately do not assert on it.
  });

  test("get_context reports where we are", async ({ page }) => {
    await gotoApp(page, "/");
    const { callTool } = await import("./agent");
    const res = await callTool(page, "get_context", {});
    expect(res.ok).toBe(true);
  });
});
