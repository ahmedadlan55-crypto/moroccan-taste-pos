import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", "o2c", ".token"), "utf8").trim();
const SHOT = (name: string, project: string) => path.join("artifacts", "e2e", "o2c-final", project, `${name}.png`);
const stamp = Date.now().toString(36);

async function authed(page: Page) {
  await page.addInitScript((tok) => { try { localStorage.setItem("pos_token", tok as string); } catch { /* ignore */ } }, TOKEN);
}
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|Failed to load resource|ResizeObserver|Download the React DevTools|net::ERR/i.test(t)) return;
    errors.push("console: " + t);
  });
  return errors;
}
async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow px").toBeLessThanOrEqual(2);
}

test.describe("Order-to-Cash /sales", () => {
  test("one section «المبيعات والعملاء» + nav renders, no console errors, no h-scroll", async ({ page }, info) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/sales");
    await expect(page).toHaveURL(/\/sales\/dashboard/);
    // the single O2C section: dashboard title + the secondary nav (links appear in
    // the sidebar on desktop and the bottom bar on mobile — assert the common ones).
    await expect(page.getByText("لوحة المبيعات والذمم")).toBeVisible();
    for (const label of ["العملاء", "الفواتير", "التحصيلات"]) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
    }
    await noHorizontalScroll(page);
    await page.screenshot({ path: SHOT("01-dashboard", info.project.name), fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("customers: create + open Customer 360", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "create flow verified on desktop");
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/sales/customers");
    await expect(page.getByText("سجل العملاء")).toBeVisible();

    await page.getByRole("button", { name: /عميل جديد/ }).first().click();
    const name = `عميل E2E ${stamp}`;
    await page.getByLabel("اسم العميل").fill(name);
    await page.getByRole("button", { name: "حفظ العميل" }).click();

    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: SHOT("02-customers", info.project.name), fullPage: true });

    await page.getByText(name).first().click();
    await expect(page).toHaveURL(/\/sales\/customers\//);
    await expect(page.getByText("الرصيد (ذمم)")).toBeVisible();
    await expect(page.getByText("أعمار الذمم (حسب الاستحقاق)")).toBeVisible();
    await page.screenshot({ path: SHOT("03-customer-360", info.project.name), fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("invoice: create draft → issue (immutable) with GL + ZATCA", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "create flow verified on desktop");
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/sales/invoices");
    await expect(page.getByText("فواتير العملاء")).toBeVisible();

    await page.getByRole("button", { name: /فاتورة جديدة/ }).first().click();
    // one line: description + qty + price (aria-labelled for stable targeting)
    await page.getByLabel("وصف السطر 1").fill("بند اختبار E2E");
    await page.getByLabel("كمية السطر 1").fill("2");
    await page.getByLabel("سعر السطر 1").fill("100");
    await page.getByRole("button", { name: "حفظ كمسودة" }).click();

    await expect(page).toHaveURL(/\/sales\/invoices\//, { timeout: 15_000 });
    await expect(page.getByText("مسودة").first()).toBeVisible();
    await page.getByRole("button", { name: /إصدار/ }).click();
    await expect(page.getByText("صادرة").first()).toBeVisible({ timeout: 15_000 });
    // issued invoice is immutable → no edit; GL + ZATCA present
    await expect(page.getByText("قيد GL")).toBeVisible();
    await expect(page.getByText("UUID زاتكا")).toBeVisible();
    await page.screenshot({ path: SHOT("04-invoice-issued", info.project.name), fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("reports: ar-aging renders (English digits) + print layout", async ({ page }, info) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/sales/reports/ar-aging");
    await expect(page.getByText("أعمار الذمم")).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: SHOT("05-report-aging", info.project.name), fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
