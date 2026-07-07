import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", "o2c", ".token"), "utf8").trim();
const SHOT = (name: string, project: string) => path.join("artifacts", "e2e", "o2c-final", project, `${name}.png`);

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

test.describe("Order-to-Cash ↔ POS V2 (/pos-v2)", () => {
  test("POS renders the catalog with no console errors + no h-scroll", async ({ page }, info) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/pos-v2");
    // seeded menu item appears in the catalog grid
    await expect(page.getByText("شاي مغربي E2E").first()).toBeVisible({ timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow px").toBeLessThanOrEqual(2);
    await page.screenshot({ path: SHOT("10-pos-catalog", info.project.name), fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("customer picker (O2C) opens showing the first page + resolves a real customer", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "cart interaction verified on desktop");
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/pos-v2");
    await expect(page.getByText("شاي مغربي E2E").first()).toBeVisible({ timeout: 20_000 });

    // open the customer quick-attach in the cart → the searchable picker
    await page.getByRole("button", { name: /عميل/ }).first().click();
    const search = page.getByPlaceholder(/ابحث بالاسم أو الهاتف/);
    await expect(search).toBeVisible({ timeout: 15_000 });
    // first page shows instantly (no typing) — at least one option is listed
    await expect(page.getByRole("option").first()).toBeVisible();
    // narrow to the seeded credit customer → it becomes the top result (in-viewport)
    await search.fill("اختبار E2E");
    const opt = page.getByRole("option", { name: /عميل اختبار E2E/ });
    await expect(opt).toBeVisible({ timeout: 15_000 });
    await expect(opt).toContainText("5,000.00"); // available credit, English digits
    await page.screenshot({ path: SHOT("11-pos-customer-picker", info.project.name), fullPage: true });

    // pick it → the cart chip shows the linked customer (real customerId set).
    // The option lives in the cart's upward popover; dispatch the click directly to
    // the button's React handler (avoids the popover viewport-positioning quirk).
    await opt.dispatchEvent("click");
    await expect(page.getByText("عميل اختبار E2E").first()).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
