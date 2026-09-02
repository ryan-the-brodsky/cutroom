import { expect, test } from "@playwright/test";
import { anchor, callTool, gotoApp } from "./agent";

/**
 * Workstream M: the screening room.
 *
 * The bug this closes: "play the film" produced a thumbnail-sized <video> in the
 * Cuts gallery, because that was the only playback surface an agent could reach.
 * These assertions are the whole claim: one call puts the cut full screen, at the
 * second the director named, and one call closes it again.
 *
 * Needs a project with at least one assembled cut (mock stills are enough).
 */
const PID = process.env.CUTROOM_E2E_PROJECT || "two-claudes";

test.describe("M: the screening room", () => {
  test("play_cut opens the room at a named shot; stop_playback closes it", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/film`);

    const from = "B01-S2";
    const res = await callTool(page, "play_cut", { from });
    expect(res.ok, `play_cut failed: ${JSON.stringify(res)}`).toBe(true);
    expect(res.now_playing_shot).toBe(from);
    expect(Number(res.chapters)).toBeGreaterThan(1);

    // 1. The room is really open.
    const root = anchor(page, "screen.root");
    await expect(root).toBeVisible();

    // 2. The video is the cut it said it was playing.
    const video = anchor(page, "screen.video");
    await expect(video).toBeVisible();
    const src = await video.getAttribute("src");
    expect(src).toContain(String(res.cut));

    // 3. The playhead is at that shot's start (allow a little for seek settling).
    const want = Number(res.from);
    expect(want).toBeGreaterThan(0);
    const at = await video.evaluate((v) => (v as HTMLVideoElement).currentTime);
    expect(Math.abs(at - want), `playhead ${at} vs ${want}`).toBeLessThan(1.0);

    // 4. The chapter strip is the film's own shot list, and this shot is in it.
    await expect(page.locator(`[data-action="screen.chapter"][data-sid="${from}"]`))
      .toBeVisible();

    // 5. It is a link: ?screen=<rel>&t=<seconds>.
    expect(page.url()).toContain(`screen=${encodeURIComponent(String(res.cut))}`);

    // 6. And it closes.
    const stop = await callTool(page, "stop_playback", {});
    expect(stop.ok).toBe(true);
    await expect(root).toHaveCount(0);
    expect(page.url()).not.toContain("screen=");
  });

  test("play_cut takes a clock and a description", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/film`);
    const byClock = await callTool(page, "play_cut", { from: "0:17" });
    expect(byClock.ok).toBe(true);
    expect(byClock.from).toBe(17);
    await callTool(page, "stop_playback", {});
  });

  test("preview_timeline seeks the live preview to a clip", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/film`);
    const res = await callTool(page, "preview_timeline", { from: "B01-S2" });
    expect(res.ok, `preview_timeline failed: ${JSON.stringify(res)}`).toBe(true);
    expect(res.now_playing_shot).toBe("B01-S2");
    expect(String(res.note)).toContain("VO/music/SFX mix");
    await expect(anchor(page, "timeline.play")).toBeVisible();
    // The playhead readout is the page's own proof that the seek landed.
    const head = await page.locator('[data-testid="playhead"]').innerText();
    expect(head).toMatch(/0:0[6-9]|0:1\d/);
  });
});
