// ═══════════════════════════════════════════════════════════════════════════
// "O2C return + manager approval" — a real cash sale, a real PARTIAL return
// request raised by the cashier THROUGH THE REAL UI, and a real manager
// approve→post producing a credit note, exercised end to end against the live
// server (/pos + /app).
//
// Infra: /pos and /app are served by the SAME server.js process (confirmed by
// reading server.js — both dists are mounted unconditionally on one Express
// app), so this spec boots ONE dedicated server (playwright.o2c-return.config.ts,
// port 3029) and drives it from TWO separate browser CONTEXTS — a cashier
// context on /pos and a manager context on /app — because both apps share the
// same localStorage token key (`pos_token`) on one origin; two contexts keep
// the two sessions from clobbering each other, exactly like two devices would.
//
// Modeled on e2e/pos/critical-cashier-shift.spec.ts's conventions: .env-read DB
// creds via mysql2/promise, serial mode, full beforeAll/afterAll teardown, real
// console-error/4xx hygiene listeners (STRICT, no whitelist), real screenshots.
//
// ── FORMERLY A REAL BUG, NOW FIXED — GET /api/sales/invoice/:orderId
// (routes/sales.js) used to never return a line's `ar_document_lines` id or the
// invoice's `version`, so ReturnRequestDialog fell back to the array position
// as originalLineId and every real return-request submission from the till
// 422'd with VALIDATION_ERROR "سطر أصلي غير موجود: 0". The endpoint now joins
// `ar_documents`/`ar_document_lines` (source_type='pos', source_line_id =
// 'L'+ordinal) and returns a real per-item `lineId` plus a top-level `version`,
// so the cashier's real "مرتجع" UI flow is asserted below as the PRIMARY,
// successful path — no bug-report/recovery workaround needed anymore.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

import { e2eDbConfig } from "../e2e-db-name";
/* eslint-disable @typescript-eslint/no-var-requires */
const mysql = require("mysql2/promise");

const CASHIER_USERNAME = "test.cashier";
const MANAGER_USERNAME = "seed_manager";
const WAREHOUSE_ID = "E2E-WH";
const OPENING_FLOAT = 300;

const SCRATCHPAD_ACCOUNTS_FILE =
  "C:\\Users\\5CF8~1\\AppData\\Local\\Temp\\claude\\C--Users------------Downloads-moroccan-taste-pos-main\\57b1b816-a57e-4200-95f4-fc3dfbc9ef99\\scratchpad\\test-accounts.txt";
const CASHIER_BLOCK_MARKER = "[CASHIER (branch + warehouse)]";
const MANAGER_BLOCK_MARKER = "[MANAGER (E2E, password reset by this session)]";

// Fixture tag — kept as an ASCII PREFIX on every seeded id/name so a LIKE sweep
// (crash-recovery pre-clean, and this run's own teardown) can find every row
// this spec ever creates, regardless of which run created it.
const TAG = `ITEST-O2CRET-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const LIKE_TAG = "ITEST-O2CRET-%";
const ING_A = `${TAG}-INGA`;
const MENU_A = `${TAG}-MENUA`;
const MENU_B = `${TAG}-MENUB`;
// Names carry the ASCII tag as a literal prefix too, so sales_items rows (which
// only remember the item NAME, not its id) are still findable by LIKE.
const MENU_A_NAME = `${TAG} مرتجع أ`;
const MENU_B_NAME = `${TAG} مرتجع ب`;

const MENU_A_PRICE = 25;
const MENU_B_PRICE = 12;
const MENU_A_QTY = 3;
const MENU_B_QTY = 2;
const RETURN_QTY = 1; // partial — less than the 3 sold
const RETURN_REASON = "صنف غير مطابق — اختبار E2E للمرتجعات";
const ING_A_STOCK_QTY_PER_UNIT = 2; // recipe: 2kg of ING_A per MENU_A unit
const ING_A_START_STOCK = 500;

function readEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

/** Extract a scratchpad block's CURRENT password. Never logged. */
function readPassword(marker: string): string {
  const text = fs.readFileSync(SCRATCHPAD_ACCOUNTS_FILE, "utf8");
  const idx = text.indexOf(marker);
  if (idx === -1) throw new Error(`block not found in scratchpad accounts file: ${marker}`);
  const block = text.slice(idx);
  const m = block.match(/password:\s*(\S+)/);
  if (!m) throw new Error(`password line not found for block: ${marker}`);
  return m[1];
}

/** Mirrors lib/order-to-cash/calculations.js's `money()` (round to 2dp with the
 *  same epsilon nudge) — used to compute the EXPECTED proportional return-line
 *  values from the REAL persisted original-line numbers, never a hand-rolled
 *  independent tax computation (that would just be re-deriving, which is
 *  exactly the anti-pattern this whole flow is supposed to avoid). */
function money2(v: number): number {
  const n = Number(v) || 0;
  const eps = n >= 0 ? 1e-9 : -1e-9;
  return Math.round((n + eps) * 100) / 100;
}

function genIdemKey(label: string): string {
  return `E2E-O2CRET-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cashierPassword: string;
let managerPassword: string;
let cashierMustChangeOriginal = 1;
let managerMustChangeOriginal = 0;
let env: Record<string, string>;

test.describe.configure({ mode: "serial" });

/** Cascade-delete every row this spec (any run, any TAG) could have created.
 *  Best-effort per statement, mirroring tests/integration/posO2cProjection.api.test.js's
 *  cleanup() convention — a missing/renamed table must never mask the real
 *  assertions with an unrelated throw. */
async function cleanupResidue(conn: import("mysql2/promise").Connection) {
  const del = async (sql: string, params?: unknown[]) => {
    try { await conn.query(sql, params); } catch { /* best-effort */ }
  };
  let saleIds: string[] = [];
  try {
    const [rows] = await conn.query("SELECT DISTINCT order_id FROM sales_items WHERE item_name LIKE ?", [LIKE_TAG]);
    saleIds = (rows as Array<{ order_id: string }>).map((r) => r.order_id);
  } catch { /* ignore */ }

  let arDocIds: string[] = [];
  let retIds: string[] = [];
  if (saleIds.length) {
    const ph = saleIds.map(() => "?").join(",");
    try {
      const [arDocs] = await conn.query(
        `SELECT id FROM ar_documents WHERE source_type='pos' AND source_id IN (${ph})`, saleIds);
      arDocIds = (arDocs as Array<{ id: string }>).map((r) => r.id);
    } catch { /* ignore */ }
    if (arDocIds.length) {
      const ph2 = arDocIds.map(() => "?").join(",");
      try {
        const [cns] = await conn.query(`SELECT id FROM ar_documents WHERE original_document_id IN (${ph2})`, arDocIds);
        arDocIds = arDocIds.concat((cns as Array<{ id: string }>).map((r) => r.id));
      } catch { /* ignore */ }
    }
    try {
      const [rets] = await conn.query(`SELECT id FROM sales_returns WHERE original_sale_id IN (${ph})`, saleIds);
      retIds = (rets as Array<{ id: string }>).map((r) => r.id);
    } catch { /* ignore */ }
  }

  if (retIds.length) {
    const ph4 = retIds.map(() => "?").join(",");
    await del(`DELETE FROM sales_return_line_components WHERE return_id IN (${ph4})`, retIds);
    await del(`DELETE FROM sales_return_lines WHERE return_id IN (${ph4})`, retIds);
    await del(`DELETE FROM ar_events WHERE entity_type='sales_return' AND entity_id IN (${ph4})`, retIds);
    await del(
      `DELETE FROM gl_entries WHERE journal_id IN (SELECT id FROM gl_journals WHERE reference_type IN ('SalesReturn','SalesReturnCOGS') AND reference_id IN (${ph4}))`,
      retIds);
    await del(`DELETE FROM gl_journals WHERE reference_type IN ('SalesReturn','SalesReturnCOGS') AND reference_id IN (${ph4})`, retIds);
    await del(`DELETE FROM sales_returns WHERE id IN (${ph4})`, retIds);
  }
  if (arDocIds.length) {
    const ph3 = arDocIds.map(() => "?").join(",");
    await del(`DELETE FROM ar_document_line_components WHERE document_id IN (${ph3})`, arDocIds);
    await del(`DELETE FROM ar_document_lines WHERE document_id IN (${ph3})`, arDocIds);
    await del(`DELETE FROM ar_events WHERE entity_type='ar_document' AND entity_id IN (${ph3})`, arDocIds);
    await del(`DELETE FROM ar_documents WHERE id IN (${ph3})`, arDocIds);
  }
  if (saleIds.length) {
    const ph = saleIds.map(() => "?").join(",");
    await del(`DELETE FROM gl_entries WHERE journal_id IN (SELECT id FROM gl_journals WHERE reference_type='Sale' AND reference_id IN (${ph}))`, saleIds);
    await del(`DELETE FROM gl_journals WHERE reference_type='Sale' AND reference_id IN (${ph})`, saleIds);
    await del(`DELETE FROM inventory_movements WHERE reference_id IN (${ph})`, saleIds);
    await del(`DELETE FROM sales_items WHERE order_id IN (${ph})`, saleIds);
    await del(`DELETE FROM sales WHERE id IN (${ph})`, saleIds);
  }
  await del("DELETE FROM inventory_movements WHERE item_id LIKE ?", [LIKE_TAG]);
  await del("DELETE FROM warehouse_stock WHERE item_id LIKE ?", [LIKE_TAG]);
  await del("DELETE FROM recipe WHERE menu_id LIKE ?", [LIKE_TAG]);
  await del("DELETE FROM menu WHERE id LIKE ?", [LIKE_TAG]);
  await del("DELETE FROM inv_items WHERE id LIKE ?", [LIKE_TAG]);
}

test.beforeAll(async () => {
  env = readEnv();
  db = await mysql.createConnection({
    ...e2eDbConfig(env), // database ALWAYS from e2e/e2e-db-name.ts — never .env DB_NAME
  });

  // Defensive pre-clean: a prior crashed run must never block this one.
  await cleanupResidue(db);
  await db.query("DELETE FROM shifts WHERE username = ?", [CASHIER_USERNAME]);

  cashierPassword = readPassword(CASHIER_BLOCK_MARKER);
  managerPassword = readPassword(MANAGER_BLOCK_MARKER);

  const [[cashierRow]] = await db.query(
    "SELECT must_change_password FROM users WHERE username = ?", [CASHIER_USERNAME]);
  cashierMustChangeOriginal = Number(cashierRow.must_change_password);
  const [[managerRow]] = await db.query(
    "SELECT must_change_password FROM users WHERE username = ?", [MANAGER_USERNAME]);
  managerMustChangeOriginal = Number(managerRow.must_change_password);

  // Skip the forced-change UI for both accounts (already proven elsewhere by
  // critical-cashier-shift.spec.ts) so login goes straight to the shell.
  await db.query("UPDATE users SET must_change_password = 0 WHERE username = ?", [CASHIER_USERNAME]);
  if (managerMustChangeOriginal) {
    await db.query("UPDATE users SET must_change_password = 0 WHERE username = ?", [MANAGER_USERNAME]);
  }

  // ── seed catalog fixtures: a recipe-backed item (provably stock-tracked) +
  //    a plain item, so the invoice has 2 distinct lines and the partial return
  //    of ONE line is a meaningful, distinguishable test. ────────────────────
  await db.query(
    "INSERT INTO inv_items (id, name, category, cost, stock, unit, active, kind) VALUES (?,?,?,?,?,?,1,?)",
    [ING_A, `${TAG} ingredient`, "ITEST", 4.0, 0, "kg", "raw"]);
  await db.query(
    "INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) " +
    "VALUES (?,?,?,?,?,?,1,?,1,?)",
    [MENU_A, MENU_A_NAME, MENU_A_PRICE, "ITEST", 0, 0, "S", "made_at_branch"]);
  await db.query(
    "INSERT INTO menu (id, name, price, category, cost, stock, active, tax_category, is_tax_inclusive, production_method) " +
    "VALUES (?,?,?,?,?,?,1,?,1,?)",
    [MENU_B, MENU_B_NAME, MENU_B_PRICE, "ITEST", 0, 0, "S", "made_at_branch"]);
  await db.query(
    "INSERT INTO recipe (menu_id, menu_name, inv_item_id, inv_item_name, qty_used) VALUES (?,?,?,?,?)",
    [MENU_A, MENU_A_NAME, ING_A, `${TAG} ingredient`, ING_A_STOCK_QTY_PER_UNIT]);
  await db.query(
    "INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty, added_by) VALUES (?,?,?,?,?)",
    [`WS-${TAG}`, WAREHOUSE_ID, ING_A, ING_A_START_STOCK, "e2e-seed"]);
});

test.afterAll(async () => {
  try {
    if (db) {
      await db.query(
        "UPDATE users SET must_change_password = ? WHERE username = ?",
        [cashierMustChangeOriginal, CASHIER_USERNAME]);
      // Only touch the manager's flag if THIS run actually changed it.
      if (managerMustChangeOriginal) {
        await db.query("UPDATE users SET must_change_password = 1 WHERE username = ?", [MANAGER_USERNAME]);
      }
      await db.query("DELETE FROM shifts WHERE username = ?", [CASHIER_USERNAME]);
      await cleanupResidue(db);
    }
  } finally {
    if (db) await db.end();
  }
});

test("O2C return + manager approval — real sale, partial return, SoD, over-return, idempotency, credit note", async ({
  page, context, browser, request,
}, testInfo) => {
  test.setTimeout(480_000);
  const artifactsDir = path.join(process.cwd(), "artifacts", "e2e", "o2c", "return-approval");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const shot = async (p: Page, name: string) => {
    await p.screenshot({ path: path.join(artifactsDir, `${name}-${testInfo.project.name}.png`), fullPage: true });
  };

  // ── hygiene listeners — BEFORE any navigation, on BOTH the cashier page
  //    (created below via the built-in `page` fixture) and the manager page
  //    (a second, manually-created context) — zero console errors / zero
  //    4xx+5xx, no whitelist, matching this project's established convention. ──
  const consoleErrors: string[] = [];
  const badResponses: Array<{ url: string; status: number }> = [];
  function attachHygiene(p: Page) {
    p.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    p.on("response", (res) => { if (res.status() >= 400) badResponses.push({ url: res.url(), status: res.status() }); });
  }

  const page1 = page; // cashier
  attachHygiene(page1);

  // ═══ (1) cashier login (real POS login screen) ═══════════════════════════
  await page1.goto("/pos/");
  await page1.evaluate(() => localStorage.clear());
  await page1.reload();
  await expect(page1.getByLabel("اسم المستخدم")).toBeVisible({ timeout: 30_000 });
  await page1.getByLabel("اسم المستخدم").fill(CASHIER_USERNAME);
  await page1.getByLabel("كلمة المرور").fill(cashierPassword);
  await page1.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();

  const header = page1.getByTestId("pos-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(page1.getByTestId("cashier-identity")).toHaveText(CASHIER_USERNAME);

  // ═══ (2) open a real shift (full dialog, matches critical-cashier-shift.spec.ts) ═══
  const quickOpenBtn = header.getByRole("button", { name: "فتح وردية", exact: true });
  await expect(quickOpenBtn).toBeVisible();
  await quickOpenBtn.click();
  const shiftDialog = page1.getByRole("dialog");
  await expect(shiftDialog).toBeVisible({ timeout: 10_000 });
  for (const digit of ["ثلاثة", "صفر", "صفر"]) {
    await shiftDialog.getByRole("button", { name: digit, exact: true }).click();
    await page1.waitForTimeout(60);
  }
  await expect(shiftDialog.getByText(`${OPENING_FLOAT}.00 ر.س`)).toBeVisible();
  await shiftDialog.getByRole("button", { name: "فتح وردية", exact: true }).click();
  await expect(shiftDialog.getByText("الوردية الحالية")).toBeVisible({ timeout: 15_000 });
  await shiftDialog.getByRole("button", { name: "إغلاق", exact: true }).click();
  await expect(shiftDialog).toBeHidden();

  const [[openShift]] = await db.query(
    "SELECT id FROM shifts WHERE username = ? AND status = 'OPEN'", [CASHIER_USERNAME]);
  expect(openShift, "shift really opened").toBeTruthy();
  const shiftId: string = openShift.id;

  await shot(page1, "01-cashier-shift-open");

  // ═══ (3) build a real cart — 2 DISTINCT lines — and complete a CASH checkout ═══
  async function addItemNTimes(name: string, n: number) {
    const search = page1.getByRole("searchbox");
    await search.fill(name);
    await expect(page1.getByText(name).first()).toBeVisible({ timeout: 20_000 });
    for (let i = 0; i < n; i++) {
      await page1.getByText(name).first().click();
      await page1.waitForTimeout(60);
    }
    await search.fill("");
  }
  await addItemNTimes(MENU_A_NAME, MENU_A_QTY);
  await addItemNTimes(MENU_B_NAME, MENU_B_QTY);
  // The engine syncs the (empty→lines) cart doc to the server via a debounced
  // background upsert; checkout needs that doc to exist server-side first.
  // Same rationale/timing as e2e/pos/offline.spec.ts's own comment ("give the
  // debounced upsert a beat") — without this, checkout can 404 with "الطلب غير
  // موجود" on a freshly-booted server (observed for real on a first iteration).
  await page1.waitForTimeout(1_500);

  // <768px (mobile-390): the side cart <aside> is `hidden md:block` (display:none)
  // and the REAL cart lives in a bottom sheet opened via the floating "السلة (n)
  // — total" bar (App.tsx). Both the aside's and the sheet's <CartPanel> render
  // in the DOM at once once the sheet is open, so the pay button must be the
  // LAST match (sheet, after the aside in DOM order), never `.first()` (the
  // permanently-hidden aside copy — a locator that can never become actionable).
  const mobileCartBar = page1.getByRole("button", { name: /^السلة \(/ });
  if (await mobileCartBar.isVisible().catch(() => false)) {
    await mobileCartBar.click();
  }
  await shot(page1, "02-cart-two-lines");

  const payBtn = page1.getByRole("button", { name: /دفع —/ }).last();
  await expect(payBtn).toBeVisible({ timeout: 15_000 });
  await expect(payBtn).toBeEnabled();
  await payBtn.click();
  await page1.getByRole("button", { name: /تأكيد الدفع/ }).click();
  await expect(page1.getByText("تم الدفع بنجاح")).toBeVisible({ timeout: 30_000 });
  await shot(page1, "03-checkout-success");
  await page1.getByRole("button", { name: "طلب جديد", exact: true }).click();

  // ── confirm the sale REALLY landed (DB, not just the UI toast) ──────────────
  const [[sale]] = await db.query(
    "SELECT * FROM sales WHERE shift_id = ? ORDER BY order_date DESC LIMIT 1", [shiftId]);
  expect(sale, "sale row exists for this shift").toBeTruthy();
  expect(Number(sale.total_final)).toBeCloseTo(MENU_A_PRICE * MENU_A_QTY + MENU_B_PRICE * MENU_B_QTY, 2);
  const [saleItemRows] = await db.query("SELECT * FROM sales_items WHERE order_id = ?", [sale.id]);
  expect((saleItemRows as unknown[]).length, "2 distinct sale_items lines").toBe(2);

  // eager POS→O2C projection: the invoice's ar_documents/ar_document_lines
  const [[arDoc]] = await db.query(
    "SELECT * FROM ar_documents WHERE source_type = 'pos' AND source_id = ? LIMIT 1", [sale.id]);
  expect(arDoc, "the eager POS→O2C ar_documents projection landed for this sale").toBeTruthy();
  const [arLines] = await db.query("SELECT * FROM ar_document_lines WHERE document_id = ?", [arDoc.id]);
  const lineA = (arLines as Array<Record<string, unknown>>).find((l) => l.menu_id === MENU_A);
  const lineB = (arLines as Array<Record<string, unknown>>).find((l) => l.menu_id === MENU_B);
  expect(lineA, "MENU_A projected line exists").toBeTruthy();
  expect(lineB, "MENU_B projected line exists").toBeTruthy();
  expect(Number(lineA!.entered_qty)).toBe(MENU_A_QTY);
  expect(Number(lineB!.entered_qty)).toBe(MENU_B_QTY);

  // ── stock really deducted at checkout (recipe: 2kg ING_A × 3 units = 6kg) ──
  async function ingAStock(): Promise<number> {
    const [[row]] = await db.query(
      "SELECT qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?", [WAREHOUSE_ID, ING_A]);
    return Number(row.qty);
  }
  const postCheckoutStock = await ingAStock();
  expect(postCheckoutStock).toBeCloseTo(ING_A_START_STOCK - ING_A_STOCK_QTY_PER_UNIT * MENU_A_QTY, 4);

  // ═══ (4) "فواتيري" → open THIS exact invoice → raise a return via the REAL UI ═══
  await header.getByRole("button", { name: /فواتيري/ }).click();
  const invoiceNumber: string = sale.invoice_number || sale.id;
  const invRow = page1.locator("tr", { hasText: invoiceNumber });
  await expect(invRow).toBeVisible({ timeout: 20_000 });
  await invRow.getByRole("button", { name: "مرتجع" }).click();

  const returnDialog = page1.getByRole("dialog", { name: "طلب مرتجع · Sales Return" });
  await expect(returnDialog).toBeVisible({ timeout: 10_000 });
  await expect(returnDialog.getByText(MENU_A_NAME)).toBeVisible({ timeout: 15_000 });
  const qtyInput = page1.getByLabel(`كمية إرجاع ${MENU_A_NAME}`);
  await qtyInput.fill(String(RETURN_QTY));
  await page1.getByLabel("سبب الإرجاع").fill(RETURN_REASON);
  const submitBtn = returnDialog.getByRole("button", { name: "إنشاء طلب المرتجع" });
  await expect(submitBtn).toBeEnabled();

  const createReqPromise = page1.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/order-to-cash/returns");
  await submitBtn.click();
  const uiCreateResp = await createReqPromise;
  const uiCreateStatus = uiCreateResp.status();
  const uiCreateBody = await uiCreateResp.json().catch(() => null);

  // ── the real UI flow now succeeds end to end (see the top-of-file comment:
  // GET /api/sales/invoice/:orderId now supplies the real per-line
  // ar_document_lines id + document version, so the dialog's originalLineId is
  // the real id, not the array position) — asserted as a hard requirement,
  // not a soft/documented-bug check. ──────────────────────────────────────────
  expect(uiCreateResp.ok(), `cashier UI return-create failed: HTTP ${uiCreateStatus}: ${JSON.stringify(uiCreateBody)}`).toBe(true);
  expect(uiCreateStatus).toBe(201);
  expect(uiCreateBody.success).toBe(true);
  expect(uiCreateBody.status).toBe("draft");
  const returnId: string = uiCreateBody.data.id;
  const returnNumber: string = uiCreateBody.documentNumber;
  expect(returnId).toBeTruthy();
  expect(returnNumber).toBeTruthy();

  // Capture the REAL request the dialog sent (idempotency key it generated via
  // ulid(), the If-Match version, and the exact JSON body) so step (10) below
  // can replay this SAME call verbatim through the `request` fixture as a true
  // idempotency check — never a hand-rolled substitute call.
  const uiCreateReq = uiCreateResp.request();
  const uiIdemKey = await uiCreateReq.headerValue("idempotency-key");
  const uiIfMatch = await uiCreateReq.headerValue("if-match");
  const uiCreateReqBody = uiCreateReq.postDataJSON();
  expect(uiIdemKey, "dialog sent an Idempotency-Key").toBeTruthy();
  expect(uiIfMatch, "dialog sent If-Match (expectedVersion)").toBe(String(arDoc.version));

  // ── the dialog itself now shows the REAL success panel, not a cancel button ──
  // NOTE: <Dialog>'s title (and therefore its accessible name) switches from
  // "طلب مرتجع · Sales Return" to "تم إنشاء طلب المرتجع" the instant `result` is
  // set (ReturnRequestDialog.tsx), so the ORIGINAL `returnDialog` locator (bound
  // to the pre-success name) no longer matches anything — re-query by the new
  // accessible name rather than reusing the stale-named locator.
  const successDialog = page1.getByRole("dialog", { name: "تم إنشاء طلب المرتجع" });
  await expect(successDialog).toBeVisible({ timeout: 10_000 });
  await expect(successDialog.getByText("تم إنشاء طلب المرتجع — بانتظار اعتماد المدير")).toBeVisible();
  await expect(successDialog.getByText(returnNumber)).toBeVisible();
  await shot(page1, "04-return-create-ui-success");
  // Close via the success panel's real footer button ("إغلاق"), not "إلغاء" —
  // once `result` is set the dialog no longer renders a cancel button at all.
  // NOTE: the shared <Dialog> shell ALSO has its own header "×" close button
  // whose aria-label is the SAME "إغلاق" string, so a bare name match resolves
  // to 2 elements (strict-mode violation) — `.last()` reliably picks the
  // footer's full-width primary button, which is always the LATER of the two
  // in DOM order (header X first, then the footer div).
  await successDialog.getByRole("button", { name: "إغلاق", exact: true }).last().click();
  await expect(successDialog).toBeHidden();

  const cashierToken = await page1.evaluate(() => localStorage.getItem("pos_token"));
  expect(cashierToken, "cashier token present in localStorage").toBeTruthy();
  const menuALineId = String(lineA!.id);

  // ── DB proof: draft, restock=false, SNAPSHOT reused (not recomputed) ────────
  const [[returnRow0]] = await db.query("SELECT * FROM sales_returns WHERE id = ?", [returnId]);
  expect(returnRow0.status).toBe("draft");
  expect(returnRow0.created_by).toBe(CASHIER_USERNAME);
  expect(returnRow0.original_sale_id).toBe(sale.id);
  const [returnLines0] = await db.query("SELECT * FROM sales_return_lines WHERE return_id = ?", [returnId]);
  expect((returnLines0 as unknown[]).length).toBe(1);
  const retLine = (returnLines0 as Array<Record<string, unknown>>)[0];
  expect(retLine.original_line_id).toBe(menuALineId);
  expect(Number(retLine.return_qty)).toBe(RETURN_QTY);
  expect(Number(retLine.sold_qty)).toBe(MENU_A_QTY);
  expect(Number(retLine.previously_returned_qty)).toBe(0);
  expect(Number(retLine.restock)).toBe(0); // cashiers never hold returns.restock
  expect(retLine.restock_reason).toBeNull();

  const fraction = RETURN_QTY / MENU_A_QTY;
  const expectedNet = money2(Number(lineA!.net_amount) * fraction);
  const expectedVat = money2(Number(lineA!.vat_amount) * fraction);
  const expectedCost = money2(Number(lineA!.cost_snapshot) * fraction);
  const expectedGross = money2(expectedNet + expectedVat);
  expect(Number(retLine.net_amount)).toBe(expectedNet);
  expect(Number(retLine.vat_amount)).toBe(expectedVat);
  expect(Number(retLine.gross_amount)).toBe(expectedGross);
  expect(Number(retLine.cost_snapshot)).toBe(expectedCost);
  // the ORIGINAL tax snapshot is REUSED verbatim, never recomputed from a live rate
  expect(String(retLine.vat_rate)).toBe(String(lineA!.vat_rate));
  expect(retLine.vat_category).toBe(lineA!.vat_category);

  // ═══ (6) adversarial — the cashier's OWN token attempts to approve its own
  //    return: refused, exact code ═══════════════════════════════════════════
  const cashierApproveRes = await request.post(`/api/order-to-cash/returns/${returnId}/approve`, {
    headers: { Authorization: `Bearer ${cashierToken}`, "Idempotency-Key": genIdemKey("CASHIER-APPROVE") },
  });
  expect(cashierApproveRes.status()).toBe(403);
  const cashierApproveJson = await cashierApproveRes.json();
  expect(cashierApproveJson.code).toBe("PERMISSION_DENIED");
  // confirm the DB truly did not move
  const [[stillDraft]] = await db.query("SELECT status, version FROM sales_returns WHERE id = ?", [returnId]);
  expect(stillDraft.status).toBe("draft");
  expect(Number(stillDraft.version)).toBe(1);

  // ═══ (7) manager logs into ERP, finds THIS exact return, approves ═══════════
  const page2 = await browser.newContext(testInfo.project.use);
  const managerPage = await page2.newPage();
  attachHygiene(managerPage);

  await managerPage.goto("/app/");
  await expect(managerPage.locator('input[autocomplete="username"]')).toBeVisible({ timeout: 30_000 });
  await managerPage.locator('input[autocomplete="username"]').fill(MANAGER_USERNAME);
  await managerPage.locator('input[autocomplete="current-password"]').fill(managerPassword);
  await managerPage.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
  await managerPage.waitForURL(/\/app\/(overview)?$/, { timeout: 30_000 });
  await shot(managerPage, "05-manager-logged-in");

  await managerPage.goto("/app/sales/returns");
  const searchBox = managerPage.getByPlaceholder("ابحث برقم المرتجع…");
  await expect(searchBox).toBeVisible({ timeout: 20_000 });
  await searchBox.fill(returnNumber);
  // <768px: DataTable renders stacked CARDS (a `<ul>`), not a `<table>` — the
  // desktop <tr> stays in the DOM but hidden (`hidden md:block` on its
  // wrapper), so it can never become visible/clickable at that width. The
  // card's own clickable element is a <button aria-label={return_number}>
  // (DataTable.tsx's mobileTitle contract) — prefer whichever is really
  // visible at this viewport rather than assuming the desktop table.
  const listRowDesktop = managerPage.locator("tr", { hasText: returnNumber });
  const listRowMobile = managerPage.getByRole("button", { name: returnNumber, exact: true });
  // BOTH locators resolve to a real DOM node at once at narrow viewports (the
  // desktop <tr> stays mounted, just CSS-hidden) — checked individually via
  // isVisible() (never combined with `.or()`, which trips Playwright's strict
  // mode once both resolve) and polled with toPass until one is truly visible.
  await expect(async () => {
    const mobileVisible = await listRowMobile.isVisible().catch(() => false);
    const desktopVisible = await listRowDesktop.isVisible().catch(() => false);
    expect(mobileVisible || desktopVisible).toBe(true);
  }).toPass({ timeout: 20_000 });
  if (await listRowMobile.isVisible().catch(() => false)) {
    await listRowMobile.click();
  } else {
    await listRowDesktop.click();
  }

  const detailHeading = managerPage.getByRole("heading", { name: returnNumber });
  await expect(detailHeading).toBeVisible({ timeout: 20_000 });
  await shot(managerPage, "06-manager-return-detail-draft");

  const approveBtn = managerPage.getByRole("button", { name: "اعتماد", exact: true });
  await expect(approveBtn).toBeVisible();
  await approveBtn.click();
  const postBtn = managerPage.getByRole("button", { name: "ترحيل", exact: true });
  await expect(postBtn).toBeVisible({ timeout: 20_000 }); // proves status → approved (re-render)
  await shot(managerPage, "07-manager-return-approved");

  const [[approvedRow]] = await db.query(
    "SELECT status, approved_by, version FROM sales_returns WHERE id = ?", [returnId]);
  expect(approvedRow.status).toBe("approved");
  expect(approvedRow.approved_by).toBe(MANAGER_USERNAME);
  expect(Number(approvedRow.version)).toBe(2);

  // ═══ (8) manager posts — credit note + GL + stock assertions ═══════════════
  await postBtn.click();
  await expect(managerPage.getByText("إشعار دائن ضريبي")).toBeVisible({ timeout: 20_000 }); // credit-note panel rendered
  await shot(managerPage, "08-manager-return-posted");

  const [[postedRow]] = await db.query(
    "SELECT status, posted_by, version, credit_note_id, journal_id, cogs_journal_id FROM sales_returns WHERE id = ?",
    [returnId]);
  expect(postedRow.status).toBe("posted");
  expect(postedRow.posted_by).toBe(MANAGER_USERNAME);
  expect(Number(postedRow.version)).toBe(3);
  expect(postedRow.credit_note_id).toBeTruthy();
  // restock was always false ⇒ cost restored is 0 ⇒ NO COGS reversal journal
  expect(postedRow.cogs_journal_id).toBeNull();

  const [[creditNote]] = await db.query("SELECT * FROM ar_documents WHERE id = ?", [postedRow.credit_note_id]);
  expect(creditNote.document_type).toBe("credit_note");
  expect(Number(creditNote.subtotal)).toBe(expectedNet);
  expect(Number(creditNote.vat_amount)).toBe(expectedVat);
  expect(Number(creditNote.total_amount)).toBe(expectedGross);
  const [cnLines] = await db.query("SELECT * FROM ar_document_lines WHERE document_id = ?", [creditNote.id]);
  expect((cnLines as unknown[]).length).toBe(1);
  const cnLine = (cnLines as Array<Record<string, unknown>>)[0];
  expect(Number(cnLine.net_amount)).toBe(expectedNet);
  expect(Number(cnLine.vat_amount)).toBe(expectedVat);
  expect(cnLine.source_line_id).toBe(retLine.id);

  // GL — exactly ONE balanced journal (SalesReturn); no SalesReturnCOGS journal
  const [srJournals] = await db.query(
    "SELECT * FROM gl_journals WHERE reference_type = 'SalesReturn' AND reference_id = ?", [returnId]);
  expect((srJournals as unknown[]).length).toBe(1);
  const srJournal = (srJournals as Array<Record<string, unknown>>)[0];
  expect(Number(srJournal.total_debit)).toBe(Number(srJournal.total_credit));
  const [[entrySums]] = await db.query(
    "SELECT SUM(debit) AS d, SUM(credit) AS c FROM gl_entries WHERE journal_id = ?", [srJournal.id]);
  expect(money2(Number(entrySums.d))).toBe(money2(Number(entrySums.c)));
  const [cogsJournals] = await db.query(
    "SELECT id FROM gl_journals WHERE reference_type = 'SalesReturnCOGS' AND reference_id = ?", [returnId]);
  expect((cogsJournals as unknown[]).length).toBe(0);

  // stock NOT restocked — confirm the actual warehouse_stock qty, not the flag
  const postReturnStock = await ingAStock();
  expect(postReturnStock).toBeCloseTo(postCheckoutStock, 4);

  // ═══ (9) over-return — SECOND return against the SAME line, MORE than the
  //    remaining returnable quantity (remaining = 3 sold − 1 returned = 2) ═══
  const overReturnRes = await request.post("/api/order-to-cash/returns", {
    headers: { Authorization: `Bearer ${cashierToken}`, "Idempotency-Key": genIdemKey("OVERRETURN") },
    data: {
      originalSaleId: sale.id,
      reason: "محاولة إفراط في الإرجاع — اختبار",
      lines: [{ originalLineId: menuALineId, returnQty: 2.5 }],
    },
  });
  expect(overReturnRes.status()).toBe(422);
  const overReturnJson = await overReturnRes.json();
  expect(overReturnJson.code).toBe("OVER_RETURN");
  // confirm no second return row was created
  const [allReturnsForSale] = await db.query(
    "SELECT id FROM sales_returns WHERE original_sale_id = ?", [sale.id]);
  expect((allReturnsForSale as unknown[]).length, "still only ONE return for this sale").toBe(1);

  // ═══ (10) idempotency — replay the ORIGINAL cashier-UI create-return call
  //    verbatim (same Idempotency-Key, If-Match and JSON body the dialog itself
  //    sent in step (4), captured off the real network request) ═══════════════
  const replayRes = await request.post("/api/order-to-cash/returns", {
    headers: {
      Authorization: `Bearer ${cashierToken}`,
      "Idempotency-Key": uiIdemKey!, // SAME key the dialog generated in step (4)
      "If-Match": uiIfMatch!,
    },
    data: uiCreateReqBody, // SAME body the dialog actually posted
  });
  expect(replayRes.ok()).toBe(true);
  const replayJson = await replayRes.json();
  expect(replayJson.data.id).toBe(returnId); // same entity, not a new draft
  const [allReturnsAfterReplay] = await db.query(
    "SELECT id FROM sales_returns WHERE original_sale_id = ?", [sale.id]);
  expect((allReturnsAfterReplay as unknown[]).length, "replay created NO second row").toBe(1);

  // ═══ (11) print-data check — the credit-note print/preview payload ═══════
  const managerToken = await managerPage.evaluate(() => localStorage.getItem("pos_token"));
  const printRes = await request.get(`/api/order-to-cash/returns/${returnId}`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  expect(printRes.ok()).toBe(true);
  const printJson = await printRes.json();
  const printData = printJson.data;
  expect(printData.reason).toBe(RETURN_REASON);
  expect((printData.lines as Array<Record<string, unknown>>).length).toBe(1);
  const printLine = printData.lines[0];
  expect(printLine.description).toBe(MENU_A_NAME);
  expect(Number(printLine.return_qty)).toBe(RETURN_QTY);
  expect(printData.creditNote).toBeTruthy();
  expect(printData.creditNote.document_number).toBeTruthy();
  expect(printData.creditNote.zatca_qr_data_url || printData.creditNote.zatca_uuid).toBeTruthy();
  expect(printData.creditNote.seller?.sellerName).toBeTruthy();

  await shot(managerPage, "09-print-data-verified");
  await managerPage.close();
  await page2.close();

  // ── hygiene — zero console errors / zero 4xx+5xx across the WHOLE flow, no
  //    whitelist (page1/managerPage's own browser traffic only — the
  //    intentionally-4xx adversarial calls in steps (6)/(9) go through the
  //    `request` API fixture, not either page, so they never appear here).
  //    Now that the real UI return-create succeeds, this is a genuine,
  //    unconditional pass — no known-bug carve-out needed. ───────────────────
  expect(consoleErrors, `console errors seen during the flow: ${JSON.stringify(consoleErrors)}`).toHaveLength(0);
  expect(badResponses, `4xx/5xx responses seen during the flow: ${JSON.stringify(badResponses)}`).toHaveLength(0);
});
