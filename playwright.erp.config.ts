import { defineConfig } from "@playwright/test";

// ── E2E for the unified ADLAN Back-Office (frontend/erp) served at /app ───────
// Boots the REAL Express server on :3027 with the unified app enabled and every
// peer feature-flag ON, then runs the smoke + screenshot spec on desktop and
// mobile. The server serves the BUILT dist (there is no vite dev server here),
// so the bundle MUST be built first:
//     npm --prefix frontend/erp run build
// The admin JWT is signed by e2e/accounting-global-setup.ts into e2e/.token and
// injected into localStorage (pos_token) by the spec's addInitScript.
export default defineConfig({
  testDir: "./e2e/erp",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/accounting-global-setup.ts",
  outputDir: "./artifacts/e2e/erp/_output",
  use: {
    baseURL: "http://127.0.0.1:3027",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node server.js",
    port: 3027,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: "3027",
      NODE_ENV: "development",
      ERP_UNIFIED_ENABLED: "1",
      WAREHOUSE_V2_ENABLED: "1",
      PROCUREMENT_P2P_ENABLE: "1",
      ORDER_TO_CASH_ENABLE: "1",
      POS_V2_ENABLED: "1",
      // The gate walks all 89 routes from ONE ip in seconds. The production limiter
      // (500/15min/IP) would throttle the sweep itself and turn healthy screens into
      // 429 ErrorStates — which is exactly how the previous run produced a FALSE
      // pass. Raise it for the sweep only; a real 429 still fails the gate.
      RATE_LIMIT_MAX: "1000000",
    },
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
