import { expect, test } from "@playwright/test";
import { anchor, callTool, gotoApp } from "./agent";

/**
 * J4 (WEBMCP-PLAN §5): "Cut act 1 at 720."
 *   → cut_film(scope:"act1", res:"720") → wait_for_jobs
 *
 * The assembler is real ffmpeg work on CPU — minutes, not seconds. This is the
 * journey that proves the submit-and-poll pattern from the API brief §7: the tool
 * returns a job immediately (no WebMCP progress API exists), a bounded wait tool
 * polls, and the page shows progress the whole time.
 */
const PID = "next-year";

test.describe("J4 — cut the film", () => {
  test("submits an act-1 cut and waits for the animatic", async ({ page }) => {
    test.setTimeout(5 * 60 * 1000);          // the assembler is minutes on CPU
    await gotoApp(page, `/p/${PID}`);

    const res = await callTool(page, "cut_film", { scope: "act1", res: "720" });
    expect(res.ok, `cut_film failed: ${JSON.stringify(res)}`).toBe(true);
    const job = String(res.job ?? "");
    expect(job, "cut_film must return a job id immediately, not block").toBeTruthy();

    // The Cut button is where a human would have clicked.
    await expect(anchor(page, "film.cut")).toBeVisible();

    // wait_for_jobs is capped at 60 s per the contract, so loop it.
    let status = "";
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      const w = await callTool(page, "wait_for_jobs", { jobs: [job], timeout_s: 60 });
      expect(w.ok, `wait_for_jobs failed: ${JSON.stringify(w)}`).toBe(true);
      const entries = (w.jobs ?? w.statuses ?? []) as { id?: string; status?: string }[];
      status = String(entries[0]?.status ?? w.status ?? "");
      if (status === "done" || status === "failed" || status === "cancelled") break;
    }
    expect(status, `cut job ended as "${status}"`).toBe("done");

    // The animatic is on screen in the Cuts gallery.
    const gallery = page.locator("video, [data-cut], [data-action='film.cut.result']");
    await expect.poll(async () => gallery.count(), { timeout: 60_000 }).toBeGreaterThan(0);
  });

  test("get_jobs reports the queue without blocking", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);
    const res = await callTool(page, "get_jobs", {});
    expect(res.ok).toBe(true);
  });
});
