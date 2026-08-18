import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// بوابة الموظف — the employee self-service PWA, served at /employee.
//
// WHY IT IS A SEPARATE APP AND NOT AN ERP ROUTE
//   This is the one screen a floor employee opens on a phone, several times a
//   day, to clock in. The ERP's Arabic dictionary chunk ALONE is ~394 KB, and
//   the shell it lives in is a desktop back-office. Making a cook download an
//   admin console to punch a fingerprint is the wrong trade — so the portal is
//   its own small bundle with its own small dictionary, exactly as the retired
//   PWA was before commit e97ebfbf deleted it.
//
// Dev serves at root (http://localhost:5176/); the production build is based at
// /employee/ so Express mounts it on the historical path — an installed icon
// whose start_url is /employee/ opens straight into it, and the service worker
// scope matches.
const BACKEND = process.env.VITE_BACKEND_ORIGIN || "http://localhost:3000";

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/employee/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // A STRING (not `true`) so it lands at dist ROOT: the default
    // `.vite/manifest.json` sits in a dotfile directory, which express.static
    // ignores by default (dotfiles: 'ignore') — the SW could never fetch it.
    manifest: "asset-manifest.json",
    rollupOptions: {
      output: {
        // The WHOLE react family stays in ONE chunk — splitting react-dom from
        // react/scheduler breaks hook dispatch at runtime.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|react-is|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-query";
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "vendor-icons";
        },
      },
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
