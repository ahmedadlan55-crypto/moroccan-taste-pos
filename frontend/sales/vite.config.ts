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
  build: {
    rollupOptions: {
      output: {
        // Vendor splitting for cache-stable chunks. The WHOLE react family
        // (react, react-dom, scheduler, router) must stay in ONE chunk —
        // splitting react-dom from react/scheduler breaks hook dispatch at
        // runtime. Everything unmatched falls through to Rollup's default
        // chunking, which respects the route-level dynamic-import boundaries.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|react-is|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return "vendor-motion";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-query";
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "vendor-icons";
          if (/[\\/]node_modules[\\/](react-hook-form|@hookform|zod)[\\/]/.test(id)) return "vendor-forms";
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
