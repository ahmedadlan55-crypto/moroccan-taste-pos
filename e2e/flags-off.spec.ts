// ═══════════════════════════════════════════════════════════════════
// Release Gate G4 — flags-OFF navigation contract.
//
// Server env (playwright.flags-off.config.ts): WAREHOUSE_V2_ENABLED=0,
// PROCUREMENT_P2P_ENABLE + ORDER_TO_CASH_ENABLE unset. The contract:
//   • the three unified main-shell links (#o2c-unified-nav, the /warehouse
//     anchor, #p2p-main-nav) are ALL hidden — no visible path to a 503 or
//     dormant page;
//   • the legacy P2P fallbacks still work: the two [data-legacy-purchasing]
//     hub cards are visible and erpNav('erpSuppliers') opens the legacy
//     section (the P2P guard only redirects when the flag is ON);
//   • zero JS console errors and zero failed API requests.
// The flags-ON side of the contract is asserted in accounting-screens.spec.ts
// (warehouse link visible) and exercised by e2e:procurement (P2P module).
// ═══════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();

test("flags OFF: no dead links, legacy fallbacks alive", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`.slice(0, 220));
  });

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("pos_last_section", "home");
      // pin the flag caches to the server's flags-off reality (flash-free)
      localStorage.setItem("procurement_p2p_flag", "0");
      localStorage.setItem("order_to_cash_flag", "0");
      localStorage.setItem("wh_v2_flag", "0");
      localStorage.setItem("wh_v2_allowed", "0");
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })]
  );

  await page.goto("/");
  await expect(page.locator("#adminView")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500); // sidebar hydration + /api/version reconcile

  // 1 — the three unified links are hidden (no dead links)
  await expect(page.locator("#o2c-unified-nav")).toBeHidden();
  await expect(page.locator('a[href="/warehouse"]')).toBeHidden();
  await expect(page.locator("#p2p-main-nav")).toBeHidden();

  // 2 — legacy P2P fallbacks: the two tagged report-hub cards are visible
  await page.evaluate(() => (window as any).erpNav("erpRptHub"));
  await expect(page.locator("#erpRptHub")).toBeVisible();
  const legacy = page.locator("[data-legacy-purchasing]");
  await expect(legacy).toHaveCount(2);
  for (let i = 0; i < 2; i++) await expect(legacy.nth(i)).toBeVisible();

  // 3 — the legacy suppliers screen opens (P2P guard inactive when OFF)
  await page.evaluate(() => (window as any).erpNav("erpSuppliers"));
  await expect(page.locator("#erpSuppliers")).toBeVisible();
  await expect(page).toHaveURL(/127\.0\.0\.1:3022\/?$/); // no redirect happened

  // 4 — evidence gates
  expect(consoleErrors, "zero console errors").toEqual([]);
  expect(failedRequests, "zero failed requests").toEqual([]);
});
