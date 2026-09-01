import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the agent layer (workstreams A/B/C write `*.test.ts`).
 * Run: `npm test` (or `npx vitest run`) from `web/`.
 *
 * jsdom, because the registry/bridge/presence code touches `document`,
 * `CSS.escape`, `location` and friends. Playwright e2e lives in `web/e2e/`
 * and is excluded here — see docs/TESTING-WEBMCP.md.
 */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
