/**
 * Settings, read two ways (workstream T).
 *
 * The load-bearing assertions are what a viewer must NOT get: no add/edit/delete, no
 * options JSON, no engine vocabulary. Everything else is the same page for both roles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../../agent/__tests__/_env";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, api: vi.fn(), getToken: () => "judge", setToken: vi.fn() };
});
import * as apiMod from "../../api";
import SettingsPage from "../SettingsPage";

const PID = "next-year";
let role: "admin" | "viewer" = "viewer";

const BACKENDS = [
  { id: "fal", type: "fal", label: "fal.ai", base_url: "", enabled: true,
    lanes: ["motion"], api_key_set: true, api_key_hint: "fa…9c",
    options: { cost_usd: 0.2, model: "wan" },
    motion_profile: { model: "wan" },
    motion_profile_summary: "5s clips (max 5s) at 16 fps, holds ~2s" },
  { id: "rig", type: "comfyui", label: "the rig", base_url: "http://box:8188",
    enabled: true, lanes: ["still", "i2i"], api_key_set: false,
    api_key_hint: "", options: { cost_usd: 0 } },
];

const MODELS = {
  default: "wan",
  models: [
    { id: "fal-ai/seedance", key: "seedance", label: "Seedance 1.0 pro fast",
      rank: 1, cost: { per_second_usd: 0.0216 }, seconds_max: 12, enabled: true,
      registers: ["legible_text"], fallback: "wan", strengths: ["holds text"] },
    { id: "fal-ai/wan", key: "wan", label: "Wan 2.2 A14B turbo", rank: 2,
      cost: { per_clip_usd: 0.05 }, seconds_max: 5, enabled: true,
      registers: ["dialogue_closeup"], fallback: "seedance", strengths: [] },
  ],
};

const ROUTES: Record<string, unknown> = {
  "/api/backends": BACKENDS,
  "/api/motion-models": MODELS,
  "/api/backends/types": [{ type: "comfyui", lanes: ["still"], kind: "gpu" }],
  "/api/lanes": { still: [{ id: "rig", label: "the rig" }],
                  motion: [{ id: "fal", label: "fal.ai" }] },
  [`/api/projects/${PID}/lanes`]: {
    still: { backend: "rig", model: null },
    motion: { backend: "fal", model: "wan" },
  },
  [`/api/projects/${PID}/style`]: {
    style: { name: "anime-noir", prefix: "hand-painted 2D anime",
             avoid: "photoreal" }, presets: [], stored: true },
  [`/api/projects/${PID}/spend`]: { project: PID, total_usd: 2.5, takes: 12,
    by_lane: { motion: { usd: 2.5, calls: 12 } }, by_backend: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("cutroom_last_pid", PID);
  (apiMod.api as any).mockImplementation((path: string) => {
    if (path === "/api/system") {
      return Promise.resolve({ role, demo: true, jobs: {},
                               budget: { spent: 1.23, limit: 20 } });
    }
    if (path.endsWith("/health")) return Promise.resolve({ up: true });
    if (path in ROUTES) return Promise.resolve(ROUTES[path]);
    return Promise.resolve(null);
  });
});

const anchor = (c: HTMLElement, a: string) =>
  c.querySelector(`[data-action="${a}"]`);

describe("SettingsPage as a viewer", () => {
  beforeEach(() => { role = "viewer"; });

  it("reads as a page about the studio, with no controls that would 403", async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("What powers this studio")).toBeTruthy());
    await waitFor(() => expect(anchor(container, "settings.add")).toBeNull());
    expect(anchor(container, "settings.backend.options")).toBeNull();
    expect(anchor(container, "settings.backend.delete")).toBeNull();
    expect(anchor(container, "settings.backend.enable")).toBeNull();
    expect(anchor(container, "settings.lane.save")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("names every backend with its lanes, model, cost and reachability", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText("fal.ai").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Motion").length).toBeGreaterThan(0);
    expect(screen.getByText(/about \$0\.20 each time it runs/)).toBeTruthy();
    expect(screen.getByText("free: it runs on our own machine")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("answering").length).toBe(2));
  });

  it("shows the motion registry: model, price, length, use and fallback", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getAllByText("Wan 2.2 A14B turbo").length).toBeGreaterThan(0));
    expect(screen.getByText("$0.05 a clip")).toBeTruthy();
    expect(screen.getByText("$0.0216 a second")).toBeTruthy();
    expect(screen.getByText("up to 12s")).toBeTruthy();
    expect(screen.getByText("readable on-screen text")).toBeTruthy();
  });

  it("shows lane defaults, the style register and the money, read-only", async () => {
    render(<SettingsPage />);
    await waitFor(() => // the card, plus the stills and restyles lane rows
      expect(screen.getAllByText("the rig").length).toBe(3));
    expect(screen.getByText("anime-noir")).toBeTruthy();
    expect(screen.getByText("hand-painted 2D anime")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("$1.23 of $20.00")).toBeTruthy());
    expect(screen.getByText(/\$2\.50 across/)).toBeTruthy();
  });

  it("asks for an access link, never an environment variable", async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("Access link")).toBeTruthy());
    expect(screen.getByText(/invite-only/)).toBeTruthy();
    expect(anchor(container, "settings.token")).toBeTruthy();
    expect(container.textContent).not.toMatch(/CUTROOM_|API token|env/);
  });
});

describe("SettingsPage as an admin", () => {
  beforeEach(() => { role = "admin"; });

  it("keeps every control and every anchor the tools drive", async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(anchor(container, "settings.add")).toBeTruthy());
    for (const a of ["settings.backend", "settings.backend.enable",
                     "settings.backend.health", "settings.backend.edit",
                     "settings.lane", "settings.lane.model", "settings.lane.save",
                     "settings.token", "settings.token.save"]) {
      expect(anchor(container, a), a).toBeTruthy();
    }
    expect(container.querySelector('[data-action="settings.backend"][data-id="fal"]'))
      .toBeTruthy();
  });

  it("gets the same informational blocks on top", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("Settings")).toBeTruthy());
    expect(screen.getByText("The machines behind the film")).toBeTruthy();
    expect(screen.getByText("The look")).toBeTruthy();
    expect(screen.getByText("What it costs")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Wan 2.2 A14B turbo").length).toBeGreaterThan(0));
  });
});
