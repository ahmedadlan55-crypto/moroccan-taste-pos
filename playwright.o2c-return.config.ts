import { defineConfig, devices } from "@playwright/test";

// ── E2E for "O2C return + manager approval" — spans BOTH frontends (/pos for
// the cashier's sale + return-request, /app for the manager's approve+post) ──
//
// Infra decision: /pos and /app are served by the SAME server.js process
// (confirmed by reading server.js — express.static mounts BOTH the POS dist
// at /pos and the ERP dist at /app unconditionally, gated only by an explicit
// kill switch for /app). So this does NOT need two webServers on two ports —
// ONE real Express server on ONE dedicated port (3029, unused by the other
// e2e configs: 3025/3027/3028) serves both apps for the whole flow. The spec
// itself opens TWO separate browser CONTEXTS (cashier, manager) against that
// one server, since both apps share the same localStorage key (`pos_token`)
// on the same origin — two contexts keep the two sessions from clobbering
// each other, exactly like two different physical devices would.
//
// Both dists must be built first:
//     npm run build:pos && npm run build:erp
export default defineConfig({
  testDir: "./e2e/o2c",
  testMatch: "**/*.spec.ts",
  timeout: 480_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./artifacts/e2e/o2c/_output",
  use: {
    baseURL: "http://127.0.0.1:3029",
    trace: "off",
    video: "off",
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
      ORDER_TO_CASH_ENABLE: "1",
      ERP_UNIFIED_ENABLED: "1",
      POS_V2_ENABLED: "1",
      WAREHOUSE_V2_ENABLED: "1",
      PROCUREMENT_P2P_ENABLE: "1",
      // The flow logs in twice, opens a shift, searches the catalog, and drives
      // two dialogs from one IP — keep the prod rate limiter out of the way
      // (same rationale as playwright.erp.config.ts / playwright.pos.config.ts).
      RATE_LIMIT_MAX: "1000000",
    },
  },
  // Mirrors the 4-viewport pattern already used for critical-cashier-shift.spec.ts
  // (playwright.pos.config.ts) — the single shared server makes this cheap: every
  // project just re-runs the same real sale+return+approve+post flow at a
  // different manager-context viewport (the cashier context always renders at
  // desktop 1440×900, matching how the sibling spec keeps ONE role's viewport
  // fixed while varying the other — here the manager's ERP screen is the one
  // whose responsive behaviour actually matters for this task).
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      name: "tablet-768",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, hasTouch: true },
    },
    {
      name: "laptop-1024",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } },
    },
  ],
});
