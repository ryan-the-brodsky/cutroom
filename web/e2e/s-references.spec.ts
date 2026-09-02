import { expect, test } from "@playwright/test";
import { anchor, callTool, gotoApp } from "./agent";

/**
 * S (WEBMCP-PLAN §4): "use this image as the setting for this shot."
 *   → attach_reference → the References strip → list_references → remove_reference
 *
 * The point of the smoke is that the tool moves the interface a person looks
 * at: a reference the agent attaches has to appear in the Generate tab's strip
 * with a role badge, not just in the database.
 *
 * Runs against the scratch server named in the workstream brief:
 *   mkdir -p /tmp/cutroom-S && CUTROOM_DATA=/tmp/cutroom-S/data \
 *     server/.venv/bin/cutroom --port 8795
 *   CUTROOM_E2E_PORT=8795 npx playwright test e2e/s-references.spec.ts
 */
const PID = process.env.CUTROOM_E2E_PROJECT ?? "next-year";

test.describe("S — reference images", () => {
  test("attach_reference renders a badge in the Generate tab's strip", async ({ page }) => {
    // Whichever shot this instance has, take the first with a still on it.
    const film = await (await page.request.get(`/api/projects/${PID}/film`)).json();
    const rows = (Array.isArray(film) ? film : film.shots ?? []) as
      { sid: string; keeper?: string | null; stills?: string[] }[];
    const hit = rows.find((r) => r.keeper || r.stills?.length);
    test.skip(!hit, "no shot with a still to use as a reference");
    const sid = hit!.sid;
    const image = String(hit!.keeper || hit!.stills?.[0]);

    await gotoApp(page, `/p/${PID}/shot/${sid}?tab=generate`);

    const attached = await callTool(page, "attach_reference",
      { shot: sid, image, role: "setting", note: "e2e" });
    expect(attached.ok, `attach_reference failed: ${JSON.stringify(attached)}`).toBe(true);
    expect(String((attached.reference as { role?: string })?.role)).toBe("setting");

    // The strip, on screen, with the role badge on the item.
    const strip = anchor(page, "shot.gen.refs");
    await expect(strip).toBeVisible();
    const item = anchor(page, "shot.gen.ref", { path: image });
    await expect(item).toBeVisible();
    await expect(item).toContainText("setting");
    await expect(anchor(page, "shot.gen.ref.remove", { path: image })).toBeVisible();

    // The server agrees, and so does the read-only tool.
    const listed = await callTool(page, "list_references", { shot: sid });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.references)).toContain("setting");

    // And ✕ takes it back off.
    const removed = await callTool(page, "remove_reference", { shot: sid, image: "all" });
    expect(removed.ok, `remove_reference failed: ${JSON.stringify(removed)}`).toBe(true);
    await expect(anchor(page, "shot.gen.ref", { path: image })).toHaveCount(0);
  });
});
