import { expect, test } from "@playwright/test";
import { anchor, callTool, gotoApp, urlParams } from "./agent";

/**
 * J3 (WEBMCP-PLAN §5): "How do I do that by hand?" → show_me("freeze tail").
 *
 * This is the judges' "human-agent experience" in one tool: the agent does not
 * answer with prose, it walks you to the control and points at it. Genga Studio has
 * ~97 actions and no search — discovery IS the product problem.
 */
const PID = "next-year";
const SID = "B10-S2";

test.describe("show_me teaches the UI", () => {
  test("navigates to the motion tab and pulses the freeze control", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/shot/${SID}`);

    const res = await callTool(page, "show_me", { feature: "freeze tail" });
    expect(res.ok, `show_me failed: ${JSON.stringify(res)}`).toBe(true);
    expect(String(res.how_to ?? res.howTo ?? ""), "show_me must explain the manual path").toBeTruthy();
    expect(String(res.where ?? ""), "show_me must name the UI path").toBeTruthy();

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

    const features = (res.features ?? res.entries ?? []) as { name: string; title?: string; where?: string }[];
    expect(features.length, "list_features returned nothing").toBeGreaterThan(0);

    // KNOWN GAP (2026-09-01): the summary says "19 features" but clip() silently
    // halves the array to fit BUDGETS.output (1.5K), so only ~12 come back. An
    // agent asking "what can you do?" is quietly given a partial map. The fix is
    // either a leaner per-feature payload or an explicit `truncated`/`total` field
    // plus a `query` to page through. Until then this asserts the honest contract:
    // return everything, or SAY that you did not.
    const total = Number(String(res.summary ?? "").match(/(\d+)\s+features?/)?.[1] ?? features.length);
    if (features.length < total) {
      expect(res.truncated ?? res.total ?? res.more,
        `list_features returned ${features.length} of ${total} with no truncation flag`).toBeTruthy();
    }
    expect(features.length, "list_features should cover the catalogue").toBeGreaterThanOrEqual(16);
    for (const f of features) {
      expect.soft(f.title, `${f.name} has no title`).toBeTruthy();
      expect.soft(f.where, `${f.name} has no UI location — show_me cannot walk there`).toBeTruthy();
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
