import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The app is served under /pos-v2 alongside the legacy POS (Strangler).
// In dev, /api is proxied to the existing Express backend so the React app
// talks to the real contracts without CORS gymnastics.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || "http://localhost:3000";

// Dev serves at root (http://localhost:5175/); the production build is based
// at /pos-v2/ so it mounts beside the legacy app behind Express.
export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/pos-v2/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Emit a stable manifest of hashed assets for the service worker's
    // precache step (public/sw.js fetches it at install time). A STRING (not
    // `true`) so it lands at dist ROOT: the default `.vite/manifest.json`
    // sits in a dotfile directory, which express.static ignores by default
    // (dotfiles: 'ignore') — the SW could never fetch it in production.
    manifest: "asset-manifest.json",
  },
  server: {
    port: 5175,
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
