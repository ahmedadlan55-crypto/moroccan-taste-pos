import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();

// Inject the JWT both the legacy shell and the SPA read (pos_token).
async function authed(page: Page) {
  await page.addInitScript((tok) => {
    try { localStorage.setItem("pos_token", tok as string); } catch { /* ignore */ }
  }, TOKEN);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|Failed to load resource|ResizeObserver|Download the React DevTools/i.test(t)) return;
    errors.push("console: " + t);
  });
  return errors;
}

test.describe("Legacy purchasing nav removed from the main shell", () => {
  test("main shell hides every legacy purchasing/supplier entry and guards legacy navigation", async ({ page }) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/");
    // The legacy shell injects app-content.html only after a login-form submit.
    // In headless we hold a valid token, so drive the SAME post-auth boot the app
    // runs (its own global functions) — this exercises the REAL app-content.html
    // markup + the REAL app.js CSS-hide + erp.js guard.
    await page.evaluate(async () => {
      const w = window as unknown as {
        fetchAppTemplate?: () => Promise<string>;
        injectAppTemplate?: (html: string) => void;
        applyProcurementP2PNav?: () => void;
      };
      if (typeof w.fetchAppTemplate === "function" && typeof w.injectAppTemplate === "function") {
        const html = await w.fetchAppTemplate();
        w.injectAppTemplate(html);
      }
      if (typeof w.applyProcurementP2PNav === "function") w.applyProcurementP2PNav();
    });
    await page.locator("#p2p-unified-nav").waitFor({ state: "attached", timeout: 20_000 });
    await page.waitForFunction(() => (window as unknown as { __PROCUREMENT_P2P_ENABLE?: boolean }).__PROCUREMENT_P2P_ENABLE === true, null, { timeout: 15_000 });

    // every legacy purchasing/supplier nav entry exists in markup (reversible) but is HIDDEN
    const legacy = page.locator("[data-legacy-purchasing]");
    const count = await legacy.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(legacy.nth(i)).toBeHidden();

    // a legacy navigation call is guarded → redirected into the unified module
    await page.evaluate(() => (window as unknown as { erpNav?: (s: string) => void }).erpNav?.("erpSuppliers"));
    await expect(page).toHaveURL(/\/warehouse\/purchasing/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("warehouse sidebar shows exactly one «المشتريات والموردون» entry", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "desktop fixed sidebar (lg:flex) — mobile uses a different nav");
    await authed(page);
    await page.goto("/warehouse/purchasing");
    await expect(page.getByRole("heading", { name: "المشتريات والموردون" })).toBeVisible();
    await expect(page.getByRole("link", { name: "المشتريات والموردون" })).toHaveCount(1);
  });

  test("purchase-analysis report loads with NO ONLY_FULL_GROUP_BY / SQL leak and no console errors", async ({ page }) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/warehouse/purchasing/reports");
    await page.getByRole("button", { name: "تحليل المشتريات" }).click();
    await page.waitForLoadState("networkidle");
    const body = (await page.locator("body").textContent()) || "";
    // no raw SQL / driver / strict-mode text anywhere in the DOM
    expect(body).not.toMatch(/only_full_group_by|nonaggregated|GROUP BY|sql_mode|supplier_invoices\.supplier_name|SELECT /i);
    // not the error state — either a data table or a benign empty state
    expect(body).not.toContain("تعذّر تحميل تقرير المشتريات");
    const rendered = (await page.locator("table").count()) > 0 || body.includes("لا بيانات") || body.includes("لا توجد");
    expect(rendered, "report rendered a table or an empty state").toBeTruthy();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("hard refresh + back/forward keep the unified report working", async ({ page }) => {
    await authed(page);
    await page.goto("/warehouse/purchasing/reports");
    await page.reload(); // hard refresh (SPA history fallback)
    await expect(page.getByRole("heading", { name: "المشتريات والموردون" })).toBeVisible();
    await page.goto("/warehouse/purchasing");
    await page.goBack();
    await expect(page).toHaveURL(/purchasing\/reports/);
  });
});
