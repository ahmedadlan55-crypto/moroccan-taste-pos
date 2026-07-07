import { defineConfig, devices } from "@playwright/test";

// E2E for the Order-to-Cash closure. Boots the real Express server with
// ORDER_TO_CASH_ENABLE=1 + POS_V2_ENABLED=1, serving the built /sales + /pos-v2
// SPAs. One worker (shared DB). The SPAs must be built first
// (npm run build:sales && npm run build:pos) — see e2e:o2c script.
export default defineConfig({
  testDir: "./e2e/o2c",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/o2c/global-setup.ts",
  outputDir: "./artifacts/e2e/o2c-final/_output",
  use: {
    baseURL: "http://127.0.0.1:3021",
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node server.js",
    port: 3021,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ORDER_TO_CASH_ENABLE: "1",
      POS_V2_ENABLED: "1",
      WAREHOUSE_V2_ENABLED: "1",
      PORT: "3021",
      NODE_ENV: "development",
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
