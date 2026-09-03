/**
 * `move_audio` — the Timeline's drag, asked for in words.
 *
 * The arithmetic that turns a landing spot into `vo_offset` or a cue placement is
 * tested in `timeline/__tests__/audioMoves.test.ts`; what matters here is the tool's
 * half of the bargain: it opens the Timeline, moves ONE named thing, and says what it
 * still sits under — an agent that cannot see the lanes has only this sentence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_BASE } from "../../../routes";
import { ANCHORS } from "../../contract";
import type { ToolErr, ToolOk } from "../../contract";
import { makeFakeContext, type FakeContext } from "../fakeContext";
import { moveAudio } from "../timing";
import { NEXT_CUT_FILM } from "../util";

let f: FakeContext;
beforeEach(() => { f = makeFakeContext(); });
afterEach(() => { f.restore(); });

const asOk = (r: unknown) => r as ToolOk;
const asErr = (r: unknown) => r as ToolErr;

describe("move_audio", () => {
  it("opens the Timeline and slides a shot's VO to an absolute time", async () => {
    const r = asOk(await moveAudio.execute({ target: "B10-S2", at: 2.5 }, f.ctx));

    expect(r.ok).toBe(true);
    expect(f.rec.nav).toEqual([`${APP_BASE}/p/next-year/timeline`]);
    expect(f.rec.calls()).toContain("timeline.moveAudio(B10-S2,at=2.5)");
    expect(r.moved).toBe("B10-S2 vo");
    expect(r.from).toBe(0.3);
    expect(r.to).toBe(2.5);
    expect(r.shot).toBe("B10-S2");
    expect(r.vo_offset).toBe(2.2);            // seconds after the shot's head pad
    expect(String(r.summary)).toMatch(/0:02.50/);
    expect(f.rec.anchors()).toContain(ANCHORS.timelineAudioDrag);
    expect(r.next).toBe(NEXT_CUT_FILM);
  });

  it("slides a cue by a delta and names what it still overlaps", async () => {
    // The SFX cue sits at 1.5s; the VO runs 0.3s–2.3s, so a nudge leaves it under.
    const r = asOk(await moveAudio.execute({ target: "cue_door77", delta: 0.5 }, f.ctx));

    expect(f.rec.calls()).toContain("timeline.moveAudio(cue_door77,delta=0.5)");
    expect(r.to).toBe(2);
    expect(r.cue).toBe("cue_door77");
    expect(r.overlaps).toEqual(["B10-S2 vo 0:00.30–0:02.30"]);
    expect(String(r.summary)).toMatch(/still under B10-S2 vo/);
  });

  it("says it is clear once the cue is off the line", async () => {
    const r = asOk(await moveAudio.execute({ target: "door.mp3", at: 6 }, f.ctx));
    expect(r.overlaps).toBe("none");
    expect(String(r.summary)).toMatch(/clear of the other audio/);
  });

  it("asks for a place rather than guessing one", async () => {
    const r = asErr(await moveAudio.execute({ target: "B10-S2" }, f.ctx));
    expect(r.error).toBe("needs_place");
    expect(f.rec.nav).toEqual([]);            // nothing moved, nothing opened
  });

  it("hands back the roster when the target matches nothing", async () => {
    const r = asErr(await moveAudio.execute({ target: "trombone", at: 1 }, f.ctx));
    expect(r.error).toBe("no_such_audio");
    expect(r.candidates).toEqual(["B10-S2 vo", "sfx:door.mp3"]);
  });

  it("reports a refused write instead of claiming the move", async () => {
    f.timelinePage.moveFails = "shot B10-S2 is locked";
    const r = asErr(await moveAudio.execute({ target: "B10-S2", at: 1 }, f.ctx));
    expect(r.error).toBe("move_failed");
    expect(String(r.hint)).toContain("locked");
  });
});
