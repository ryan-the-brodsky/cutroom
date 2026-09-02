/**
 * The app moved to `/app` and the landing page took `/`. This is the test that keeps it
 * that way: every route the registry can produce, for tools, palette-only features and
 * the screening room alike, either lives under the app base or is the landing page.
 *
 * A stray `"/p/…"` anywhere in the catalogue is a dead link once the app has a base, and
 * it is invisible until an agent tries to walk there. Grep is not enough because `where`
 * can be a function of the arguments, so we call every one of them.
 */
import { describe, expect, it } from "vitest";
import type { ActionDef, Where } from "../contract";
import { FEATURES } from "../features";
import { SCREEN_FEATURES } from "../features.screen";
import { TOOLS } from "../tools/index";
import {
  APP_BASE, LANDING, ROUTES, appPath, filmPath, pidFromPath, projectPath, shotPath,
} from "../../routes";

/** Argument shapes that make an argument-dependent `where` take each of its branches. */
const ARG_CASES: Record<string, unknown>[] = [
  {},
  { shot: "B10-S2" },
  { shot: "B10-S2", tab: "motion" },
  { shot: "B10-S2", sub: "animate" },
  { shot: "B10-S2", tab: "generate", sub: "still" },
  { comp: "B10-S2-1", cid: "B10-S2-1" },
];

const wheres = (d: ActionDef<any>): Where[] => {
  if (typeof d.where !== "function") return [d.where];
  const out: Where[] = [];
  for (const args of ARG_CASES) {
    try { out.push(d.where(args as never)); } catch { /* branch needs other args */ }
  }
  return out;
};

const ALL: ActionDef<any>[] = [
  ...TOOLS,
  ...(FEATURES as unknown as ActionDef<any>[]),
  ...(SCREEN_FEATURES as unknown as ActionDef<any>[]),
];

describe("route base", () => {
  it("has a catalogue to check", () => {
    expect(ALL.length).toBeGreaterThan(40);
  });

  it("puts every registry route under /app, or on the landing page", () => {
    const stray: string[] = [];
    for (const def of ALL) {
      for (const w of wheres(def)) {
        if (!w?.route) continue;
        if (w.route === LANDING) continue;            // "anywhere", e.g. the ⌘K palette
        if (w.route === APP_BASE) continue;           // the Projects room
        if (w.route.startsWith(`${APP_BASE}/`)) continue;
        stray.push(`${def.name}: ${w.route}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("never double-prefixes the base", () => {
    for (const def of ALL) {
      for (const w of wheres(def)) {
        if (!w?.route) continue;
        expect(w.route.startsWith(`${APP_BASE}${APP_BASE}`)).toBe(false);
      }
    }
  });
});

describe("path builders", () => {
  it("builds the app base from an empty or root argument", () => {
    expect(appPath()).toBe("/app");
    expect(appPath("")).toBe("/app");
    expect(appPath("/")).toBe("/app");
  });

  it("accepts a leading slash or not", () => {
    expect(appPath("/jobs")).toBe("/app/jobs");
    expect(appPath("jobs")).toBe("/app/jobs");
  });

  it("matches the route patterns the router mounts", () => {
    expect(ROUTES.projects).toBe("/app");
    expect(ROUTES.jobs).toBe("/app/jobs");
    expect(ROUTES.settings).toBe("/app/settings");
    expect(ROUTES.project).toBe("/app/p/:pid");
    expect(ROUTES.film).toBe("/app/p/:pid/film");
    expect(ROUTES.shot).toBe("/app/p/:pid/shot/:sid");
    expect(ROUTES.comp).toBe("/app/p/:pid/comp/:cid");
    expect(ROUTES.timeline).toBe("/app/p/:pid/timeline");
    expect(ROUTES.chat).toBe("/app/p/:pid/chat");
  });

  it("builds concrete paths", () => {
    expect(projectPath("next-year")).toBe("/app/p/next-year");
    expect(filmPath("next-year")).toBe("/app/p/next-year/film");
    expect(shotPath("next-year", "B10-S2")).toBe("/app/p/next-year/shot/B10-S2");
  });

  it("reads the project id back out of a path, and nothing out of the landing page", () => {
    expect(pidFromPath("/app/p/next-year")).toBe("next-year");
    expect(pidFromPath("/app/p/next-year/shot/B10-S2")).toBe("next-year");
    expect(pidFromPath("/app/p/two%20claudes")).toBe("two claudes");
    expect(pidFromPath("/app")).toBeNull();
    expect(pidFromPath("/")).toBeNull();
    expect(pidFromPath("/p/next-year")).toBeNull();   // the legacy path only redirects
  });
});
