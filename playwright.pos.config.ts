import { defineConfig, devices } from "@playwright/test";

// ── E2E for the Cashier V2 PWA (/pos): offline lifecycle + installability ──
// Modeled on playwright.erp.config.ts / playwright.o2c.config.ts: boots the
// REAL Express server which serves the BUILT dist (the service worker only
// registers in production bundles), so build first — the npm script does:
//     npm run e2e:pos   →  npm run build:pos && playwright test --config=...
//
// Fixture setup/teardown (JWT signing, ITEST- seed rows, sale-row cleanup)
// lives inside e2e/pos/offline.spec.ts (beforeAll/afterAll) — no globalSetup.
//
// Chromium desktop ONLY: the scenario exercises service-worker caching +
// context.setOffline, which Playwright supports deterministically in Chromium.
export default defineConfig({
  testDir: "./e2e/pos",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // Provisions the isolated E2E database clone before any spec runs.
  globalSetup: "./e2e/e2e-db-global-setup.ts",
  outputDir: "./artifacts/e2e/pos/_output",
  use: {
    baseURL: "http://127.0.0.1:3028",
    // Diagnostics on failure only — a trace + video is what turns "the payment
    // step went red again" into an actual root cause, and costs nothing green.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // Service workers must be ALLOWED (default, but explicit — the whole
    // point of the offline spec is the SW-served app shell).
    serviceWorkers: "allow",
  },
  webServer: {
    command: "node server.js",
    port: 3028,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: "3028",
      NODE_ENV: "development",
      // ISOLATION — see the same block in playwright.erp.config.ts. This suite
      // SELLS: it creates orders, takes payments and opens shifts. Every one of
      // those writes used to land in the real development database, which is
      // also why these specs' visual baselines drifted. BOTH names are set
      // because db/connection.js resolves MYSQL_DATABASE before DB_NAME.
      DB_NAME: process.env.E2E_DB_NAME || "moroccan_taste_pos_e2e",
      MYSQL_DATABASE: process.env.E2E_DB_NAME || "moroccan_taste_pos_e2e",
      POS_V2_ENABLED: "1",
      WAREHOUSE_V2_ENABLED: "1",
      // The spec reloads the SPA several times from one IP; keep the prod
      // rate limiter out of the way (same rationale as playwright.erp.config).
      RATE_LIMIT_MAX: "1000000",
    },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-390",
      testMatch: ["**/responsive.spec.ts", "**/critical-cashier-shift.spec.ts", "**/bilingual-flow.spec.ts", "**/rtl-visual.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: "tablet-768",
      testMatch: ["**/responsive.spec.ts", "**/critical-cashier-shift.spec.ts", "**/bilingual-flow.spec.ts", "**/rtl-visual.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    {
      name: "laptop-1024",
      testMatch: ["**/responsive.spec.ts", "**/critical-cashier-shift.spec.ts", "**/bilingual-flow.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } },
    },
  ],
});
