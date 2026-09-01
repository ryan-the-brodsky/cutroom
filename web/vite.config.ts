import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // `@` → src, so the lifted FreeCut player's `@/shared/logging/*` imports resolve.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8770" },
  },
  build: { outDir: "dist", target: "esnext" },
});
