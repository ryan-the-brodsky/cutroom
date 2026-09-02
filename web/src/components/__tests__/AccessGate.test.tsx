import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../../agent/__tests__/_env";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, api: vi.fn(), getToken: vi.fn() };
});
import * as apiMod from "../../api";
import { resetPublicConfig } from "../../publicConfig";
import AccessGate from "../AccessGate";

/** The gate renders before auth, so its extra links come from `/api/public`. */
function stubPublic(body: Record<string, unknown>) {
  resetPublicConfig();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

describe("AccessGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubPublic({ access_form_url: "", video_url: "", film: null });
  });

  it("locks the studio when there is no token", () => {
    (apiMod.getToken as any).mockReturnValue("");
    render(<AccessGate><div>studio</div></AccessGate>);
    expect(screen.getByText(/invite-only/)).toBeTruthy();
    expect(screen.queryByText("studio")).toBeNull();
  });

  it("locks on a 401 even with a stale token", async () => {
    (apiMod.getToken as any).mockReturnValue("stale");
    (apiMod.api as any).mockRejectedValue(new apiMod.ApiError(401, "missing or invalid token"));
    render(<AccessGate><div>studio</div></AccessGate>);
    await waitFor(() => expect(screen.getByText(/invite-only/)).toBeTruthy());
  });

  it("renders the studio when the token works", async () => {
    (apiMod.getToken as any).mockReturnValue("good");
    (apiMod.api as any).mockResolvedValue({ ok: true });
    render(<AccessGate><div>studio</div></AccessGate>);
    await waitFor(() => expect(screen.getByText("studio")).toBeTruthy());
  });

  it("is never a dead end: the film is always one link away", () => {
    (apiMod.getToken as any).mockReturnValue("");
    render(<AccessGate><div>studio</div></AccessGate>);
    const back = screen.getByText(/Watch the film on the front page/);
    expect(back.getAttribute("href")).toBe("/");
  });

  it("offers the access form once the owner has set one", async () => {
    stubPublic({ access_form_url: "https://forms.gle/abc", video_url: "", film: null });
    (apiMod.getToken as any).mockReturnValue("");
    render(<AccessGate><div>studio</div></AccessGate>);
    const link = await screen.findByText("Request access");
    expect(link.getAttribute("href")).toBe("https://forms.gle/abc");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows no request-access link while the form is unset", async () => {
    (apiMod.getToken as any).mockReturnValue("");
    render(<AccessGate><div>studio</div></AccessGate>);
    await waitFor(() => expect(screen.queryByText("Request access")).toBeNull());
  });
});
