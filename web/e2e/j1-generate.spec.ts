import { expect, test } from "@playwright/test";
import { callTool, gotoApp, railTakes, trailSteps, urlParams } from "./agent";

/**
 * J1, the hero journey (WEBMCP-PLAN §5):
 *   "Make a few more generative cuts of the David Ross close-up."
 *   → find_shots → generate_takes(lane:"still", count:3)
 *
 * The point is not that jobs were submitted — it is that the human WATCHED it happen:
 * the app navigated to B10-S2, opened Generate → Still, and three takes appeared.
 */
const PID = "next-year";
const SID = "B10-S2";

test.describe("J1 — generate takes from a description", () => {
  test.slow();  // three mock generations plus navigation

  test("resolves the David Ross close-up to B10-S2", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/film`);
    const res = await callTool(page, "find_shots", { query: "David Ross close-up" });
    expect(res.ok).toBe(true);

    const matches = (res.matches ?? res.candidates ?? []) as { sid: string }[];
    const sids = matches.map((m) => m.sid);
    expect(sids, `expected B10-S2 among candidates, got ${JSON.stringify(sids)}`).toContain(SID);
    // Named, unqualified, this should be a confident hit — not a coin flip.
    expect(["exact", "high"]).toContain(res.confidence);
  });

  test("generates 3 stills, visibly, and leaves the UI on the shot", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/film`);

    const before = await callTool(page, "describe_shot", { shot: SID });
    expect(before.ok).toBe(true);
    const beforeTakes = ((before.takes ?? {}) as Record<string, number>);
    const beforeStills = Number(beforeTakes.stills ?? 0);

    const res = await callTool(page, "generate_takes", {
      shot: "the David Ross close-up",
      lane: "still",
      count: 3,
    });

    expect(res.ok, `generate_takes failed: ${JSON.stringify(res)}`).toBe(true);
    const jobs = (res.jobs ?? []) as unknown[];
    expect(jobs.length, "expected one job per take").toBe(3);

    // The agent drove the real UI: we are on B10-S2, Generate → Still.
    await expect.poll(() => page.url()).toContain(`/shot/${SID}`);
    await expect.poll(() => urlParams(page).get("tab")).toBe("generate");
    await expect.poll(() => urlParams(page).get("sub")).toBe("still");

    // The tool reports the settled takes (mock is instant).
    expect(((res.takes ?? []) as unknown[]).length, "expected 3 settled takes").toBe(3);

    // …and they are on screen in the rail. describe_shot returns per-kind COUNTS,
    // so compare counts rather than paths.
    const after = await callTool(page, "describe_shot", { shot: SID });
    expect(Number(((after.takes ?? {}) as Record<string, number>).stills ?? 0),
      "the shot should have 3 more stills").toBeGreaterThanOrEqual(beforeStills + 3);
    await expect
      .poll(async () => (await railTakes(page)).length,
            { timeout: 60_000, message: "waiting for the takes rail to refresh" })
      .toBeGreaterThan(0);

    // And the human can read back what happened.
    const trail = await trailSteps(page);
    expect(trail.length, `agent trail too short: ${JSON.stringify(trail)}`).toBeGreaterThanOrEqual(4);
  });
});
