import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "../../agent/__tests__/_env";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, api: vi.fn().mockRejectedValue(new Error("401")) };
});
vi.mock("../../agent/webmcp", () => ({ subscribeAgentStatus: () => () => {} }));

import { resetPublicConfig } from "../../publicConfig";
import LandingPage from "../LandingPage";

const FILM = { url: "/api/public/film.mp4", label: "Two Claudes", seconds: 129.9 };

/** The landing page renders for strangers, so everything it offers comes from here. */
function stubPublic(body: Record<string, unknown>) {
  resetPublicConfig();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    { ok: true, status: 200, headers: new Headers(), json: async () => body }));
}

const view = () => render(<MemoryRouter><LandingPage /></MemoryRouter>);

describe("LandingPage · the public path", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("plays the public cut when there is no token to fetch one with", async () => {
    stubPublic({ access_form_url: "", video_url: "", film: FILM });
    view();
    const play = await screen.findByRole("button", { name: /Play the latest cut/ });
    expect(play).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watch the film" })).toBeTruthy();
  });

  it("renders no request-access button until the owner sets the form", async () => {
    stubPublic({ access_form_url: "", video_url: "", film: FILM });
    view();
    await screen.findByRole("button", { name: "Watch the film" });
    // no dead button, and no href=""
    expect(screen.queryByRole("link", { name: "Request access" })).toBeNull();
    expect(screen.getByText(/invite-only while the demo is live/)).toBeTruthy();
  });

  it("offers the form in the hero, the close and the footer once it is set", async () => {
    stubPublic({ access_form_url: "https://forms.gle/abc", video_url: "", film: FILM });
    view();
    const links = await screen.findAllByRole("link", { name: "Request access" });
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe("https://forms.gle/abc");
      expect(a.getAttribute("target")).toBe("_blank");
    }
    expect(screen.getByText(/ask for a key/)).toBeTruthy();
  });

  it("embeds the walkthrough with the no-cookie host", async () => {
    stubPublic({ access_form_url: "", film: FILM,
                 video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const { container } = view();
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    expect(container.querySelector("iframe")!.getAttribute("src"))
      .toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    const link = screen.getByRole("link", { name: /Watch the 3-minute demo/ });
    expect(link.getAttribute("href"))
      .toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("shows no video controls at all when the walkthrough is unrecorded", async () => {
    stubPublic({ access_form_url: "", video_url: "", film: FILM });
    const { container } = view();
    await screen.findByRole("button", { name: "Watch the film" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByText(/3-minute demo/)).toBeNull();
  });
});
