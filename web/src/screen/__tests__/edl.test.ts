import { describe, expect, it } from "vitest";
import type { Chapter } from "../../agent/contract";
import {
  chapterAt, chapterIndexAt, chapterOf, mmss, parseFrom, parseTime,
  stepChapter, totalOf,
} from "../edl";

/** Three shots, 4s + 3s + 5s. Acts: B01 is act 1, B03 is act 2. */
const CH: Chapter[] = [
  { sid: "B01-S1", start: 0, seconds: 4 },
  { sid: "B01-S2", start: 4, seconds: 3 },
  { sid: "B03-S2", start: 7, seconds: 5 },
];
const ACT_OF = (sid: string) => (sid.startsWith("B01") ? 1 : 2);

describe("chapterAt", () => {
  it("finds the shot on screen at a second", () => {
    expect(chapterAt(CH, 0)?.sid).toBe("B01-S1");
    expect(chapterAt(CH, 3.9)?.sid).toBe("B01-S1");
    expect(chapterAt(CH, 4)?.sid).toBe("B01-S2");
    expect(chapterAt(CH, 6.99)?.sid).toBe("B01-S2");
    expect(chapterAt(CH, 7)?.sid).toBe("B03-S2");
  });

  it("clamps: before the head is the first shot, past the tail is the last", () => {
    expect(chapterAt(CH, -10)?.sid).toBe("B01-S1");
    expect(chapterAt(CH, 900)?.sid).toBe("B03-S2");
    expect(chapterAt([], 3)).toBeNull();
  });

  it("indexes and steps without running off either end", () => {
    expect(chapterIndexAt(CH, 5)).toBe(1);
    expect(stepChapter(CH, 5, 1)?.sid).toBe("B03-S2");
    expect(stepChapter(CH, 5, -1)?.sid).toBe("B01-S1");
    expect(stepChapter(CH, 0, -1)?.sid).toBe("B01-S1");
    expect(stepChapter(CH, 9, 1)?.sid).toBe("B03-S2");
  });

  it("totals the cut and finds a shot by sid", () => {
    expect(totalOf(CH)).toBe(12);
    expect(chapterOf(CH, "b03-s2")?.start).toBe(7);
    expect(chapterOf(CH, "B99-S9")).toBeNull();
  });
});

describe("parseTime", () => {
  it("reads clocks and bare seconds", () => {
    expect(parseTime(65)).toBe(65);
    expect(parseTime("65")).toBe(65);
    expect(parseTime("1:05")).toBe(65);
    expect(parseTime("0:02")).toBe(2);
    expect(parseTime("1:02:03")).toBe(3723);
    expect(parseTime("2.5")).toBe(2.5);
    expect(parseTime("12s")).toBe(12);
  });

  it("is not fooled by a sid or a description", () => {
    expect(parseTime("B03-S2")).toBeNull();
    expect(parseTime("the lighthouses")).toBeNull();
    expect(parseTime("")).toBeNull();
  });
});

describe("the `from` grammar", () => {
  it("takes seconds, either as a number or a string", () => {
    expect(parseFrom(5, CH)).toMatchObject({ seconds: 5, sid: "B01-S2" });
    expect(parseFrom("5", CH)).toMatchObject({ seconds: 5, sid: "B01-S2" });
  });

  it("takes mm:ss", () => {
    const long: Chapter[] = [{ sid: "B01-S1", start: 0, seconds: 200 }];
    expect(parseFrom("1:05", long)?.seconds).toBe(65);
  });

  it("takes a shot sid, in any case and with loose punctuation", () => {
    expect(parseFrom("B03-S2", CH)).toMatchObject({ seconds: 7, sid: "B03-S2" });
    expect(parseFrom("b03-s2", CH)?.seconds).toBe(7);
    expect(parseFrom("B03S2", CH)?.seconds).toBe(7);
  });

  it("takes an act, when it is told which shot is in which act", () => {
    expect(parseFrom("act2", CH, { actOf: ACT_OF })).toMatchObject({
      seconds: 7, sid: "B03-S2",
    });
    expect(parseFrom("act 1", CH, { actOf: ACT_OF })?.seconds).toBe(0);
    // An act nobody shot is not silently the top.
    expect(parseFrom("act4", CH, { actOf: ACT_OF })).toBeNull();
    // No act map: not this helper's job to guess.
    expect(parseFrom("act2", CH)).toBeNull();
  });

  it("takes the head and the tail", () => {
    expect(parseFrom("start", CH)?.seconds).toBe(0);
    expect(parseFrom("the top", CH)?.seconds).toBe(0);
    expect(parseFrom("end", CH, { duration: 12 })?.seconds).toBe(7);
  });

  it("clamps a second past the end back inside the cut", () => {
    expect(parseFrom(999, CH)?.seconds).toBeCloseTo(11.95, 2);
  });

  it("hands a description back to the caller rather than guessing", () => {
    expect(parseFrom("the lighthouses", CH)).toBeNull();
    expect(parseFrom(undefined, CH)).toBeNull();
    expect(parseFrom("", CH)).toBeNull();
  });
});

describe("mmss", () => {
  it("reads the way a time readout does", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(65)).toBe("1:05");
    expect(mmss(9.9)).toBe("0:09");
  });
});
