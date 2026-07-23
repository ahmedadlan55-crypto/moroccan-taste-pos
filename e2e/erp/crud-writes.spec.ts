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

// ── UNFINISHED, and deliberately left FAILING rather than skipped ───────────
// The inventory half above is complete and green. This one is not: the first
// fill on /app/menu/brand/new times out even though the accessible name is
// right there in the a11y snapshot ("Name in Arabic", textbox, not disabled),
// so the cause is something about when the form becomes interactive that I have
// not diagnosed. It is left red on purpose — marking it test.skip() would turn
// "menu CRUD is unverified" into a green tick, which is the exact failure mode
// this whole closeout has been removing.
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
