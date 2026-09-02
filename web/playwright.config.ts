import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the NATIVE WebMCP API in real Chrome.
 *
 * `--enable-features=WebMCP` is what makes `document.modelContext` exist — measured,
 * see docs/TESTING-WEBMCP.md §1.1. WebMCPTesting + DevToolsWebMCPSupport are carried
 * along so the DevTools Application > WebMCP pane works in `--headed` runs (and they
 * do install navigator.modelContextTesting on the bundled Chromium 151, though not
 * on system Chrome 152).
 *
 * The server is a scratch Genga Studio server on :8785 with a temp CUTROOM_DATA — never ~/.cutroom.
 */
const WEBMCP_ARGS = ["--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport"];
const PORT = Number(process.env.CUTROOM_E2E_PORT ?? 8785);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  outputDir: "./e2e-results",
  fullyParallel: false,      // one server, one job queue, shared film state
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,           // generous: mock is instant but the film page is heavy
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    // Chrome treats http://localhost as a secure context, so WebMCP is available.
    // A LAN IP would NOT be — see docs/TESTING-WEBMCP.md §1.9.
  },

  projects: [
    {
      // The authoritative target: the same browser the judges will run.
      name: "chrome-native",
      use: { ...devices["Desktop Chrome"], channel: "chrome", launchOptions: { args: WEBMCP_ARGS } },
    },
    {
      // Optional second target (`npx playwright test --project=chromium-bundled`).
      // Playwright 1.62's bundle is Chromium 151 — WebMCP works, and it also has
      // navigator.modelContextTesting. Useful for CI where system Chrome is absent.
      name: "chromium-bundled",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: WEBMCP_ARGS } },
    },
  ],

  webServer: {
    command: "../scripts/e2e-server.sh",
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 15 * 60 * 1000,   // first run imports the film (~600 MB clone + index)
    stdout: "pipe",
    stderr: "pipe",
  },
});
