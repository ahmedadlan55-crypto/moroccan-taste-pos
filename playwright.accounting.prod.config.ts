import { defineConfig, devices } from "@playwright/test";

// Release Gate G6 — PRODUCTION-MODE smoke of the accounting screens.
// Identical to playwright.accounting.config.ts except NODE_ENV=production
// (the single production-relevant switch: the Dockerfile/compose never set
// NODE_ENV themselves — Railway injects it at runtime, so this mirrors the
// real deployment). Auth is a directly-signed JWT (no /auth/login), the
// legacy accounting screens carry no per-SPA CSP, and the server uses no
// cookies — verified production-safe for this spec. Port 3026.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "accounting-screens.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/accounting-global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3026",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node server.js",
    port: 3026,
    reuseExistingServer: false,
    timeout: 150_000,
    env: {
      PORT: "3026",
      NODE_ENV: "production",
      WAREHOUSE_V2_ENABLED: "1",
      PROCUREMENT_P2P_ENABLE: "",
      ORDER_TO_CASH_ENABLE: "",
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
  ],
});
