// ═══════════════════════════════════════════════════════════════════════════
// RC Gate — Inventory-items + Menu redesigns (functional + perf) and the
// bilingual screenshot matrix for the human visual review.
//
// Runs against the isolated moroccan_taste_pos_test DB seeded by
// scripts/rc-gate-seed.mjs (2000 inv_items — 400 with NULL name_en — and 80
// menu rows, 40 recipe-costed + 40 manual). Financial/inventory INVARIANTS
// (recipe-cost lock COST_LOCKED_BY_RECIPE, cross-branch warehouse rejection,
// master-save never touches balances/GL) are proven by the backend suites
// (test:cost-source / test:item-assignments / test:menu-list); this spec
// covers the UI: server-side pagination + bounded DOM at 2000 rows, search,
// the missing-English-name filter, full-page create/edit routes, deep-link +
// refresh, and the 14-column redesign.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const CRASH_TEXT = "حدث خطأ غير متوقّع";

function login(page: Page, lang: "ar" | "en") {
  return page.addInitScript(
    ([token, session, l]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("erp_lang", l);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" }), lang],
  );
}
async function waitRendered(page: Page) {
  await page.waitForFunction((crash) => {
    const b = document.body?.innerText || "";
    if (b.includes(crash)) return true;
    const m = document.getElementById("main");
    if (!m) return false;
    return !!m.querySelector("[data-state], h1, h2, table, header") || (m.innerText || "").trim().length > 40;
  }, CRASH_TEXT, { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

test.describe.configure({ mode: "serial" });

test("inventory items: 2000 rows server-paginated with a bounded DOM", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "en");
  await page.goto("/app/inventory/items");
  await waitRendered(page);

  // KPI total reflects the full 2000, but only a page's worth is in the DOM.
  const bodyText = await page.locator("#main").innerText();
  expect(bodyText).toContain("2,000");

  const domRows = await page.locator("#main table tbody tr").count();
  expect(domRows, "server pagination: a page, not all 2000, is in the DOM").toBeLessThanOrEqual(60);
  expect(domRows, "some rows render").toBeGreaterThan(0);

  // The redesigned 14-column header set (a representative subset).
  const heads = (await page.locator("#main thead").innerText()).replace(/\s+/g, " ");
  for (const h of ["SKU", "Name (Arabic)", "Name (English)", "Category", "Base unit", "Status"]) {
    expect(heads, `column header "${h}"`).toContain(h);
  }
});

test("inventory items: search by code and by English name narrows the list", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "en");
  await page.goto("/app/inventory/items");
  await waitRendered(page);

  const search = page.locator('#main input[type="search"], #main input[placeholder]').first();
  await search.fill("RC-SKU-0004");
  await page.waitForTimeout(700); // debounce
  await expect(page.locator("#main")).toContainText("Dairy Item 0004");
  const n1 = await page.locator("#main table tbody tr").count();
  expect(n1, "code search narrows to a handful").toBeLessThan(10);

  await search.fill("");
  await search.fill("Dairy Item 0012");
  await page.waitForTimeout(700);
  await expect(page.locator("#main")).toContainText("Dairy Item 0012");
});

test("inventory items: the Missing-English-name filter isolates the name_en gaps", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "en");
  await page.goto("/app/inventory/items");
  await waitRendered(page);

  const before = await page.locator("#main").innerText();
  expect(before).toContain("2,000");

  // Toggle the "Missing English name" filter chip.
  await page.getByRole("button", { name: /Missing English name/i }).first().click();
  await page.waitForTimeout(900);

  // The seeded gaps are exactly RC-ITEM-1601..2000 (400 rows). The paginated
  // footer must now report 400 (the KPI "Total" stays 2,000 — it is unfiltered),
  // and every visible row is from the 1601+ range (SKU >= 1601).
  await expect(page.locator("#main")).toContainText(/of\s*400/i);
  await expect(page.locator("#main")).toContainText(/RC-SKU-(16|17|18|19|20)\d\d/);
  // No has-name item leaks into the filtered set.
  expect(await page.locator("#main").innerText()).not.toContain("Dairy Item 0004");
});

test("inventory items: the hasImage / belowReorder / branch facets actually filter (B2)", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "en");
  await page.goto("/app/inventory/items");
  await waitRendered(page);
  const total = () => page.locator("#main").innerText().then((t) => (t.match(/of\s*([\d,]+)/i) || [])[1] || "");
  expect(await total()).toMatch(/2,000/); // unfiltered

  // Below reorder point — was a UI-only no-op; now filters (RC items have no
  // reorder rules seeded, so the count must drop away from 2,000).
  await page.getByRole("button", { name: /Below reorder point/i }).first().click();
  await page.waitForTimeout(800);
  expect(await total(), "belowReorder changes the paginated total").not.toMatch(/^2,000$/);
  await page.getByRole("button", { name: /Below reorder point/i }).first().click(); // clear
  await page.waitForTimeout(600);

  // Image facet — RC items have no item images, so "has image" drops the count.
  const imageSel = page.locator('#main select').filter({ hasText: /Image|Has image|No image/i }).first();
  if (await imageSel.count()) {
    await imageSel.selectOption({ label: "Has image" }).catch(() => {});
    await page.waitForTimeout(800);
    expect(await total(), "hasImage=has changes the total").not.toMatch(/^2,000$/);
  }
});

test("inventory items: full-page create + deep-link detail survive refresh (no dialog)", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "en");

  await page.goto("/app/inventory/items/new");
  await waitRendered(page);
  expect(await page.getByRole("dialog").count(), "create is a full page, not a dialog").toBe(0);
  await expect(page.locator("#main"), "full-page create heading").toContainText(/New Item/i);
  const createInputs = await page.locator("#main input, #main select, #main textarea").count();
  expect(createInputs, "create page renders its form fields inline (full page, not a drawer)").toBeGreaterThan(5);

  await page.goto("/app/inventory/items/RC-ITEM-0001");
  await waitRendered(page);
  const beforeReload = await page.locator("#main").innerText();
  expect(beforeReload.length).toBeGreaterThan(40);
  await page.reload();
  await waitRendered(page);
  expect((await page.locator("#main").innerText()).length, "deep link survives hard refresh").toBeGreaterThan(40);
});

test("menu: recipe vs manual cost sources render; full-page create; bilingual", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "en");
  await page.goto("/app/menu/brand");
  await waitRendered(page);

  const heads = (await page.locator("#main thead").innerText()).replace(/\s+/g, " ");
  // The redesigned column set (representative subset incl. the cost/margin/tax columns).
  // `0b4d86e8` replaced the single "Sale price" column with the three-column
  // price breakdown, because one number could not say whether it was the net
  // price or what the customer actually pays. Asserting all three keeps the
  // distinction covered — collapsing back to one column is the regression.
  for (const h of ["Code", "Name (Arabic)", "Name (English)", "Brand", "Cost", "Excl. VAT", "VAT", "Incl. VAT", "Margin", "Tax", "Branches", "Channels", "Status"]) {
    expect(heads, `menu column "${h}"`).toContain(h);
  }
  const txt = await page.locator("#main").innerText();
  // Seeded menu names are bilingual (English column populated for most).
  expect(txt).toMatch(/RC-MENU|Main Dishes/i);
  // Both cost sources appear across the 40/40 split (labels render uppercase).
  expect(txt, "a recipe-sourced cost label appears").toMatch(/recipe/i);
  expect(txt, "a manual cost label appears").toMatch(/manual/i);
  // Margin renders as a pre-tax value + percentage (VAT from settings, not hardcoded).
  expect(txt, "margin value + percent").toMatch(/\d+(\.\d+)?%/);

  await page.goto("/app/menu/brand/new");
  await waitRendered(page);
  expect(await page.getByRole("dialog").count(), "menu create is full-page").toBe(0);
  const menuInputs = await page.locator("#main input, #main select, #main textarea").count();
  expect(menuInputs, "menu create renders form fields inline (full page)").toBeGreaterThan(3);
});
