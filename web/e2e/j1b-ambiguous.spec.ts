import { expect, test } from "@playwright/test";
import { callTool, gotoApp, railTakes } from "./agent";

/**
 * J1b (WEBMCP-PLAN §5): "…the David Ross close up, shot 37".
 *
 * The two phrasings in Ryan's own sentence point at DIFFERENT shots — B10-S2 by
 * name (HERO, dugout) and B11-S4 by film order (a cemetery still). The resolver's
 * job is to SURFACE that, not to guess. This is the spec that proves the app
 * refuses to act on an ambiguous instruction, which is the whole safety story.
 */
const PID = "next-year";

test.describe("J1b — ambiguity is surfaced, not guessed", () => {
  test("a name + a conflicting ordinal returns both candidates as ambiguous", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);

    const res = await callTool(page, "find_shots", { query: "David Ross close up, shot 37" });
    expect(res.ok).toBe(true);
    expect(res.confidence, `expected ambiguity, got ${JSON.stringify(res)}`).toBe("ambiguous");

    const sids = ((res.candidates ?? []) as { sid: string }[]).map((c) => c.sid);
    expect(sids, "the name match B10-S2 must be offered").toContain("B10-S2");
    expect(sids, "the ordinal match B11-S4 must be offered").toContain("B11-S4");

    // Each candidate explains itself, so the agent can ask a real question.
    for (const c of (res.candidates ?? []) as { sid: string; why?: string }[]) {
      expect.soft(c.why, `candidate ${c.sid} has no "why"`).toBeTruthy();
    }
  });

  test("nothing runs while the shot is ambiguous", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);

    const beforeA = await railTakes(page);
    const res = await callTool(page, "generate_takes", {
      shot: "David Ross close up, shot 37",
      lane: "still",
      count: 3,
    });

    expect(res.ok, "an ambiguous shot must not generate").toBe(false);
    expect(String(res.error)).toMatch(/ambig|which|clarif/i);
    expect((res.candidates ?? []) as unknown[], "the error must carry the choices").not.toHaveLength(0);
    expect(res.jobs ?? [], "no jobs may be submitted").toEqual([]);

    // We did not silently navigate somewhere and start work.
    expect(await railTakes(page)).toEqual(beforeA);
  });

  test("a nonsense query resolves to nothing rather than a wrong shot", async ({ page }) => {
    await gotoApp(page, `/p/${PID}`);
    const res = await callTool(page, "find_shots", { query: "the underwater ballet sequence" });
    expect(res.ok).toBe(true);
    expect(res.confidence).toBe("none");
  });
});
