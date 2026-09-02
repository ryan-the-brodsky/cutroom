import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../../agent/__tests__/_env";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, api: vi.fn(), getToken: vi.fn() };
});
import * as apiMod from "../../api";
import AccessGate from "../AccessGate";

describe("AccessGate", () => {
  beforeEach(() => { vi.clearAllMocks(); });

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
});
