import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE, clampSeconds, clipCost, fitBudget, framesForSeconds,
  rankShots, type MotionProfile, type PlanShot,
} from "../plan";

const WAN: MotionProfile = {
  seconds_default: 5, seconds_max: 5, seconds_options: [5],
  live_seconds_default: 5, fps: 16, frames_options: [81],
  cost_per_clip_usd: 0.05,
};
const PIXVERSE: MotionProfile = {
  seconds_default: 5, seconds_max: 15, fps: 24, cost_per_second_usd: 0.035,
};

const shot = (over: Partial<PlanShot> & { sid: string }): PlanShot => ({
  act: 1, type: "STILL", seconds: 4, keeper: "renders/stills/a.png", ...over,
});

describe("motion profile maths", () => {
  it("clamps seconds to the profile ceiling", () => {
    expect(clampSeconds(WAN, 12)).toBe(5);
    expect(clampSeconds(DEFAULT_PROFILE, 12)).toBe(5);
    expect(clampSeconds(DEFAULT_PROFILE, 0)).toBe(0.1);
  });

  it("snaps to a discrete duration list when the API has one", () => {
    expect(clampSeconds(WAN, 3)).toBe(5);              // turbo has no duration
    expect(clampSeconds({ ...WAN, seconds_max: 8, seconds_options: [5, 8] }, 7))
      .toBe(8);
  });

  it("converts seconds to a frame count the model accepts", () => {
    expect(framesForSeconds(WAN, 3)).toBe(81);         // only 81 is offered
    expect(framesForSeconds(DEFAULT_PROFILE, 2)).toBe(49);   // 8k+1 at 24fps
    expect(framesForSeconds(DEFAULT_PROFILE, 4)).toBe(97);
  });

  it("prices per clip or per second, whichever the model bills", () => {
    expect(clipCost(WAN, 5)).toBe(0.05);
    expect(clipCost(WAN, 3)).toBe(0.05);               // flat: no saving
    expect(clipCost(PIXVERSE, 5)).toBeCloseTo(0.175, 4);
    expect(clipCost(PIXVERSE, 3)).toBeCloseTo(0.105, 4);
  });
});

describe("rankShots", () => {
  const film: PlanShot[] = [
    shot({ sid: "B01-S1", type: "STILL", seconds: 2, act: 1 }),
    shot({ sid: "B02-S1", type: "HERO", seconds: 3, act: 1 }),
    shot({ sid: "B03-S1", type: "STILL", seconds: 9, act: 1,
           motion_prompt: "one burst: the beams sweep past" }),
    shot({ sid: "B09-S4", type: "HERO", seconds: 9, act: 3,
           motion_prompt: "one burst: a cursor blinks" }),
    shot({ sid: "B09-S5", type: "HERO", seconds: 9, act: 3,
           motion_prompt: "a burst", motion: ["renders/fx/x.mp4"] }),
    shot({ sid: "B10-S1", type: "HERO", seconds: 9, act: 3, keeper: null,
           stills: [] }),
  ];

  it("puts the HERO climax with a motion prompt first", () => {
    const r = rankShots(film, { profile: WAN });
    expect(r[0].shot).toBe("B09-S4");
  });

  it("deprioritises shots that already have a clip", () => {
    const r = rankShots(film, { profile: WAN }).filter((x) => !x.skipped);
    const withClip = r.findIndex((x) => x.shot === "B09-S5");
    const without = r.findIndex((x) => x.shot === "B09-S4");
    expect(withClip).toBeGreaterThan(without);
    expect(r[withClip].why).toContain("already has a clip");
  });

  it("skips shots with no plate and says why", () => {
    const r = rankShots(film, { profile: WAN });
    const none = r.find((x) => x.shot === "B10-S1");
    expect(none?.skipped).toMatch(/no plate/);
    expect(r.filter((x) => !x.skipped).map((x) => x.shot)).not.toContain("B10-S1");
  });

  it("weights the criteria `prefer` names twice as heavily", () => {
    const plain = rankShots(film, { profile: WAN });
    const longest = rankShots(film, { profile: WAN, prefer: ["longest"] });
    const heroRank = (rows: typeof plain) => rows.findIndex((x) => x.shot === "B02-S1");
    // B02-S1 is a short HERO: doubling `longest` should push it down
    expect(heroRank(longest)).toBeGreaterThanOrEqual(heroRank(plain));
  });

  it("gives every kept shot a reason and the profile's clip length", () => {
    const r = rankShots(film, { profile: WAN }).filter((x) => !x.skipped);
    for (const row of r) {
      expect(row.why.length).toBeGreaterThan(0);
      expect(row.why).not.toMatch(/freez/i);       // clips play in full now
      expect(row.seconds).toBe(5);
    }
  });

  it("honours an explicit seconds_per_clip, clamped", () => {
    const r = rankShots(film, { profile: PIXVERSE, seconds: 3 });
    expect(r[0].seconds).toBe(3);
    expect(rankShots(film, { profile: PIXVERSE, seconds: 99 })[0].seconds).toBe(15);
  });
});

describe("fitBudget", () => {
  const ranked = rankShots(
    Array.from({ length: 12 }, (_, i) =>
      shot({ sid: `B${String(i + 1).padStart(2, "0")}-S1`, type: "HERO",
             seconds: 9 - i * 0.5, act: 1 + (i % 3) })),
    { profile: WAN });

  it("takes shots in rank order while they fit", () => {
    const p = fitBudget(ranked, { budget_usd: 0.2, profile: WAN });
    expect(p.items).toHaveLength(4);              // 4 x $0.05
    expect(p.total_usd).toBeCloseTo(0.2, 4);
    expect(p.left).toBeCloseTo(0, 4);
    expect(p.items.map((i) => i.shot)).toEqual(
      ranked.slice(0, 4).map((r) => r.shot));
  });

  it("never overspends, even by a cent", () => {
    const p = fitBudget(ranked, { budget_usd: 0.17, profile: WAN });
    expect(p.total_usd).toBeLessThanOrEqual(0.17);
    expect(p.items).toHaveLength(3);
    expect(p.dropped).toBeGreaterThan(0);
  });

  it("respects max_shots below what the budget allows", () => {
    const p = fitBudget(ranked, { budget_usd: 4, profile: WAN, max_shots: 2 });
    expect(p.items).toHaveLength(2);
    expect(p.left).toBeCloseTo(3.9, 4);
  });

  it("prices a per-second model at the requested clip length", () => {
    const short = rankShots(
      [shot({ sid: "A", type: "HERO" }), shot({ sid: "B", type: "HERO" })],
      { profile: PIXVERSE, seconds: 3 });
    const p = fitBudget(short, { budget_usd: 0.25, profile: PIXVERSE });
    expect(p.items).toHaveLength(2);              // 2 x $0.105
    expect(p.total_usd).toBeCloseTo(0.21, 4);
  });

  it("returns an empty plan rather than a negative budget", () => {
    const p = fitBudget(ranked, { budget_usd: 0.01, profile: WAN });
    expect(p.items).toHaveLength(0);
    expect(p.total_usd).toBe(0);
    expect(p.left).toBeCloseTo(0.01, 4);
  });

  it("falls back to the lane's per-take cost when the profile has no price", () => {
    const bare: MotionProfile = { seconds_default: 5, seconds_max: 5, fps: 24,
                                  cost_per_clip_usd: undefined };
    const p = fitBudget(rankShots([shot({ sid: "A" }), shot({ sid: "B" })],
                                  { profile: bare }),
                        { budget_usd: 0.3, profile: bare, unit_usd: 0.2 });
    expect(p.items).toHaveLength(1);
    expect(p.total_usd).toBeCloseTo(0.2, 4);
  });
});
