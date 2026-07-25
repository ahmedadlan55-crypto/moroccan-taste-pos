import { defineConfig } from "@playwright/test";

// ── E2E for the unified ADLAN Back-Office (frontend/erp) served at /app ───────
// Boots the REAL Express server on :3027 with the unified app enabled and every
// peer feature-flag ON, then runs the smoke + screenshot spec on desktop and
// mobile. The server serves the BUILT dist (there is no vite dev server here),
// so the bundle MUST be built first:
//     npm --prefix frontend/erp run build
// The admin JWT is signed by e2e/accounting-global-setup.ts into e2e/.token and
// injected into localStorage (pos_token) by the spec's addInitScript.
// E2E_PORT (optional): run the whole suite on a non-default port so parallel
// agent sessions on one machine don't fight over :3027 (observed during the
// sales-hub sprint: two sessions' webServers + DB clones stomping each other).
// Defaults preserve the canonical 3027 exactly.
const E2E_PORT = Number(process.env.E2E_PORT) || 3027;

export default defineConfig({
  testDir: "./e2e/erp",
  testMatch: "**/*.spec.ts",
  // rc-inventory-menu.spec.ts asserts the synthetic rc-gate-seed dataset in
  // `moroccan_taste_pos_test`, not the dev clone this config serves — it runs
  // under playwright.rc-gate.config.ts instead. (Its visual baselines moved to
  // visual-baselines.spec.ts, which DOES belong here.)
  testIgnore: "rc-inventory-menu.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Signs the admin JWT. The DB clone is NO LONGER provisioned here: Playwright
  // starts the webServer BEFORE globalSetup, so provisioning here re-cloned the
  // database out from under the already-booted server, wiping its boot migrations
  // (the whole-suite `warehouses` 422 — see scripts/e2e/provision-and-serve.js).
  // Provisioning now runs inside the webServer command, before `node server.js`.
  globalSetup: "./e2e/erp-global-setup.ts",
  outputDir: "./artifacts/e2e/erp/_output",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    // Diagnostics kept ON for failures only: a trace + video + the failure
    // screenshot is the difference between "it went red again" and an actual
    // root cause. `retain-on-failure` costs nothing on a green run.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Provision the isolated clone FIRST, then boot `node server.js` so its own
    // boot migrations apply to the FINAL clone (mirrors production: existing DB →
    // node server.js migrates on boot). See scripts/e2e/provision-and-serve.js.
    command: "node scripts/e2e/provision-and-serve.js",
    port: E2E_PORT,
    reuseExistingServer: false,
    // Covers clone (~42s) + boot migrations + listen with headroom, and stays
    // above provision-and-serve.js's 240s clone timeout so a slow clone fails as
    // a clone error, not an opaque Playwright port timeout.
    timeout: 300_000,
    env: {
      PORT: String(E2E_PORT),
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
