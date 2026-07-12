import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const SHOT = (name: string, project: string) => path.join("artifacts", "e2e", project, `${name}.png`);

// Inject the JWT the SPA reads (pos_token) before any script runs.
async function authed(page: Page) {
  await page.addInitScript((tok) => {
    try { localStorage.setItem("pos_token", tok as string); } catch { /* ignore */ }
  }, TOKEN);
}

// Collect hard errors (uncaught exceptions + console.error), ignoring benign noise.
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

test.describe("Procurement module", () => {
  test("dashboard + tab navigation render with no console errors", async ({ page }, testInfo) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/warehouse/purchasing");
    await expect(page.getByRole("heading", { name: "المشتريات والموردون" })).toBeVisible();
    // The ADLAN font must genuinely render — it is self-hosted (the strict SPA
    // CSP blocks Google Fonts), so a broken font pipeline would otherwise fall
    // back to Tajawal silently, with no console error to catch.
    const plexLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('16px "IBM Plex Sans Arabic"', "المشتريات والموردون 123");
    });
    expect(plexLoaded, "IBM Plex Sans Arabic loaded from self-hosted woff2").toBe(true);
    // KPI cards
    await expect(page.getByText("قيمة المشتريات")).toBeVisible();
    await page.screenshot({ path: SHOT("01-dashboard", testInfo.project.name), fullPage: true });

    for (const [label, url] of [
      ["الموردون", /purchasing\/suppliers/],
      ["أوامر الشراء", /purchasing\/orders/],
      ["الاستلامات", /purchasing\/receipts/],
      ["الفواتير", /purchasing\/invoices/],
      ["المدفوعات", /purchasing\/payments/],
      ["المرتجعات", /purchasing\/returns/],
      ["التقارير", /purchasing\/reports/],
    ] as const) {
      // scope to the procurement tab bar (labels collide with the main sidebar)
      await page.getByLabel("أقسام المشتريات").getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(url);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: SHOT(`tab-${label}`, testInfo.project.name), fullPage: true });
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("create a supplier via the inline form", async ({ page }, testInfo) => {
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/warehouse/purchasing/suppliers");
    await page.getByRole("button", { name: "+ مورد جديد" }).click();
    const name = "مورد بلاي-رايت " + Date.now();
    await page.getByPlaceholder("اسم المورد").fill(name);
    await page.getByRole("button", { name: "حفظ", exact: true }).click();
    await expect(page.getByText(name)).toBeVisible();
    await page.screenshot({ path: SHOT("02-supplier-created", testInfo.project.name), fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("full PO create via searchable pickers + UnitQtyInput, then detail + print", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "PO create wizard is validated on desktop");
    await authed(page);
    const errors = trackErrors(page);
    await page.goto("/warehouse/purchasing/orders/new");
    await expect(page.getByRole("heading", { name: "إنشاء أمر شراء" })).toBeVisible();

    // supplier combobox — opens with first page on click; options live in a
    // portal listbox (scope to it so native <select> options never collide).
    await page.getByRole("combobox", { name: "اختيار المورد" }).click();
    await page.getByRole("listbox").getByRole("option").first().click();
    // a selection renders a clearable chip (the search input is replaced)
    await expect(page.getByRole("button", { name: "مسح المحدد" }).first()).toBeVisible();

    // item combobox
    await page.getByRole("combobox", { name: "اختيار المادة" }).click();
    await page.getByRole("listbox").getByRole("option").first().click();

    // quantity + price (UnitQtyInput renders a number input for the qty)
    const qty = page.locator('input[type="number"]').first();
    await qty.fill("5");
    await page.locator('input[type="number"]').nth(1).fill("120"); // unit price
    await page.screenshot({ path: SHOT("03-po-new-filled", testInfo.project.name), fullPage: true });

    await page.getByRole("button", { name: "إنشاء أمر الشراء" }).click();
    // lands on the PO detail
    await expect(page.getByText("أمر شراء").first()).toBeVisible();
    await expect(page.getByText("السجل الزمني")).toBeVisible();
    await page.screenshot({ path: SHOT("04-po-detail", testInfo.project.name), fullPage: true });

    // print emulation (A4)
    await page.emulateMedia({ media: "print" });
    await page.screenshot({ path: SHOT("05-po-detail-print", testInfo.project.name), fullPage: true });
    await page.emulateMedia({ media: "screen" });

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
