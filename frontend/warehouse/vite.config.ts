import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The app is served under /warehouse-v2 alongside the legacy UI (Strangler).
// In dev, /api is proxied to the existing Express backend so the React app
// talks to the real contracts without CORS gymnastics.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || "http://localhost:3000";

// Dev serves at root (so the preview/dev URL is simply http://localhost:5174/);
// the production build is based at /warehouse-v2/ so it mounts beside the legacy
// app behind Express. The router reads import.meta.env.BASE_URL to stay correct
// in both modes.
export default defineConfig(({ command }) => ({
  // Production base is /warehouse/ — the warehouse section is a first-class
  // part of the main system (the old /warehouse-v2 URL 301-redirects to it).
  base: command === "serve" ? "/" : "/warehouse/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    // HMR can be disabled via env (e.g. for headless screenshot capture, whose
    // network-idle wait never settles while the HMR WebSocket is open).
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
