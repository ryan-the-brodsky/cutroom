import { expect, test } from "@playwright/test";
import { anchor, callTool, gotoApp, urlParams } from "./agent";

/**
 * J3 (WEBMCP-PLAN §5): "How do I do that by hand?" → show_me("freeze tail").
 *
 * This is the judges' "human-agent experience" in one tool: the agent does not
 * answer with prose, it walks you to the control and points at it. Cutroom has
 * ~97 actions and no search — discovery IS the product problem.
 */
const PID = "next-year";
const SID = "B10-S2";

test.describe("show_me teaches the UI", () => {
  test("navigates to the motion tab and pulses the freeze control", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/shot/${SID}`);

    const res = await callTool(page, "show_me", { feature: "freeze tail" });
    expect(res.ok, `show_me failed: ${JSON.stringify(res)}`).toBe(true);
    expect(String(res.howTo ?? ""), "show_me must explain the manual path").toBeTruthy();

    await expect.poll(() => urlParams(page).get("tab")).toBe("motion");

    const freeze = anchor(page, "shot.motion.freeze").first();
    await expect(freeze).toBeVisible();
    // The pulse is a 1.2 s class; poll rather than sample once.
    await expect
      .poll(async () => freeze.evaluate((n) => n.classList.contains("agent-pulse")),
            { timeout: 5_000, message: "waiting for .agent-pulse on shot.motion.freeze" })
      .toBe(true);
  });

  test("list_features covers the registry, including palette-only entries", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);
    const res = await callTool(page, "list_features", {});
    expect(res.ok).toBe(true);

    const features = (res.features ?? res.entries ?? []) as { name: string; howTo?: string; where?: unknown }[];
    expect(features.length, "list_features returned nothing").toBeGreaterThanOrEqual(16);
    for (const f of features) {
      expect.soft(f.howTo, `${f.name} has no howTo — show_me cannot teach it`).toBeTruthy();
    }
  });

  test("show_me on an unknown feature fails helpfully instead of throwing", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);
    const res = await callTool(page, "show_me", { feature: "colour grade the third reel" });
    // Whatever it decides, it must resolve — a rejection becomes an opaque
    // UnknownError to the agent (docs/TESTING-WEBMCP.md §1.5).
    expect(typeof res.ok).toBe("boolean");
    if (!res.ok) expect(res.hint ?? res.candidates, "an error must be recoverable").toBeTruthy();
  });
});
