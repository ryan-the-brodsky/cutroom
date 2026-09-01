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
    expect(String(sel.kind ?? ""), `selected a ${sel.kind}, not a clip`).toMatch(/motion|fx/);
    expect(sel.is_clip, "select_take should report a clip").toBe(true);

    const before = await railTakes(page);

    const res = await callTool(page, "freeze_tail", { shot: SID, live_seconds: 1 });
    expect(res.ok, `freeze_tail failed: ${JSON.stringify(res)}`).toBe(true);
    expect(res.job, "freeze_tail should return a job").toBeTruthy();
    expect(res.live_seconds, "the FIRST-SECOND LAW default").toBe(1);
    // NB: assert on shape, not on the tail of the path — clip() truncates long
    // strings with "…" to hold the 1.5K output budget, so a path may not end in .mp4.
    expect(String(res.take ?? ""), "a new frozen take should be produced").toMatch(/^renders\/motion\//);

    // It happened on the Motion edits tab, where a human would do it.
    await expect.poll(() => urlParams(page).get("tab")).toBe("motion");
    await expect(anchor(page, "shot.motion.freeze")).toBeVisible();

    // The live field carries the value the agent set.
    const live = anchor(page, "shot.motion.live").first();
    if (await live.count()) {
      await expect.poll(async () => Number(await live.inputValue().catch(() => "NaN"))).toBe(1);
    }

    // A new take exists, and it is not the one we started from.
    expect(String(res.take)).not.toBe(String(res.source));
    await expect
      .poll(async () => (await railTakes(page)).length,
            { timeout: 60_000, message: "waiting for the rail to refresh" })
      .toBeGreaterThanOrEqual(before.length);
  });

  test("never freezes a still — the clip-extension guard holds", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);
    const sel = await callTool(page, "select_take", { shot: SID, take: "newest still" });
    test.skip(!sel.ok, "no still take to test the guard with");
    const still = String(sel.selected ?? "");
    expect(sel.is_clip, "the still should not be reported as a clip").toBe(false);
    expect(still).toMatch(/^renders\/stills\//);

    const res = await callTool(page, "freeze_tail", { shot: SID, live_seconds: 1 });
    if (res.ok) {
      // Acceptable: it fell back to the shot's newest CLIP rather than refusing.
      // What must never happen is a still being treated as a clip.
      expect(String(res.source ?? ""), "freeze_tail must not operate on a still").not.toBe(still);
      expect(String(res.source ?? ""), "freeze_tail must operate on a clip").toMatch(/^renders\/motion\//);
    } else {
      expect(String(res.error) + String(res.hint ?? "")).toMatch(/still|clip|motion|duration/i);
    }
  });
});
