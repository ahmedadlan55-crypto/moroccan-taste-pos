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
  // Provisions the isolated E2E database clone, THEN signs the admin JWT.
  globalSetup: "./e2e/erp-global-setup.ts",
  outputDir: "./artifacts/e2e/erp/_output",
  use: {
    baseURL: "http://127.0.0.1:3027",
    // Diagnostics kept ON for failures only: a trace + video + the failure
    // screenshot is the difference between "it went red again" and an actual
    // root cause. `retain-on-failure` costs nothing on a green run.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node server.js",
    port: 3027,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: "3027",
      NODE_ENV: "development",
      // ISOLATION — the server under test talks to a throwaway CLONE of the
      // development database, recreated by globalSetup before every run.
      // Without these two lines this config ran `node server.js` with no
      // override, so the entire gate wrote to the REAL development database:
      // no run could honestly claim zero dev writes, state accumulated between
      // runs (so a spec could legitimately pass alone and fail in the suite),
      // and the visual baselines photographed a catalog that kept changing
      // underneath them. BOTH names are set because db/connection.js resolves
      // MYSQL_DATABASE first and falls back to DB_NAME.
      DB_NAME: process.env.E2E_DB_NAME || "moroccan_taste_pos_e2e",
      MYSQL_DATABASE: process.env.E2E_DB_NAME || "moroccan_taste_pos_e2e",
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
    {
      name: "tablet-768",
      use: {
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },
    {
      name: "laptop-1024",
      use: {
        viewport: { width: 1024, height: 768 },
      },
    },
  ],
});
