import { defineConfig } from "@playwright/test";

// Stage C — BASELINE ("before") screenshots of the 10 legacy accounting
// screens, desktop + mobile. Boots the real Express server on :3025 with
// P2P + O2C DISABLED (empty strings override .env via dotenv's no-override
// rule) so erpAPAging / erpARAging stay in the legacy shell instead of
// redirecting to /warehouse/purchasing and /sales.
//
// The SAME config will be rerun after the redesign for the "after" shots —
// only the output folder inside the spec changes.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "accounting-screens.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/accounting-global-setup.ts",
  outputDir: "./artifacts/e2e/accounting/_output",
  use: {
    baseURL: "http://127.0.0.1:3025",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node server.js",
    port: 3025,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: "3025",
      NODE_ENV: "development",
      WAREHOUSE_V2_ENABLED: "1",
      // Empty strings KEEP the vars set (so .env's "1" cannot re-apply)
      // while failing the /^(1|true|on|yes)$/i check → both flags OFF.
      PROCUREMENT_P2P_ENABLE: "",
      ORDER_TO_CASH_ENABLE: "",
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
