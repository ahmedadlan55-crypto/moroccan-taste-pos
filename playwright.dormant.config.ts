import { defineConfig, devices } from "@playwright/test";

// Dormant-cutover E2E: boots the server WITHOUT PROCUREMENT_P2P_ENABLE (flag OFF)
// and proves the Procurement surface is fully hidden/inert while the legacy
// system still works. Separate testDir so the enabled config never runs it.
export default defineConfig({
  testDir: "./e2e-dormant",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: "http://127.0.0.1:3021", trace: "off", screenshot: "off" },
  webServer: {
    command: "node server.js",
    port: 3021,
    reuseExistingServer: false,
    timeout: 150_000,
    // NOTE: PROCUREMENT_P2P_ENABLE intentionally NOT set → dormant.
    env: { PORT: "3021", NODE_ENV: "development", WAREHOUSE_V2_ENABLED: "1" },
  },
  projects: [
    { name: "dormant", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
  ],
});
