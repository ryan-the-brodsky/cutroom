import { expect, test } from "@playwright/test";
import { anchor, callTool, gotoApp, railTakes, urlParams } from "./agent";

/**
 * J2 (WEBMCP-PLAN §5): "Keep the first second of the newest one and freeze the rest."
 *   → select_take(shot, "newest motion") → freeze_tail(shot, live_seconds: 1)
 *
 * This encodes the film's own doctrine: TRUE FREEZES ONLY, and the FIRST-SECOND LAW.
 * The grammar refuses to freeze a still — that guard is asserted below too.
 */
const PID = "next-year";
const SID = "B10-S2";

test.describe("J2 — freeze the tail of a motion take", () => {
  test.slow();

  test("selects the newest motion take then freezes after 1s", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);

    const sel = await callTool(page, "select_take", { shot: SID, take: "newest motion" });
    test.skip(!sel.ok && /no .*motion|not found/i.test(String(sel.error)),
      `B10-S2 has no motion take in this fixture: ${JSON.stringify(sel)}`);
    expect(sel.ok, `select_take failed: ${JSON.stringify(sel)}`).toBe(true);
    expect(String(sel.kind ?? "")).toMatch(/motion|fx/);

    const before = await railTakes(page);

    const res = await callTool(page, "freeze_tail", { shot: SID, live_seconds: 1 });
    expect(res.ok, `freeze_tail failed: ${JSON.stringify(res)}`).toBe(true);
    expect(res.job, "freeze_tail should return a job").toBeTruthy();

    // It happened on the Motion edits tab, where a human would do it.
    await expect.poll(() => urlParams(page).get("tab")).toBe("motion");
    await expect(anchor(page, "shot.motion.freeze")).toBeVisible();

    // The live field carries the value the agent set.
    const live = anchor(page, "shot.motion.live").first();
    if (await live.count()) {
      await expect.poll(async () => Number(await live.inputValue().catch(() => "NaN"))).toBe(1);
    }

    // A new take exists.
    await expect
      .poll(async () => (await railTakes(page)).filter((p) => !before.includes(p)).length,
            { timeout: 60_000, message: "waiting for the frozen take" })
      .toBeGreaterThanOrEqual(1);
  });

  test("refuses to freeze a still (clip-extension guard)", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);
    const sel = await callTool(page, "select_take", { shot: SID, take: "newest still" });
    test.skip(!sel.ok, "no still take to test the guard with");

    const res = await callTool(page, "freeze_tail", { shot: SID, live_seconds: 1 });
    expect(res.ok, "freezing a still must be refused, not silently accepted").toBe(false);
    expect(String(res.error) + String(res.hint ?? "")).toMatch(/still|clip|motion|duration/i);
  });
});
