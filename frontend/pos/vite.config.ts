import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The app IS the POS: served at /pos (final cutover — the legacy PWA that
// lived there is retired; /pos-v2 now 301-redirects here). In dev, /api is
// proxied to the existing Express backend so the React app talks to the real
// contracts without CORS gymnastics.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || "http://localhost:3000";

// Dev serves at root (http://localhost:5175/); the production build is based
// at /pos/ so Express mounts it on the historical POS path (installed icons
// with start_url /pos/ open it directly; the SW takes over /pos/sw.js).
export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/pos/",
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
    rollupOptions: {
      output: {
        // Vendor split so no emitted JS chunk exceeds Vite's 500 KB budget (the
        // cashier had grown to one ~518 KB bundle). The WHOLE react family
        // (react, react-dom, scheduler) stays in ONE chunk — splitting
        // react-dom from react/scheduler breaks hook dispatch at runtime. App
        // code (no route-level dynamic imports here) stays in the entry chunk,
        // so behaviour is unchanged — only smaller, longer-lived cache units.
        // OFFLINE-SAFE: every emitted chunk lands in asset-manifest.json, which
        // public/sw.js precaches at install, so the offline boot is unaffected.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|react-is|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-query";
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "vendor-icons";
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return "vendor-zod";
        },
      },
    },
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
