/**
 * "Cut the film" has to LOOK like it did something.
 *
 * The product complaint this covers: the button fired the job and said nothing,
 * so a cut that was quietly dying on "No space left on device" was
 * indistinguishable from a dead button. These tests hold the visible contract —
 * queued → cutting → cut ready · open, and ffmpeg's own last word on a failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../agent/__tests__/_env";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, api: vi.fn() };
});
import * as apiMod from "../../api";
import CutFilm, { failureLine, useCutFilm } from "../CutFilm";

const PID = "next-year";
const now = () => Date.now() / 1000;

function Harness() {
  const cut = useCutFilm({ pid: PID, params: { scope: "act1", res: "1080" },
                           pollMs: 5 });
  return <CutFilm cut={cut} anchor="film.cut" />;
}

/** Serve POST /animatic, then GET /jobs/{id} from a scripted queue. */
function serve(job: string, states: Record<string, unknown>[],
               log: string[] = []) {
  const queue = [...states];
  (apiMod.api as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (path: string) => {
      if (path.endsWith("/animatic")) return { job };
      if (path.endsWith("/log?tail=200")) return { status: "failed", lines: log };
      if (path === `/api/jobs/${job}`) {
        return queue.length > 1 ? queue.shift()! : queue[0];
      }
      throw new Error(`unexpected ${path}`);
    });
}

describe("cut the film", () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

  it("submits the page's scope and res, then follows the job to the cut", async () => {
    serve("j1", [
      { id: "j1", status: "running", started_at: now() - 3, created_at: now() - 4 },
      { id: "j1", status: "done", started_at: now() - 9, finished_at: now(),
        result: { take: "assembly/animatic-act1-1080p.mp4", total: 42 } },
    ]);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("cut-film"));

    await waitFor(() => expect(screen.getByTestId("cut-status")).toBeTruthy());
    expect((apiMod.api as any).mock.calls[0]).toEqual([
      `/api/projects/${PID}/animatic`, { res: "1080", scope: "act1" },
    ]);
    // the running job reads as work in progress, with a clock
    await waitFor(() =>
      expect(screen.getByTestId("cut-status").textContent).toMatch(/cutting…\s*\d+:\d\d/));
    // …and then as something to watch
    await waitFor(() =>
      expect(screen.getByTestId("cut-status").textContent).toMatch(/cut ready/));
    expect(screen.getByTestId("cut-open")).toBeTruthy();
    expect(screen.getByTestId("cut-status").getAttribute("data-phase")).toBe("done");
  });

  it("remembers the job across a reload and picks the poll back up", async () => {
    localStorage.setItem(`cutroom_cut_job:${PID}`,
                         JSON.stringify({ job: "j3", at: Date.now() - 4000 }));
    serve("j3", [{ id: "j3", status: "running", started_at: now() - 4 }]);
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByTestId("cut-status").textContent).toMatch(/cutting…/));
    expect((apiMod.api as any).mock.calls[0][0]).toBe("/api/jobs/j3");
  });

  it("shows ffmpeg's own last word when the cut fails", async () => {
    serve("j2", [{
      id: "j2", status: "failed", started_at: now() - 8, finished_at: now(),
      error: "FFmpegError: ffmpeg -v error -y -i /tmp/x failed",
    }], [
      "[out#0/mp4] Error muxing a packet",
      "[out#0/mp4] Error closing file: No space left on device",
      "", "",
    ]);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("cut-film"));
    await waitFor(() =>
      expect(screen.getByTestId("cut-status").textContent).toMatch(/cut failed/));
    expect(screen.getByTestId("cut-status").textContent)
      .toMatch(/No space left on device/);
    // and the whole log is one click away
    fireEvent.click(screen.getByTestId("cut-log"));
    await waitFor(() =>
      expect(screen.getByText(/Error muxing a packet/)).toBeTruthy());
  });

  it("says so when the server refuses the cut outright", async () => {
    (apiMod.api as any).mockRejectedValue(new apiMod.ApiError(422, "no shots in scope act1"));
    render(<Harness />);
    fireEvent.click(screen.getByTestId("cut-film"));
    await waitFor(() =>
      expect(screen.getByTestId("cut-status").textContent).toMatch(/no shots in scope/));
    expect(localStorage.getItem(`cutroom_cut_job:${PID}`)).toBeNull();
  });
});

describe("failureLine", () => {
  it("takes the last real line of the log, skipping ffmpeg's repeat notice", () => {
    expect(failureLine([
      "Error muxing a packet",
      "No space left on device",
      "    Last message repeated 1 times",
      "",
    ])).toBe("No space left on device");
  });

  it("falls back to the job error when nothing was logged", () => {
    expect(failureLine([], "Traceback…\nRuntimeError: no shots in scope act4"))
      .toBe("RuntimeError: no shots in scope act4");
  });

  it("has nothing to say when there is nothing to say", () => {
    expect(failureLine([], null)).toBeNull();
  });
});
