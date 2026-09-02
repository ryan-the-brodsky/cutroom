/**
 * Lanes, backends, export and the engine render (workstream I).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ANCHORS } from "../../contract";
import { exportTimeline, listBackends, renderTimeline, setLaneDefault } from "../settings";
import { makeFakeContext } from "../fakeContext";

type Fake = ReturnType<typeof makeFakeContext>;
let f: Fake;

const asOk = (r: { ok: boolean } & Record<string, unknown>) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as { ok: true; summary: string } & Record<string, unknown>;
};
const asErr = (r: { ok: boolean } & Record<string, unknown>) => {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  return r as { ok: false; error: string; hint?: string };
};

/** An ApiError-shaped rejection, the way `web/src/api.ts` throws one. */
const httpError = (status: number, detail: string) =>
  Object.assign(new Error(detail), { status });

beforeEach(() => { f = makeFakeContext(); });

// ---------------------------------------------------------------- list_backends

describe("list_backends", () => {
  it("reads without navigating and classifies cost", async () => {
    const r = asOk(await listBackends.execute({}, f.ctx));
    expect(f.rec.nav).toEqual([]);
    const rows = r.backends as { id: string; cost_class: string; cost_usd?: number }[];
    expect(rows.find((b) => b.id === "mock")!.cost_class).toBe("free");
    const fal = rows.find((b) => b.id === "fal")!;
    expect(fal.cost_class).toBe("paid");
    expect(fal.cost_usd).toBe(0.2);
  });

  it("reports the project's lane defaults alongside", async () => {
    const r = asOk(await listBackends.execute({}, f.ctx));
    expect(r.lane_defaults).toMatchObject({ still: "mock", motion: "mock" });
  });

  it("returns an envelope, not a throw, when the server is unreachable", async () => {
    const broken = makeFakeContext({
      api: () => { throw httpError(500, "boom"); },
    });
    const r = asErr(await listBackends.execute({}, broken.ctx));
    expect(r.error).toBe("backends_unavailable");
    broken.restore();
  });
});

// ---------------------------------------------------------------- set_lane_default

describe("set_lane_default", () => {
  it("opens Settings, writes the lane and pulses the row", async () => {
    const r = asOk(await setLaneDefault.execute({ lane: "motion", backend: "fal" }, f.ctx));
    expect(f.rec.nav).toEqual(["/settings"]);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.settingsLane, ANCHORS.settingsLaneSave,
    ]));
    const post = f.rec.api.find((c) => c.path.endsWith("/lanes") && c.body)!;
    expect(post.body).toMatchObject({ lane: "motion", backend: "fal" });
    expect(r.lane).toBe("motion");
  });

  it("rejects an unknown lane and an unknown backend before writing", async () => {
    expect(asErr(await setLaneDefault.execute(
      { lane: "colour", backend: "mock" }, f.ctx)).error).toBe("unknown_lane");
    const r = asErr(await setLaneDefault.execute({ lane: "still", backend: "nope" }, f.ctx));
    expect(r.error).toBe("backend_not_found");
    expect(r.hint).toContain("mock");
    expect(f.rec.api.some((c) => c.path.endsWith("/lanes") && c.body)).toBe(false);
  });

  it("refuses a backend that does not serve the lane", async () => {
    const r = asErr(await setLaneDefault.execute({ lane: "vo", backend: "fal" }, f.ctx));
    expect(r.error).toBe("backend_wrong_lane");
    expect(r.hint).toContain("motion");
  });

  it("relays the server's 403 text verbatim on a locked-down demo", async () => {
    const demo = makeFakeContext({
      api: (path, body) => {
        if (path.endsWith("/lanes") && body !== undefined) {
          throw httpError(403, "editing lane defaults is admin-only on this demo");
        }
        if (path === "/api/backends") {
          return [{ id: "mock", type: "mock", enabled: true, lanes: ["still", "motion"] }];
        }
        return {};
      },
    });
    const r = asErr(await setLaneDefault.execute({ lane: "still", backend: "mock" }, demo.ctx));
    expect(r.error).toBe("forbidden");
    expect(r.hint).toBe("editing lane defaults is admin-only on this demo");
    demo.restore();
  });
});

// ---------------------------------------------------------------- export_timeline

describe("export_timeline", () => {
  it("returns the OTIO url with a preview and an event count", async () => {
    const r = asOk(await exportTimeline.execute({ format: "otio" }, f.ctx));
    expect(r.url).toBe("/api/projects/next-year/timeline/otio");
    expect(r.format).toBe("otio");
    expect(r.events).toBe(2);
    expect(String(r.preview).length).toBeLessThanOrEqual(300);
    expect(f.rec.nav).toEqual([]);
  });

  it("still hands back a working URL when the body cannot be read here", async () => {
    const noPreview = makeFakeContext({
      api: (path) => { if (path.includes("/timeline/")) throw new Error("not json"); return {}; },
    });
    const r = asOk(await exportTimeline.execute({ format: "edl" }, noPreview.ctx));
    expect(r.url).toBe("/api/projects/next-year/timeline/edl");
    expect(r.preview).toBeNull();
    noPreview.restore();
  });

  it("needs a project", async () => {
    const none = makeFakeContext({ project: null });
    expect(asErr(await exportTimeline.execute({}, none.ctx)).error).toBe("no_project");
    none.restore();
  });
});

// ---------------------------------------------------------------- render_timeline

describe("render_timeline", () => {
  it("opens the Timeline, submits and returns the job", async () => {
    const r = asOk(await renderTimeline.execute({ scope_sec: 12 }, f.ctx));
    expect(f.rec.nav).toEqual(["/p/next-year/timeline"]);
    expect(f.rec.anchors()).toEqual(expect.arrayContaining([
      ANCHORS.timelineScope, ANCHORS.timelineRender,
    ]));
    expect(r.jobs).toEqual(["job-engine-1"]);
    expect(r.scope_sec).toBe(12);
  });

  it("answers \"engine offline\" cleanly on a 503", async () => {
    const offline = makeFakeContext({
      api: (path) => {
        if (path.endsWith("/timeline/render")) {
          throw httpError(503, "render engine unavailable (set CUTROOM_ENGINE_DIR)");
        }
        return {};
      },
    });
    const r = asErr(await renderTimeline.execute({}, offline.ctx));
    expect(r.error).toBe("engine offline");
    expect(r.hint).toContain("cut_film");
    offline.restore();
  });
});
