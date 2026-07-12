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
  build: {
    rollupOptions: {
      output: {
        // Vendor splitting for cache-stable chunks. The WHOLE react family
        // (react, react-dom, scheduler, router) must stay in ONE chunk —
        // splitting react-dom from react/scheduler breaks hook dispatch at
        // runtime. Everything unmatched falls through to Rollup's default
        // chunking, which respects the route-level dynamic-import boundaries
        // (e.g. recharts stays inside the lazy analytics/reports chunks).
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|react-is|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return "vendor-motion";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-query";
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "vendor-icons";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
}));
