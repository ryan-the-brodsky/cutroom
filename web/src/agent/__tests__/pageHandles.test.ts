import { describe, expect, it } from "vitest";
import type { FilmPageHandles, ShotPageHandles } from "../contract";
import { __setHandles, currentHandles, pageHandles, waitForHandles } from "../pageHandles";

const shot = (sid: string): ShotPageHandles => ({
  kind: "shot", pid: "next-year", sid,
  getState: () => ({
    tab: "compose", sub: "still", kindFilter: "all",
    selected: null, activeSource: null, keeper: null, takes: [],
  }),
  setTab: () => {}, setSub: () => {}, setKindFilter: () => {}, selectTake: () => {},
  setGenField: () => {},
  submitGenerate: async () => ({ job: "j1" }),
  setLive: () => {},
  submitFreeze: async () => ({ job: "j2" }),
  submitTrim: async () => ({ job: "j3" }),
  setVoField: () => {},
  submitVo: async () => ({ job: "j4" }),
  setKeeper: async () => {}, setSource: async () => {}, setOverride: async () => {},
  direct: async () => ({}), applyPlan: async () => ({ results: [] }),
  refresh: async () => {},
});

const film = (): FilmPageHandles => ({
  kind: "film", pid: "next-year",
  getState: () => ({ selected: null, scope: "full", res: "720", shots: [] }),
  selectShot: () => {}, setScope: () => {}, setRes: () => {},
  cutFilm: async () => ({ job: "c1" }),
  setOverride: async () => {}, refresh: async () => {},
});

describe("pageHandles", () => {
  it("resolves immediately when the matching page is already mounted", async () => {
    const off = __setHandles(shot("B10-S2"));
    const h = await waitForHandles("shot", { sid: "B10-S2" }, 100);
    expect((h as ShotPageHandles).sid).toBe("B10-S2");
    off();
  });

  it("matches sid case-insensitively", async () => {
    const off = __setHandles(shot("B10-S2"));
    await expect(waitForHandles("shot", { sid: "b10-s2" }, 100)).resolves.toBeTruthy();
    off();
  });

  it("resolves when the page mounts later", async () => {
    const p = waitForHandles("shot", { sid: "B04-S3" }, 1000);
    setTimeout(() => __setHandles(shot("B04-S3")), 20);
    await expect(p).resolves.toBeTruthy();
    __setHandles(null);
  });

  it("rejects with a usable message after the timeout", async () => {
    await expect(waitForHandles("shot", { sid: "NOPE" }, 60))
      .rejects.toThrow(/page did not mount: shot NOPE/);
  });

  it("does not resolve on the wrong shot", async () => {
    const off = __setHandles(shot("B01-S1"));
    await expect(waitForHandles("shot", { sid: "B10-S2" }, 60)).rejects.toThrow(/did not mount/);
    off();
  });

  it("does not resolve on the wrong kind", async () => {
    const off = __setHandles(film());
    await expect(waitForHandles("shot", { sid: "B10-S2" }, 60)).rejects.toThrow(/did not mount/);
    off();
  });

  it("waits for the film page with no match object", async () => {
    const off = __setHandles(film());
    const h = await waitForHandles("film", undefined, 100);
    expect(h.kind).toBe("film");
    off();
  });

  it("exposes the current handles through the ctx.page façade", async () => {
    expect(currentHandles()).toBeNull();
    const off = __setHandles(film());
    expect(pageHandles.current()?.kind).toBe("film");
    await expect(pageHandles.waitFor("film", undefined, 100)).resolves.toBeTruthy();
    off();
    expect(pageHandles.current()).toBeNull();
  });

  it("un-installing restores the previous page", () => {
    const offA = __setHandles(shot("A"));
    const offB = __setHandles(shot("B"));
    expect((currentHandles() as ShotPageHandles).sid).toBe("B");
    offB();
    expect((currentHandles() as ShotPageHandles).sid).toBe("A");
    offA();
    expect(currentHandles()).toBeNull();
  });
});
