import { defineConfig, devices } from "@playwright/test";

// Release Gate G4 — the FLAGS-OFF contract: with WAREHOUSE_V2_ENABLED=0 and
// the P2P/O2C flags unset, the main shell must show NO link that dead-ends on
// a 503/dormant page, while the legacy fallback entries/screens still work.
// Mirrors playwright.dormant.config.ts (its own server, own port, one worker).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "flags-off.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/accounting-global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3022",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node server.js",
    port: 3022,
    reuseExistingServer: false,
    timeout: 150_000,
    env: {
      PORT: "3022",
      NODE_ENV: "development",
      WAREHOUSE_V2_ENABLED: "0",
      PROCUREMENT_P2P_ENABLE: "",
      ORDER_TO_CASH_ENABLE: "",
    },
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
