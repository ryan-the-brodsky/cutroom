import { expect, test } from "@playwright/test";
import { anchor, appUrl, waitForTools } from "./agent";

/**
 * URL state (WEBMCP-PLAN §6.A). Before this work the Shot Editor tab, sub-tab,
 * selected take and kind filter were all local state — the deepest link was
 * /p/:pid/shot/:sid. An agent cannot say "look at this" without addressable state.
 */
const PID = "next-year";
const SID = "B10-S2";

test.describe("deep links restore UI state", () => {
  test("?tab=generate&sub=still opens that tab and sub-tab", async ({ page }) => {
    await page.goto(appUrl(`/p/${PID}/shot/${SID}?tab=generate&sub=still`));
    await waitForTools(page);

    const tab = anchor(page, "shot.tab.generate");
    await expect(tab).toBeVisible();
    // Selection is asserted via aria-selected / aria-pressed / .is-active, whichever
    // workstream A settled on — accept any of them, but require one.
    await expect
      .poll(async () => {
        const el = tab.first();
        return el.evaluate((n) => ({
          selected: n.getAttribute("aria-selected"),
          pressed: n.getAttribute("aria-pressed"),
          cls: n.className,
        }));
      })
      .toEqual(expect.objectContaining({}));
    const state = await tab.first().evaluate((n) => ({
      selected: n.getAttribute("aria-selected"),
      pressed: n.getAttribute("aria-pressed"),
      active: /\b(active|is-active|selected)\b/.test(n.className),
    }));
    expect(state.selected === "true" || state.pressed === "true" || state.active,
      `generate tab not marked active: ${JSON.stringify(state)}`).toBe(true);

    const sub = anchor(page, "shot.gen.sub.still");
    await expect(sub).toBeVisible();
    const subState = await sub.first().evaluate((n) => ({
      selected: n.getAttribute("aria-selected"),
      pressed: n.getAttribute("aria-pressed"),
      active: /\b(active|is-active|selected)\b/.test(n.className),
    }));
    expect(subState.selected === "true" || subState.pressed === "true" || subState.active,
      `still sub-tab not marked active: ${JSON.stringify(subState)}`).toBe(true);
  });

  test("?tab=motion opens the motion-edits tab", async ({ page }) => {
    await page.goto(appUrl(`/p/${PID}/shot/${SID}?tab=motion`));
    await waitForTools(page);
    await expect(anchor(page, "shot.motion.freeze")).toBeVisible();
  });

  test("the tab lands in the URL when clicked, so the state is linkable", async ({ page }) => {
    await page.goto(appUrl(`/p/${PID}/shot/${SID}`));
    await waitForTools(page);
    await anchor(page, "shot.tab.audio").first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("audio");
  });
});
