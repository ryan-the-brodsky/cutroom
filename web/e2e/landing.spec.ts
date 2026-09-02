/**
 * The public page at `/`, and the move of the studio to `/app`.
 *
 * Three things a judge depends on: the landing page renders, its CTA lands in the studio,
 * and a deep link minted before the move still arrives where it used to.
 */
import { expect, test } from "@playwright/test";
import { callTool, listTools, siteUrl, waitForTools } from "./agent";

test.describe("landing page", () => {
  test("renders the hero and the CTA opens the studio", async ({ page }) => {
    await page.goto(siteUrl("/"));

    await expect(page.getByRole("heading", { level: 1 }))
      .toContainText("An agent made a 2-minute film");
    await expect(page.locator(".lp-frame")).toHaveCount(8);
    await expect(page.locator(".lp-frame img").first()).toBeVisible();

    await page.getByRole("link", { name: "Open the studio" }).first().click();
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("registers the WebMCP tools on / as well as inside the app", async ({ page }) => {
    await page.goto(siteUrl("/"));
    const tools = await waitForTools(page, 20);
    expect(tools.length).toBeGreaterThan(20);

    const { tools: named } = await listTools(page);
    expect(named.map((t) => t.name)).toContain("get_context");
  });

  test("get_context on / reports the landing route and points at the studio", async ({ page }) => {
    await page.goto(siteUrl("/"));
    await waitForTools(page);
    const r = await callTool(page, "get_context");
    expect(r.ok).toBe(true);
    expect(String((r as { route?: string }).route)).toMatch(/^\/(\?|$)/);
    expect(JSON.stringify(r)).toContain("/app");
  });
});

test.describe("legacy deep links", () => {
  test("/p/:pid redirects to /app/p/:pid", async ({ page }) => {
    await page.goto(siteUrl("/p/next-year"));
    await expect(page).toHaveURL(/\/app\/p\/next-year/);
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("/jobs and /settings redirect under the app base", async ({ page }) => {
    await page.goto(siteUrl("/jobs"));
    await expect(page).toHaveURL(/\/app\/jobs/);
    await page.goto(siteUrl("/settings"));
    await expect(page).toHaveURL(/\/app\/settings/);
  });
});
