import { defineConfig } from "@playwright/test";

// ── RC-gate functional spec: rc-inventory-menu.spec.ts ONLY ──────────────────
// This spec asserts against the synthetic rc-gate-seed dataset (2000 inv_items,
// `RC-SKU-*`, the 400 missing-English-name gaps, 80 menu rows), which lives in
// the dedicated `moroccan_taste_pos_test` database — NOT the dev clone the rest
// of the ERP e2e uses. So it gets its own config: a globalSetup that re-seeds
// `_test`, a webServer pointed there, and its own port so it can never collide
// with the ordinary ERP run. The visual baselines that used to share this file
// were moved to e2e/erp/visual-baselines.spec.ts (they render against the dev
// clone) — this config runs the functional tests only.
//
// The bundle must be built first (served from dist, no vite dev server):
//   npm --prefix frontend/erp run build
export default defineConfig({
  testDir: "./e2e/erp",
  testMatch: "rc-inventory-menu.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/rc-gate-global-setup.ts",
  outputDir: "./artifacts/e2e/rc-gate/_output",
  use: {
    baseURL: "http://127.0.0.1:3029",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node server.js",
    port: 3029,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: "3029",
      NODE_ENV: "development",
      // The dedicated rc-gate seed database. BOTH names because db/connection.js
      // resolves MYSQL_DATABASE before DB_NAME.
      DB_NAME: "moroccan_taste_pos_test",
      MYSQL_DATABASE: "moroccan_taste_pos_test",
      ERP_UNIFIED_ENABLED: "1",
      WAREHOUSE_V2_ENABLED: "1",
      PROCUREMENT_P2P_ENABLE: "1",
      ORDER_TO_CASH_ENABLE: "1",
      POS_V2_ENABLED: "1",
      RATE_LIMIT_MAX: "1000000",
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: "laptop-1024", use: { viewport: { width: 1024, height: 768 } } },
  ],
});
