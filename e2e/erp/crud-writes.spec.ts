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
import { test, expect, Page, APIRequestContext, Locator } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const CRASH_TEXT = "حدث خطأ غير متوقّع";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

/**
 * Seeding localStorage is NOT enough to pick the language.
 *
 * app/providers/language-sync.tsx applies the SERVER-persisted preference from
 * GET /api/user-preferences on mount, and setLang() overwrites both the
 * in-memory language and the localStorage value just seeded. This spec's very
 * first run proved it: every field rendered as «الرمز / SKU» and the English
 * selector timed out. i18n-cairo-crud.spec.ts documents the same trap — and its
 * own afterEach upserts a permanent row, so the server now always has an
 * answer. Pin the response instead of hoping the seed survives.
 */
async function login(page: Page, lang: "ar" | "en") {
  await page.route("**/api/user-preferences", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ language: lang }) });
  });
  return page.addInitScript(
    ([token, session, l]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("erp_lang", l);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" }), lang],
  );
}

/**
 * Activate a bottom-of-form action button with a REAL pointer tap — the way a
 * user does.
 *
 * This used to focus the button and press Enter: on mobile-390 the fixed "Quick
 * navigation" dock (`<nav>`, `z-40`, `lg:hidden`) floated over the bottom of the
 * viewport and intercepted the pointer, so a genuine click reported "nav subtree
 * intercepts pointer events". The product now lifts full-page form action bars
 * above that dock below `lg` — ItemFormPage's fixed save bar and the shared
 * sticky FormActions both add a MobileNav clearance — so the button is a real,
 * actionable tap target at every viewport, and the keyboard workaround is no
 * longer needed. Playwright still enforces full actionability (visible, enabled,
 * stable, unobscured): NOT `force`, NOT a retry loop, NOT a raised timeout — so
 * if the dock ever overlays the button again this click times out and fails.
 */
async function clickClear(locator: Locator) {
  await expect(locator).toBeEnabled();
  await locator.click();
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
 * Contract read from routes/inventory-items.js: free-text parameter `q`
 * (parseListQuery maps query.q → p.q), response `{ data, pagination, kpis,
 * filters }`, SKU column `sku`, and inactive rows included unless `status` is
 * passed — which is what lets the deactivate step below still find the row.
 *
 * The PATH cost a run to get right, and the lesson is worth keeping: reading
 * routes/inventory-items.js was not the same as reading the route that serves
 * this URL. `/api/inventory/items` is owned by the LEGACY routes/inventory.js
 * (server.js mounts it at /api/inventory), which answers a bare array with no
 * `sku` at all — so the lookup returned 20 rows of `sku: null` and the test
 * reported "not persisted" for an item that had been written perfectly.
 * inventory-items.js is mounted at /api/inventory/V2 (server.js:726), which is
 * also what the UI calls (ItemsPage.tsx). Verify against the endpoint the
 * product actually uses.
 */
async function fetchItemBySku(request: APIRequestContext, sku: string) {
  const res = await request.get(`/api/inventory/v2/items?q=${encodeURIComponent(sku)}&pageSize=50`, { headers: AUTH });
  expect(res.ok(), `inventory items API reachable (q=${sku})`).toBe(true);
  const body = await res.json();
  const rows: any[] = Array.isArray(body) ? body : (body.data ?? []);
  const hit = rows.find((r) => String(r.sku ?? "").trim() === sku) ?? null;
  if (!hit) {
    // Say WHY, instead of just "null". Guessing at this cost a run already.
    console.log(
      "[crud-writes] no match for sku=" + sku +
      " | rows=" + rows.length +
      " | total=" + JSON.stringify(body?.pagination?.total) +
      " | filters=" + JSON.stringify(body?.filters) +
      " | skus=" + JSON.stringify(rows.slice(0, 5).map((r) => r.sku)),
    );
  }
  return hit;
}

const JSON_HDR = { ...AUTH, "Content-Type": "application/json" };

/** .env reader — the E2E DB connection uses the same host/creds the server does. */
function readDotEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

/**
 * A menu product read straight from the API — the second, independent channel.
 * Contract from routes/menu.js: GET /api/menu/list?q= (Bearer required) answers
 * `{ data:[{id,name,nameEn,price,cost,costSource,taxCategory,active}], pagination }`.
 * `q` matches name / nameEn / id (LIKE), so we match on the exact English name.
 */
async function fetchMenuByName(request: APIRequestContext, nameEn: string) {
  const res = await request.get(`/api/menu/list?q=${encodeURIComponent(nameEn)}&pageSize=50`, { headers: AUTH });
  expect(res.ok(), `menu list API reachable (q=${nameEn})`).toBe(true);
  const body = await res.json();
  const rows: any[] = body.data ?? [];
  return rows.find((r) => String(r.nameEn ?? "").trim() === nameEn) ?? null;
}

/** A real inventory item id, so a recipe BOM can reference an existing component. */
async function firstInvItemId(request: APIRequestContext): Promise<string | null> {
  const res = await request.get(`/api/inventory/v2/items?pageSize=1`, { headers: AUTH });
  if (!res.ok()) return null;
  const body = await res.json();
  const rows: any[] = Array.isArray(body) ? body : (body.data ?? []);
  return rows[0]?.id ? String(rows[0].id) : null;
}

/**
 * How many gl_entries / warehouse_stock rows a menu product touched — the proof
 * that saving a product DEFINITION has no financial or inventory side effects
 * (routes/menu.js's create/update touch only the `menu` table). Queried straight
 * from the E2E DB, the same isolated clone the server writes to.
 */
async function countSideEffects(menuId: string): Promise<{ gl: number; stock: number }> {
  const mysql = require("mysql2/promise");
  const { e2eDbConfig } = require("../e2e-db-name");
  const conn = await mysql.createConnection(e2eDbConfig(readDotEnv()));
  try {
    // GL provenance lives on gl_journals (reference_type/reference_id); gl_entries
    // link to a journal. A menu definition that posted to the ledger would leave
    // a journal referencing its MENU- id. warehouse_stock keys items by item_id.
    const [[glRow]] = await conn.query(
      "SELECT COUNT(*) AS n FROM gl_journals WHERE reference_id = ? OR reference_id LIKE ?",
      [menuId, `${menuId}%`],
    );
    const [[stkRow]] = await conn.query("SELECT COUNT(*) AS n FROM warehouse_stock WHERE item_id = ?", [menuId]);
    return { gl: Number(glRow.n) || 0, stock: Number(stkRow.n) || 0 };
  } finally {
    await conn.end();
  }
}

/**
 * The AUTHORITATIVE cost provenance for a menu row — read straight from the
 * `menu.cost_source` column, the same way tests/integration/costSource.api.test.js
 * verifies the override. The list endpoint's `costSource` field is a projection
 * of this column, but reading the column removes any doubt about derivation.
 */
async function menuCostSource(menuId: string): Promise<string | null> {
  const mysql = require("mysql2/promise");
  const { e2eDbConfig } = require("../e2e-db-name");
  const conn = await mysql.createConnection(e2eDbConfig(readDotEnv()));
  try {
    const [[row]] = await conn.query("SELECT cost_source AS s, cost AS c FROM menu WHERE id = ?", [menuId]);
    return row ? (row.s ?? null) : null;
  } finally {
    await conn.end();
  }
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

    await clickClear(page.getByRole("button", { name: /^(Create item|Save)$/ }).first());

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
    await clickClear(page.getByRole("button", { name: /^(Save changes|Save)$/ }).first());
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
    // Deactivation is a STATE TRANSITION, not a field edit: PATCH /items/:id
    // ignores `active` entirely, and routes/inventory-items.js:485 exposes
    // POST /items/:id/deactivate for it. Both enforce optimistic concurrency,
    // so the caller must echo back the version it last read — exactly as the
    // UI does. Getting this wrong is what made the first run report "still
    // active": the PATCH succeeded and changed nothing at all.
    const current = await fetchItemBySku(request, code);
    expect(current, "the item is still readable before deactivating").not.toBeNull();
    const res = await request.post(`/api/inventory/v2/items/${createdId}/deactivate`, {
      headers: { ...AUTH, "Content-Type": "application/json" },
      data: { expectedVersion: Number(current.version), reason: "E2E CRUD coverage" },
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

test("menu product: create → read → deep-link → edit → cost-lock → deactivate, all persisted", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  const suffix = uniqueSuffix(testInfo.project.name);
  const nameAr = `منتج اختبار ${suffix}`;
  const nameEn = `E2E Product ${suffix}`;
  const nameEnEdited = `${nameEn} EDITED`;
  const nameEnField = () => page.getByRole("textbox", { name: "Name in English" });

  await login(page, "en");

  // ── CREATE (through the real form) ──────────────────────────────────────────
  let createdId = "";
  await test.step("create a brand-new AR+EN product through the form", async () => {
    await page.goto("/app/menu/brand/new");
    await waitRendered(page);

    // Role locators use the ACCESSIBLE NAME, which excludes the aria-hidden
    // required asterisk. The previous anchored getByLabel(/^Name in Arabic$/)
    // matched the <label>'s textContent "Name in Arabic *" — never — and hung
    // 180s. This is the correct locator for this (fully accessible) field.
    await page.getByRole("combobox", { name: "Brand" }).selectOption({ label: "Moroccan Taste" });
    await page.getByRole("textbox", { name: "Name in Arabic" }).fill(nameAr);
    await nameEnField().fill(nameEn);
    await page.getByRole("spinbutton", { name: "Sale price" }).fill("25");
    await clickClear(page.getByRole("button", { name: "Create product" }));
  });

  await test.step("the API confirms the product was really persisted", async () => {
    // Channel 2 (API). Poll: the create is a round trip, and the menu route
    // answers HTTP 200 even on failure, so we assert the ROW exists — not a status.
    await expect
      .poll(async () => (await fetchMenuByName(request, nameEn))?.nameEn ?? null, {
        timeout: 20_000,
        message: `a product named "${nameEn}" exists in the database after create`,
      })
      .toBe(nameEn);
    const row = await fetchMenuByName(request, nameEn);
    expect(Number(row.price), "the price persisted").toBe(25);
    expect(Number(row.active), "created active").toBe(1);
    createdId = String(row.id);
    expect(createdId, "id is a real MENU- id").toMatch(/^MENU-/);
  });

  await test.step("the definition write created NO gl_entries and NO warehouse_stock rows", async () => {
    // Item 7, half one: saving a product DEFINITION is a pure catalog write — it
    // must never post to the ledger or move stock. Asserted straight from the DB.
    const { gl, stock } = await countSideEffects(createdId);
    expect(gl, "menu definition must not post to the ledger").toBe(0);
    expect(stock, "menu definition must not move stock").toBe(0);
  });

  // ── READ BACK: list + deep-link both survive a hard refresh (Channel 1, UI) ──
  await test.step("the deep-link detail page survives a hard refresh", async () => {
    await page.goto(`/app/menu/brand/${createdId}`);
    await waitRendered(page);
    await expect(nameEnField(), "detail page shows the product").toHaveValue(nameEn, { timeout: 20_000 });
    await page.reload();
    await waitRendered(page);
    await expect(nameEnField(), "deep link survives a hard refresh").toHaveValue(nameEn, { timeout: 20_000 });
  });

  // ── UPDATE (PUT needs a FULL body — mysql2 rejects undefined binds) ──────────
  await test.step("edit the English name via the API and re-verify from the server", async () => {
    const row = await fetchMenuByName(request, nameEn);
    const res = await request.put(`/api/menu/${createdId}`, {
      headers: JSON_HDR,
      data: {
        name: row.name, category: row.category ?? "عام", stock: 0, minStock: 0, active: true,
        nameEn: nameEnEdited, price: Number(row.price), taxCategory: row.taxCategory ?? "S",
      },
    });
    const body = await res.json();
    expect(body.success, `edit accepted (body: ${JSON.stringify(body)})`).toBe(true);
    await expect
      .poll(async () => (await fetchMenuByName(request, nameEnEdited))?.nameEn ?? null, {
        timeout: 20_000, message: "the edited English name reached the database",
      })
      .toBe(nameEnEdited);
  });

  // ── COST LOCK (item 7, half two): recipe cost cannot be manually overwritten ──
  await test.step("recipe cost-lock: a manual cost edit is 409 COST_LOCKED_BY_RECIPE, unlocked only by costOverride", async () => {
    const component = await firstInvItemId(request);
    expect(component, "a real inventory item exists to compose a recipe from").toBeTruthy();

    const bom = await request.post(`/api/menu/${createdId}/recipe-bom`, {
      headers: JSON_HDR,
      data: { lines: [{ componentItemId: component, quantity: 1 }], yield_quantity: 1, yield_unit: "portion" },
    });
    expect((await bom.json()).success, "recipe BOM attached (stamps cost_source=recipe)").toBe(true);

    const cur = await fetchMenuByName(request, nameEnEdited);
    // The FULL field set (incl. nameEn + price) so the PUT does not blank other
    // columns — the menu route rewrites every field on every PUT, so omitting
    // nameEn here would wipe the English name and the product would drop out of
    // a name search. A cost strictly different from the recipe-computed one, so
    // `_costChanged` is unambiguously true.
    const base = {
      name: cur.name, nameEn: nameEnEdited, category: cur.category ?? "عام",
      stock: 0, minStock: 0, active: true, price: Number(cur.price), taxCategory: cur.taxCategory ?? "S",
    };
    const overrideCost = Number(cur.cost || 0) + 137.5;

    const locked = await request.put(`/api/menu/${createdId}`, { headers: JSON_HDR, data: { ...base, cost: overrideCost } });
    expect(locked.status(), "a manual cost edit on a recipe-costed product is refused").toBe(409);
    expect((await locked.json()).code, "with the documented lock code").toBe("COST_LOCKED_BY_RECIPE");

    const unlocked = await request.put(`/api/menu/${createdId}`, { headers: JSON_HDR, data: { ...base, cost: overrideCost, costOverride: true } });
    expect((await unlocked.json()).success, "costOverride:true unlocks the write").toBe(true);
    // Assert the AUTHORITATIVE column, not the list projection.
    await expect
      .poll(async () => await menuCostSource(createdId), {
        timeout: 20_000, message: "overriding the recipe cost flips cost_source back to manual",
      })
      .toBe("manual");
    // And the product is still findable by its (unchanged) English name.
    expect(await fetchMenuByName(request, nameEnEdited), "the product survived the cost edits").not.toBeNull();
  });

  // ── DEACTIVATE / CLEANUP (menu uses soft-delete, NOT inventory's expectedVersion) ──
  await test.step("soft-delete removes it from the catalog (cleanup)", async () => {
    const del = await request.delete(`/api/menu/${createdId}`, { headers: AUTH });
    expect((await del.json()).softDeleted, "soft-delete accepted").toBe(true);
    await expect
      .poll(async () => await fetchMenuByName(request, nameEnEdited), {
        timeout: 20_000, message: "the product is gone from the catalog after soft-delete",
      })
      .toBeNull();
  });
});
