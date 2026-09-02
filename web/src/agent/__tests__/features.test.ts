/**
 * The feature registry (workstream I).
 *
 * The load-bearing test is anchor coverage: every `where.anchor` in the whole
 * registry — tools and palette-only features alike — must actually exist as a
 * `data-action` in the app, or `show_me` and ⌘K navigate somewhere and pulse
 * nothing. That failure is invisible in the browser and obvious here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANCHORS, TOOL_NAME_RE, genFieldAnchor, genSubAnchor, shotTabAnchor,
  type GenSub, type ShotTab, type Where,
} from "../contract";
import { FEATURES, featureGroups, walkTo } from "../features";
import { ALL_ACTIONS, TOOLS } from "../tools";
import { makeFakeContext } from "../tools/fakeContext";

// vitest runs from `web/`; jsdom rewrites import.meta.url to an http URL, so cwd it is.
const SRC = join(process.cwd(), "src");

const TABS: ShotTab[] = ["compose", "generate", "motion", "audio", "script"];
const SUBS: GenSub[] = ["still", "restyle", "animate", "chain"];
const FIELDS = ["prompt", "negative", "seeds", "denoise", "frames", "steps", "cfg",
  "freeze_after", "fullFrame", "region", "backend", "model", "beats", "submit"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    // Only components render anchors; .ts modules (contract, tools, features)
    // merely name them, so counting those would make the test vacuous.
    else if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Anchors the components actually render. Resolves the four shapes the codebase
 * uses: a literal, `ANCHORS.key`, a `${ANCHORS.key}.suffix` template, and the
 * three anchor helper functions.
 */
function renderedAnchors(): Set<string> {
  const found = new Set<string>();
  const files = walk(SRC);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/data-action=(?:"([^"]+)"|\{`?([^}`]+)`?\})/g)) {
      if (m[1]) found.add(m[1]);
    }
    // `ANCHORS.key` anywhere in a component counts (Thumb takes one as a prop).
    for (const m of text.matchAll(/ANCHORS\.([A-Za-z0-9_]+)/g)) {
      const v = (ANCHORS as Record<string, string>)[m[1]];
      if (v) found.add(v);
    }
    for (const m of text.matchAll(/\$\{ANCHORS\.([A-Za-z0-9_]+)\}\.([A-Za-z0-9_.]+)/g)) {
      const v = (ANCHORS as Record<string, string>)[m[1]];
      if (v) found.add(`${v}.${m[2]}`);
    }
    if (/shotTabAnchor\(/.test(text)) TABS.forEach((t) => found.add(shotTabAnchor(t)));
    if (/genSubAnchor\(/.test(text)) SUBS.forEach((s) => found.add(genSubAnchor(s)));
    for (const m of text.matchAll(/genFieldAnchor\("([a-z]+)",\s*"([A-Za-z_]+)"\)/g)) {
      found.add(genFieldAnchor(m[1] as GenSub, m[2] as never));
    }
    if (/genFieldAnchor\([a-z]/i.test(text)) {
      SUBS.forEach((s) => FIELDS.forEach((f) => found.add(genFieldAnchor(s, f as never))));
    }
  }
  return found;
}

const whereOf = (d: { where: Where | ((a: never) => Where) }): Where =>
  (typeof d.where === "function" ? d.where({} as never) : d.where);

describe("feature registry", () => {
  it("has a healthy number of palette-only entries across every screen", () => {
    expect(FEATURES.length).toBeGreaterThan(80);
    const groups = featureGroups();
    for (const screen of ["App shell", "Projects", "Film Editor", "Shot Editor",
      "Cel workbench", "Separate a figure", "Timeline", "Jobs", "Settings",
      "Director chat"]) {
      expect(groups[screen], screen).toBeGreaterThan(1);
    }
  });

  it("names are unique across the WHOLE registry and never shadow a tool", () => {
    const names = ALL_ACTIONS.map((d) => d.name);
    expect(new Set(names).size, "duplicate action name").toBe(names.length);
    const toolNames = new Set(TOOLS.map((t) => t.name));
    for (const f of FEATURES) expect(toolNames.has(f.name), f.name).toBe(false);
  });

  it("every feature is palette-only, grouped, and shaped like an ActionDef", () => {
    for (const d of FEATURES) {
      expect(d.name, d.name).toMatch(TOOL_NAME_RE);
      expect(d.surfaces?.agent, d.name).toBe(false);
      expect(d.group, d.name).toBeTruthy();
      expect(d.title.length, d.name).toBeGreaterThan(2);
      expect(d.howTo, d.name).toBeTruthy();
      expect(d.howTo!.length, d.name).toBeGreaterThan(20);
      expect(d.description.length, d.name).toBeLessThanOrEqual(240);
      expect((d.keywords || []).length, d.name).toBeGreaterThan(2);
      const w = whereOf(d);
      expect(w.route.startsWith("/"), d.name).toBe(true);
      expect(w.label.length, d.name).toBeGreaterThan(3);
      expect(w.anchor, `${d.name} has no anchor`).toBeTruthy();
    }
  });

  it("EVERY registry anchor is rendered somewhere as a data-action", () => {
    const rendered = renderedAnchors();
    expect(rendered.size).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const d of ALL_ACTIONS) {
      const anchors = new Set<string>();
      const add = (w: Where) => { if (w.anchor) anchors.add(w.anchor); };
      add(whereOf(d));
      // Function `where`s vary by args — probe the arg shapes the tools use.
      if (typeof d.where === "function") {
        for (const probe of [{ tab: "audio" }, { sub: "animate" }, { lane: "animate" }]) {
          try { add((d.where as (a: never) => Where)(probe as never)); } catch { /* ignore */ }
        }
      }
      for (const a of anchors) if (!rendered.has(a)) missing.push(`${d.name}: ${a}`);
    }
    expect(missing, `unrendered anchors:\n${missing.join("\n")}`).toEqual([]);
  });
});

describe("walkTo", () => {
  it("navigates to the feature and pulses its anchor", async () => {
    const f = makeFakeContext();
    const def = FEATURES.find((d) => d.name === "go_to_settings")!;
    const res = await def.execute({}, f.ctx);
    f.restore();
    expect(res.ok).toBe(true);
    expect(f.rec.nav).toEqual(["/settings"]);
    expect(f.rec.anchors()).toContain(ANCHORS.navSettings);
  });

  it("fills :pid and :sid from where the human is", async () => {
    const f = makeFakeContext();
    await f.ctx.page.waitFor("shot", { sid: "B10-S2" });
    const def = FEATURES.find((d) => d.name === "cel_opacity")!;
    const res = await def.execute({}, f.ctx);
    f.restore();
    expect(res.ok).toBe(true);
    expect(f.rec.nav[0]).toBe("/p/next-year/shot/B10-S2?tab=compose");
    expect(f.rec.anchors()).toContain(ANCHORS.compLayerOpacity);
  });

  it("asks for a shot instead of guessing when none is open", async () => {
    const f = makeFakeContext();
    const def = FEATURES.find((d) => d.name === "cel_opacity")!;
    const res = await def.execute({}, f.ctx);
    f.restore();
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("needs_shot");
  });

  it("says so when there is no project at all", async () => {
    const f = makeFakeContext({ project: null });
    const def = FEATURES.find((d) => d.name === "go_to_film_editor")!;
    const res = await def.execute({}, f.ctx);
    f.restore();
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("no_project");
  });

  it("never throws, whatever it is handed", async () => {
    const f = makeFakeContext();
    for (const d of FEATURES) {
      const res = await d.execute({ nonsense: true } as never, f.ctx);
      expect(res, d.name).toHaveProperty("ok");
    }
    f.restore();
  });
});
