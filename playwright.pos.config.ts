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
  outputDir: "./artifacts/e2e/pos/_output",
  use: {
    baseURL: "http://127.0.0.1:3028",
    trace: "off",
    video: "off",
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
      testMatch: ["**/responsive.spec.ts", "**/critical-cashier-shift.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: "tablet-768",
      testMatch: ["**/responsive.spec.ts", "**/critical-cashier-shift.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    {
      name: "laptop-1024",
      testMatch: ["**/responsive.spec.ts", "**/critical-cashier-shift.spec.ts"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } },
    },
  ],
});
