import { defineConfig, devices } from "@playwright/test";

// E2E for the unified procurement module. Boots the real Express server with the
// P2P flag ON, serving the built React SPA at /warehouse. One worker (shared DB).
export default defineConfig({
  testDir: "./e2e",
  // o2c/** has its own config (playwright.o2c.config.ts) and reads e2e/o2c/.token
  // at module load — collecting it here breaks the whole run when that token is
  // absent. accounting-screens has its own config too (playwright.accounting.config.ts).
  testIgnore: ["**/o2c/**", "**/accounting-screens.spec.ts", "**/flags-off.spec.ts"],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3020",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node server.js",
    port: 3020,
    reuseExistingServer: false,
    timeout: 150_000,
    env: { PROCUREMENT_P2P_ENABLE: "1", PORT: "3020", NODE_ENV: "development", WAREHOUSE_V2_ENABLED: "1" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
