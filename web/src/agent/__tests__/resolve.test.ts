/**
 * Resolver pins, against a recorded slice of the REAL `next-year` film.
 *
 * The fixtures are `GET /api/projects/next-year/film` and `…/cast` from a
 * scratch server booted off the demo bundle (97 shots, 17 cast members), so
 * every expectation here is a claim about the actual production data, not a
 * toy. Regenerate with:
 *
 *   CUTROOM_DATA=/tmp/cutroom-B/data cutroom --port 8782      # + import
 *   curl -s localhost:8782/api/projects/next-year/film > film.json
 */
import { describe, expect, it, beforeEach } from "vitest";

import castFixture from "./fixtures/next-year.cast.json";
import sanitizedFilm from "./fixtures/next-year.film.json";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// The committed fixture is SANITIZED (prompts shortened, dialogue text removed) so the
// film's script never lands in the public repo. The full recording lives in the private
// game7 repo (prompts/fixtures/next-year.film.json) or at $CUTROOM_FILM_FIXTURE; the
// real-data pins below run only when it is present.
const FULL_PATH = process.env.CUTROOM_FILM_FIXTURE
  ?? resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../../prompts/fixtures/next-year.film.json");
const HAS_FULL = existsSync(FULL_PATH);
const filmFixture: typeof sanitizedFilm = HAS_FULL
  ? JSON.parse(readFileSync(FULL_PATH, "utf8"))
  : sanitizedFilm;
const itFull = HAS_FULL ? it : it.skip;
import {
  clearIndexCache, indexShots, makeResolver, normalizeSid, resolveAgainst,
  subjectClause, summarize, type CastMember, type FilmEntry,
} from "../resolve";

const film = filmFixture as unknown as FilmEntry[];
const cast = castFixture as unknown as CastMember[];
const shots = indexShots(film, cast);
const ask = (q: string) => resolveAgainst(shots, cast, q);

describe("index", () => {
  it("derives 1-based film ordinals", () => {
    expect(shots).toHaveLength(97);
    expect(shots[0].ordinal).toBe(1);
    expect(shots.find((s) => s.ordinal === 37)!.sid).toBe("B11-S4");
    expect(shots.find((s) => s.sid === "B10-S2")!.ordinal).toBe(31);
  });

  it("summarises the subject clause and caps at 90 chars", () => {
    for (const s of shots) expect(s.summary.length).toBeLessThanOrEqual(90);
    expect(summarize("scene stuff. Subject: a catcher in the dugout"))
      .toBe("a catcher in the dugout");
    expect(subjectClause("wide setting, low angle. A veteran catcher waits."))
      .toBe("A veteran catcher waits.");
  });

  itFull("attaches cast from the subject clause and from dialogue speakers", () => {
    const b10s2 = shots.find((s) => s.sid === "B10-S2")!;
    expect(b10s2.characters).toContain("David Ross");
    const b10s1 = shots.find((s) => s.sid === "B10-S1")!;   // speaker only
    expect(b10s1.characters).toContain("David Ross");
  });

  it("reports keeper / motion / what plays", () => {
    const withKeeper = shots.filter((s) => s.has_keeper);
    expect(withKeeper.length).toBeGreaterThan(0);
    expect(shots.filter((s) => s.has_motion).length).toBeGreaterThan(0);
    expect(shots.filter((s) => s.plays).length).toBeGreaterThan(0);
  });

  it("normalises every way a human types a sid", () => {
    for (const q of ["B10-S2", "b10-s2", "B10 S2", "b10s2", "B10_S2"]) {
      expect(normalizeSid(q)).toBe("B10-S2");
    }
    expect(normalizeSid("shot 37")).toBeNull();
  });
});

describe("resolve", () => {
  it("'B10-S2' is exact", () => {
    const r = ask("B10-S2");
    expect(r.best!.sid).toBe("B10-S2");
    expect(r.confidence).toBe("exact");
  });

  it("lowercase and spaced sids are exact too", () => {
    expect(ask("b10s2").best!.sid).toBe("B10-S2");
    expect(ask("open B10 S2 please").confidence).toBe("exact");
  });

  it("'37' is the 37th shot in film order — B11-S4", () => {
    for (const q of ["37", "#37", "shot 37", "the 37th"]) {
      const r = ask(q);
      expect(r.best!.sid, q).toBe("B11-S4");
      expect(r.best!.ordinal).toBe(37);
    }
  });

  itFull("'the David Ross close-up' is B10-S2, confidently", () => {
    const r = ask("the David Ross close-up");
    expect(r.best!.sid).toBe("B10-S2");
    expect(r.confidence).toBe("high");
    expect(r.candidates[0].why).toMatch(/David Ross/);
    expect(r.candidates.length).toBeLessThanOrEqual(8);
  });

  itFull("the hero sentence resolves the same way", () => {
    const r = ask("make a few more generative cuts of the David Ross close-up");
    expect(r.best!.sid).toBe("B10-S2");
  });

  it("'David Ross close up, shot 37' is ambiguous, and says both", () => {
    const r = ask("David Ross close up, shot 37");
    expect(r.confidence).toBe("ambiguous");
    const sids = r.candidates.map((c) => c.sid);
    expect(sids).toContain("B11-S4");     // the ordinal reading
    expect(sids).toContain("B10-S2");     // the description reading
  });

  it("beats collect their shots", () => {
    const r = ask("beat 10");
    expect(r.candidates.every((c) => c.beat === "B10" || c.score < 300)).toBe(true);
    expect(r.candidates.map((c) => c.sid)).toContain("B10-S1");
  });

  itFull("'dial shot' resolves to B20-S2 (recorded from the real film)", () => {
    // Free text with no sid, ordinal, beat or cast name: pure term overlap.
    // The radio dial is the film's recurring warm accent, so 24 shots mention
    // it; B20-S2 (the rain-delay HERO, "dial" ×13) wins on term frequency
    // ahead of B04-S3's dial macro (×8). Pinned so the ranking cannot drift.
    const r = ask("dial shot");
    expect(r.best!.sid).toBe("B20-S2");
    expect(r.candidates.map((c) => c.sid)).toContain("B04-S3");
    expect(ask("dial shot").best!.sid).toBe(r.best!.sid);   // stable
  });

  it("free text that matches nothing resolves to none", () => {
    const r = ask("zzzz quokka submarine");
    expect(r.confidence).toBe("none");
    expect(r.best).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it("candidates carry a score and a reason, best first", () => {
    const r = ask("the veteran catcher in the dugout");
    expect(r.candidates.length).toBeGreaterThan(1);
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1].score).toBeGreaterThanOrEqual(r.candidates[i].score);
    }
    expect(r.candidates[0].why.length).toBeGreaterThan(0);
  });
});

describe("makeResolver", () => {
  beforeEach(() => clearIndexCache());

  it("fetches film + cast once, then serves from cache until forced", async () => {
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path.endsWith("/film")) return film as never;
      return { cast } as never;
    };
    const r = makeResolver(api as never);
    expect((await r.index("next-year"))).toHaveLength(97);
    await r.resolve("next-year", "37");
    expect(calls).toHaveLength(2);
    await r.index("next-year", { force: true });
    expect(calls).toHaveLength(4);
  });

  it("survives a project with no cast route", async () => {
    const api = async (path: string) => {
      if (path.endsWith("/film")) return film as never;
      throw new Error("404");
    };
    const r = makeResolver(api as never);
    const res = await r.resolve("next-year", "37");
    expect(res.best!.sid).toBe("B11-S4");
  });
});
