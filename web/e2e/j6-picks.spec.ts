import { expect, test } from "@playwright/test";
import { callTool, gotoApp, railTakes } from "./agent";

/**
 * J6 (WEBMCP-PLAN §5): "Make this take the keeper and use it in the timeline."
 *   → set_keeper → set_timeline_source
 *
 * Two atomic tools rather than one "promote", per Chrome's guidance — and because
 * the film's doctrine separates "this is the good one" (★) from "this is what
 * plays" (⬆). The Film Editor must reflect both.
 */
const PID = "next-year";
const SID = "B10-S2";

test.describe("J6 — keeper and timeline source", () => {
  test("set_keeper then set_timeline_source, reflected in the Film Editor", async ({ page }) => {
    await gotoApp(page, `/p/${PID}/shot/${SID}`);

    const takes = await railTakes(page);
    test.skip(takes.length === 0, "no takes in the rail to pick from");

    const sel = await callTool(page, "select_take", { shot: SID, take: "newest still" });
    const target = sel.ok ? String(sel.path ?? sel.selected ?? "") : takes[0];
    expect(target, "could not determine a take to promote").toBeTruthy();

    const keeper = await callTool(page, "set_keeper", { shot: SID, take: target, note: "e2e" });
    expect(keeper.ok, `set_keeper failed: ${JSON.stringify(keeper)}`).toBe(true);

    const source = await callTool(page, "set_timeline_source", { shot: SID, take: target });
    expect(source.ok, `set_timeline_source failed: ${JSON.stringify(source)}`).toBe(true);

    // The server agrees.
    const desc = await callTool(page, "describe_shot", { shot: SID });
    expect(desc.ok).toBe(true);
    expect(String(desc.keeper ?? "")).toContain(target.split("/").pop() ?? target);
    expect(String(desc.active_source ?? desc.activeSource ?? "")).toContain(target.split("/").pop() ?? target);

    // And so does the Film Editor.
    await gotoApp(page, `/p/${PID}`);
    const strip = page.locator(`[data-action="film.shot"][data-sid="${SID}"]`);
    await expect(strip).toBeVisible();
  });
});
