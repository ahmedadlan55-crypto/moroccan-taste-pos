import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The Order-to-Cash SPA is served under /sales alongside the legacy UI and the
// warehouse/pos peer SPAs (Strangler). In dev, /api is proxied to the existing
// Express backend so the React app talks to the real contracts without CORS.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || "http://localhost:3000";

export default defineConfig(({ command }) => ({
  // Dev serves at root; production build is based at /sales/ so it mounts beside
  // the legacy app behind Express. The router reads import.meta.env.BASE_URL.
  base: command === "serve" ? "/" : "/sales/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5176,
    strictPort: true,
    hmr: process.env.VITE_NO_HMR ? false : undefined,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
}));
