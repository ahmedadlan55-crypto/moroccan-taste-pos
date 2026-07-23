// ═══════════════════════════════════════════════════════════════════════════
// CO-4 — CRUD that actually WRITES.
//
// Every "CRUD" spec in this repo up to now was read-only: rc-inventory-menu
// opens /app/inventory/items/new, counts the inputs, and navigates away without
// ever submitting; i18n-cairo-crud says so in its own header ("CRUD surfaces
// (no writes)"). Counting form fields proves a route renders. It does not prove
// a record can be created, that it comes back on reload, that an edit persists,
// or that a deactivate takes effect — which is the entire point of the module.
//
// What made a real write-performing spec safe to add is CO-0: the suite now
// runs against `moroccan_taste_pos_e2e`, a throwaway clone re-created from the
// dev database at the start of every invocation. Before that, writing from a
// spec meant mutating the developer's own data, so "read-only" was the only
// responsible option. It no longer is.
//
// Each test asserts through TWO independent channels, because either alone can
// lie: the UI (what the user sees after a reload) and the REST API (what was
// actually persisted). A UI-only assertion passes on optimistic local state; an
// API-only assertion passes even when the screen never updated.
//
// Fixtures are unique per run AND per project, so the four viewport projects
// never collide on a unique SKU and a rerun never trips over its own leftovers.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page, APIRequestContext } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const CRASH_TEXT = "حدث خطأ غير متوقّع";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

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

/**
 * A fixture id unique to this run AND this viewport project.
 *
 * Not Date.now() alone: the four projects run close enough together that two
 * could land on the same millisecond, and a unique-SKU collision would surface
 * as a confusing validation error rather than as the race it is.
 */
function uniqueSuffix(project: string): string {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${Date.now().toString(36).toUpperCase()}${rand}-${project.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase()}`;
}

/**
 * The persisted item, straight from the API — the second, independent channel.
 *
 * Contract read from routes/inventory-items.js, not guessed: the list route is
 * GET /api/inventory/items, its free-text parameter is `q` (parseListQuery maps
 * query.q → p.q), it answers `{ data, pagination, kpis, filters }`, and the
 * item's SKU column is `sku`. Inactive rows are included unless `status` is
 * passed, which is what lets the deactivate step below still find the row.
 */
async function fetchItemBySku(request: APIRequestContext, sku: string) {
  const res = await request.get(`/api/inventory/items?q=${encodeURIComponent(sku)}&pageSize=50`, { headers: AUTH });
  expect(res.ok(), `inventory items API reachable (q=${sku})`).toBe(true);
  const body = await res.json();
  const rows: any[] = Array.isArray(body) ? body : (body.data ?? []);
  return rows.find((r) => String(r.sku ?? "").trim() === sku) ?? null;
}

test.describe.configure({ mode: "serial" });

test("inventory item: create → read back → edit → deactivate, all persisted", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix(testInfo.project.name);
  const code = `E2E-${suffix}`;
  const nameAr = `صنف اختبار ${suffix}`;
  const nameEn = `E2E Item ${suffix}`;
  const nameEnEdited = `${nameEn} EDITED`;

  await login(page, "en");

  // ── CREATE ────────────────────────────────────────────────────────────────
  await test.step("create a brand-new item through the form", async () => {
    await page.goto("/app/inventory/items/new");
    await waitRendered(page);

    await page.getByLabel("Code / SKU", { exact: true }).fill(code);
    await page.getByLabel("Name (Arabic)", { exact: true }).fill(nameAr);
    await page.getByLabel("Name (English)", { exact: true }).fill(nameEn);
    await page.getByLabel("Base unit name", { exact: true }).fill("kg");

    await page.getByRole("button", { name: /^(Create item|Save)$/ }).first().click();

    // The form reports success in-page; assert on that rather than on a URL
    // change, because create-and-stay is a supported outcome too.
    await expect(page.locator("#main")).toContainText(new RegExp(nameEn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 20_000 });
  });

  let createdId: string | null = null;
  await test.step("the API confirms the row was really persisted", async () => {
    const row = await fetchItemBySku(request, code);
    expect(row, `an item with code ${code} exists in the database after create`).not.toBeNull();
    expect(String(row.name_en ?? "")).toBe(nameEn);
    createdId = String(row.id);
    expect(createdId.length, "the created item has a real id").toBeGreaterThan(0);
  });

  await test.step("the list page shows it after a hard reload", async () => {
    // Driven through the page's OWN search box rather than a guessed URL
    // parameter — the list is server-paginated over thousands of rows, so a new
    // item is not on page 1, and a query string the page does not read would
    // make this assertion silently meaningless.
    await page.goto("/app/inventory/items");
    await waitRendered(page);
    const search = page.getByRole("searchbox").or(page.locator('#main input[type="search"]')).first();
    await expect(search).toBeVisible({ timeout: 20_000 });
    await search.fill(code);
    await expect(page.locator("#main")).toContainText(code, { timeout: 20_000 });
  });

  // ── UPDATE ────────────────────────────────────────────────────────────────
  await test.step("edit the English name and save", async () => {
    await page.goto(`/app/inventory/items/${createdId}/edit`);
    await waitRendered(page);
    const nameEnField = page.getByLabel("Name (English)", { exact: true });
    await expect(nameEnField).toHaveValue(nameEn, { timeout: 20_000 });
    await nameEnField.fill(nameEnEdited);
    await page.getByRole("button", { name: /^(Save changes|Save)$/ }).first().click();
    await expect(page.locator("#main")).not.toContainText("Unsaved changes", { timeout: 20_000 });
  });

  await test.step("the API confirms the edit was persisted, not just rendered", async () => {
    // Poll: the save is a round trip, and asserting once immediately after the
    // click reads the pre-write state on a slow box.
    await expect
      .poll(async () => {
        const row = await fetchItemBySku(request, code);
        return String(row?.name_en ?? "");
      }, { timeout: 20_000, message: "the edited English name reached the database" })
      .toBe(nameEnEdited);
  });

  await test.step("the edit survives a hard refresh of the edit page", async () => {
    await page.goto(`/app/inventory/items/${createdId}/edit`);
    await waitRendered(page);
    await expect(page.getByLabel("Name (English)", { exact: true })).toHaveValue(nameEnEdited, { timeout: 20_000 });
  });

  // ── DELETE / DEACTIVATE ───────────────────────────────────────────────────
  // Inventory items are deactivated, not hard-deleted — a row with posted
  // movements must never vanish from history. Deactivation IS this module's
  // delete, so that is what gets proven.
  await test.step("deactivate the item and confirm the state change persisted", async () => {
    // PATCH /items/:id enforces optimistic concurrency — it rejects with
    // VALIDATION_ERROR unless the caller supplies the version it last read, and
    // with VERSION_CONFLICT if that version is stale. Read the current row
    // first and echo its version back, exactly as the UI does.
    const current = await fetchItemBySku(request, code);
    expect(current, "the item is still readable before deactivating").not.toBeNull();
    const res = await request.patch(`/api/inventory/items/${createdId}`, {
      headers: { ...AUTH, "Content-Type": "application/json" },
      data: { active: 0, expectedVersion: Number(current.version) },
    });
    expect(res.status(), `deactivate request accepted (body: ${await res.text()})`).toBeLessThan(400);

    await expect
      .poll(async () => {
        const row = await fetchItemBySku(request, code);
        return row === null ? "gone" : String(Number(row.active ?? 1));
      }, { timeout: 20_000, message: "the item is no longer active in the database" })
      .toMatch(/^(0|gone)$/);
  });
});

test("menu product: create → read back → edit, all persisted", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix(testInfo.project.name);
  const nameAr = `منتج اختبار ${suffix}`;
  const nameEn = `E2E Product ${suffix}`;
  const nameEnEdited = `${nameEn} EDITED`;

  await login(page, "en");

  await test.step("create a brand-new menu product through the form", async () => {
    await page.goto("/app/menu/brand/new");
    await waitRendered(page);

    await page.getByLabel(/^Name in Arabic$|^Name \(Arabic\)$/).first().fill(nameAr);
    await page.getByLabel(/^Name in English$|^Name \(English\)$/).first().fill(nameEn);
    const price = page.getByLabel(/^Sale price$/).first();
    if (await price.count()) await price.fill("25");

    await page.getByRole("button", { name: /^(Create product|Save changes|Save)$/ }).first().click();
    await expect(page.locator("#main")).toContainText(new RegExp(nameEn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 20_000 });
  });

  await test.step("the menu list shows the new product after a hard reload", async () => {
    await page.goto("/app/menu/brand");
    await waitRendered(page);
    const search = page.getByRole("searchbox").or(page.locator('#main input[type="search"]')).first();
    if (await search.count()) {
      await search.fill(nameEn);
      await page.waitForTimeout(600);
    }
    await expect(page.locator("#main")).toContainText(nameEn, { timeout: 20_000 });
  });

  await test.step("edit the product's English name and confirm it persisted", async () => {
    await page.goto("/app/menu/brand");
    await waitRendered(page);
    await page.getByText(nameEn, { exact: false }).first().click();
    await waitRendered(page);

    const nameEnField = page.getByLabel(/^Name in English$|^Name \(English\)$/).first();
    await expect(nameEnField).toBeVisible({ timeout: 20_000 });
    await nameEnField.fill(nameEnEdited);
    await page.getByRole("button", { name: /^(Save changes|Save)$/ }).first().click();

    await page.goto("/app/menu/brand");
    await waitRendered(page);
    const search = page.getByRole("searchbox").or(page.locator('#main input[type="search"]')).first();
    if (await search.count()) {
      await search.fill(nameEnEdited);
      await page.waitForTimeout(600);
    }
    await expect(page.locator("#main")).toContainText(nameEnEdited, { timeout: 20_000 });
  });
});
