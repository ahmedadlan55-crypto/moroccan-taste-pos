// ═══════════════════════════════════════════════════════════════════════════
// Cashier V2 PWA (/pos) — OFFLINE LIFECYCLE + INSTALLABILITY E2E.
//
// Run:  npm run e2e:pos          (builds frontend/pos first — the service
//                                 worker only registers in production bundles)
//
// Spec 1 — the eight-step offline sale lifecycle, one continuous scenario:
//   (1) open POS online, JWT login (localStorage pos_token, same approach as
//       e2e/erp), ensure an OPEN shift so checkout is allowed
//   (2) context.setOffline(true)
//   (3) build a cart + cash checkout → the QUEUED confirmation
//       («حُفظ الطلب — سيُرحَّل عند عودة الاتصال»)
//   (4) close the page
//   (5) reopen while STILL offline → app shell renders (SW-cached) AND the
//       queued order is visible in state (offline chip shows pending ops)
//   (6) verify the order doc survived: IndexedDB still holds the submitted
//       doc with its exact line + the submit-and-sale op in the queue
//   (7) setOffline(false) + fire the 'online' event → engine flush
//   (8) exactly ONE sales row exists in MySQL for that clientOrderId
//       (clientOrderId = pos_orders.id — the local ULID) and the queue is empty
//
// Spec 2 — PWA installability signals: manifest reachable + valid, icons
// served, SW registered, and the SW CONTROLS the page on second load.
//
// Fixtures are tagged ITEST- ; teardown removes the sale row + its GL journal
// and the pos_orders doc. Playwright note: setOffline reliably flips
// navigator.onLine + page fetches in Chromium; SW-initiated fetches are not
// guaranteed to observe the emulation, so the offline-shell proof asserts the
// SW controller + the precached shell in CacheStorage explicitly.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, request as pwRequest, type Page, type APIRequestContext } from "@playwright/test";
import fs from "fs";
import path from "path";

/* eslint-disable @typescript-eslint/no-var-requires */
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");

const BASE_URL = "http://127.0.0.1:3028";
const MENU_ID = "ITEST-PWA-MENU";
const MENU_NAME = "شاي حبق ITEST";

// ── .env (same reader as e2e/o2c/global-setup.ts) ────────────────────────────
function readEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let token: string;
let api: APIRequestContext;
let shiftId: string;
let orderId: string | null = null; // the local ULID == sales.client_order_id

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const e = readEnv();
  if (!e.JWT_SECRET) throw new Error("JWT_SECRET missing from .env");
  // tokenVersion:1 matches users.token_version for the local admin (id=1) —
  // required by the session-version gate (see e2e/accounting-global-setup.ts).
  token = jwt.sign(
    { id: 1, username: "admin", role: "admin", name: "المدير", tokenVersion: 1 },
    e.JWT_SECRET,
    { expiresIn: "3h" },
  );

  db = await mysql.createConnection({
    host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME,
  });

  // ITEST- tagged catalog fixture (no recipe → no stock relief to unwind).
  await db.query(
    `INSERT INTO menu (id, name, price, category, active, tax_category)
     VALUES (?, ?, 10, 'مشروبات', 1, 'S')
     ON DUPLICATE KEY UPDATE active=1, price=10, name=VALUES(name)`,
    [MENU_ID, MENU_NAME],
  );

  // Shift context: reuse the admin's OPEN shift or open one through the API
  // (exactly what the header button does).
  api = await pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const open = await api.get(`/api/shifts?username=admin&status=OPEN`);
  const rows = (await open.json()) as Array<{ id: string }>;
  if (Array.isArray(rows) && rows.length) {
    shiftId = rows[0].id;
  } else {
    const res = await api.post(`/api/shifts/open`, { data: { device: { ua: "e2e-pos-pwa" } } });
    const body = (await res.json()) as { success: boolean; shiftId: string };
    expect(body.success, "shift open").toBe(true);
    shiftId = body.shiftId;
  }
});

test.afterAll(async () => {
  // Clean the sale row (+ GL journal + movements) and the pos_orders doc —
  // fixtures must not survive the run. Each statement is best-effort so a
  // missing optional table never masks the real assertion failures.
  try {
    if (db && orderId) {
      const [sales] = await db.query("SELECT id FROM sales WHERE client_order_id = ?", [orderId]);
      for (const s of sales as Array<{ id: string }>) {
        try {
          await db.query(
            "DELETE FROM gl_entries WHERE journal_id IN (SELECT id FROM gl_journals WHERE reference_type='Sale' AND reference_id=?)",
            [s.id],
          );
          await db.query("DELETE FROM gl_journals WHERE reference_type='Sale' AND reference_id=?", [s.id]);
        } catch { /* GL tables optional on this deploy */ }
        try { await db.query("DELETE FROM inventory_movements WHERE reference_id=?", [s.id]); } catch { /* none for a recipe-less item */ }
        await db.query("DELETE FROM sales WHERE id=?", [s.id]);
      }
      try {
        await db.query("DELETE FROM pos_order_lines WHERE order_id=?", [orderId]);
        await db.query("DELETE FROM pos_orders WHERE id=?", [orderId]);
      } catch { /* doc may not exist if the run failed early */ }
    }
    if (db) await db.query("DELETE FROM menu WHERE id=?", [MENU_ID]);
  } finally {
    if (db) await db.end();
    if (api) await api.dispose();
  }
});

// ── Page helpers ──────────────────────────────────────────────────────────────
/** Read every record of one IndexedDB store of the pos-v2 db (page context). */
function idbAll(page: Page, store: "orders" | "queue" | "catalog") {
  return page.evaluate((storeName) => {
    return new Promise<unknown[]>((resolve, reject) => {
      const req = indexedDB.open("pos-v2");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const dbi = req.result;
        if (!dbi.objectStoreNames.contains(storeName)) { dbi.close(); resolve([]); return; }
        const tx = dbi.transaction(storeName, "readonly");
        const all = tx.objectStore(storeName).getAll();
        all.onsuccess = () => { dbi.close(); resolve(all.result as unknown[]); };
        all.onerror = () => { dbi.close(); reject(all.error); };
      };
    });
  }, store);
}

async function waitForApp(page: Page) {
  await expect(page.getByText("المذاق المغربي").first()).toBeVisible({ timeout: 30_000 });
}

test("eight-step offline sale lifecycle — queue offline, shell from SW, replay to ONE MySQL row", async ({ page, context }) => {
  // ── (1) online boot + login + shift context ────────────────────────────────
  await context.addInitScript((tok) => {
    try { localStorage.setItem("pos_token", tok as string); } catch { /* ignore */ }
  }, token);
  await page.goto("/pos/");
  await waitForApp(page);
  // seeded catalog item is findable. The grid is VIRTUALIZED (2,000-item
  // catalog renders a bounded window), so the card is located the way a
  // cashier locates it — through search. No Enter (that's the scan-submit
  // path); the filter alone narrows the window to the seeded item.
  await page.getByRole("searchbox").fill(MENU_NAME);
  await expect(page.getByText(MENU_NAME).first()).toBeVisible({ timeout: 30_000 });
  // shift chip proves the shift context reached the app (needed for checkout)
  await expect(page.getByRole("button", { name: /وردية/ }).first()).toBeVisible({ timeout: 30_000 });

  // Service worker installed + activated (precache complete), catalog cached.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(async () => (await idbAll(page, "catalog")).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  // The engine syncs the (empty→lines) cart doc as ops complete; give the
  // debounced upsert a beat so the offline queue starts clean.
  await page.waitForTimeout(1_200);

  // ── (2) go offline ─────────────────────────────────────────────────────────
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  // ConnectionIndicator moved from the always-visible header bar into the
  // collapsible "More" menu (see Header.tsx's header.more.* panel) — open it
  // first, then check the connectivity label inside.
  await page.getByRole("button", { name: "المزيد" }).click();
  await expect(page.getByText("غير متصل").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => navigator.onLine), "navigator.onLine offline").toBe(false);

  // ── (3) cart + cash checkout → queued ──────────────────────────────────────
  await page.getByText(MENU_NAME).first().click();
  const payBtn = page.getByRole("button", { name: /دفع —/ }).first(); // «دفع — 10.00 ر.س»
  await expect(payBtn).toBeEnabled();
  await payBtn.click();
  await page.getByRole("button", { name: /تأكيد الدفع/ }).click();
  // queued confirmation — the offline-checkout contract
  await expect(page.getByText("حُفظ الطلب — سيُرحَّل عند عودة الاتصال")).toBeVisible({ timeout: 20_000 });

  // capture the local ULID (== clientOrderId the sale will dedupe on)
  const submitted = (await idbAll(page, "orders")) as Array<{ id: string; status: string; lines: unknown[] }>;
  const doc = submitted.find((o) => o.status === "submitted");
  expect(doc, "submitted order doc in IndexedDB").toBeTruthy();
  orderId = doc!.id;

  await page.getByRole("button", { name: "طلب جديد" }).click();

  // ── (4) close the page ─────────────────────────────────────────────────────
  await page.close();

  // ── (5) reopen while STILL offline — shell + queued order state ────────────
  const page2 = await context.newPage();
  await page2.goto("/pos/");
  await waitForApp(page2);
  // Playwright quirk: a page CREATED AFTER setOffline(true) can report
  // navigator.onLine=true even though every context fetch is blocked. Page1
  // already dispatches the 'offline' event explicitly for the same reason —
  // mirror it here; the offline CONTRACT is proven by the chip + queued-ops
  // assertions below (and any accidental flush would fail on the dead network
  // and leave the queue intact anyway).
  await page2.evaluate(() => window.dispatchEvent(new Event("offline")));
  // SW controls the page and the precached shell exists in CacheStorage —
  // the honest offline-shell proof (see header note on setOffline vs SW).
  expect(await page2.evaluate(() => !!navigator.serviceWorker.controller), "SW controller").toBe(true);
  const shellCached = await page2.evaluate(async () => {
    const keys = await caches.keys();
    const name = keys.find((k) => k.startsWith("mt-posv2-"));
    if (!name) return false;
    const cache = await caches.open(name);
    return !!(await cache.match(new URL("./", location.href).href));
  });
  expect(shellCached, "app shell precached under mt-posv2-*").toBe(true);
  // ConnectionIndicator + the pending-count chip both live in the collapsible
  // "More" menu — open it once, it stays open (no intervening outside-click)
  // through both the pending-count check below and the reconnect check in (7).
  await page2.getByRole("button", { name: "المزيد" }).click();
  // the queued ops are visible in state: the connectivity chip carries the
  // pending count. (The chip LABEL on this reopened page follows Chromium's
  // navigator.onLine, which the emulation misreports for a page created after
  // setOffline — the «غير متصل» label contract is already proven on page1 in
  // step 2. The load-bearing fact HERE is the queue surviving the restart;
  // any premature flush attempt dies on the dead network and keeps the queue.)
  await expect(page2.getByText(/\(\d+\)/).first()).toBeVisible({ timeout: 15_000 });

  // ── (6) order/cart restoration — doc + ops survived the restart ────────────
  const orders = (await idbAll(page2, "orders")) as Array<{ id: string; status: string; lines: Array<{ menuId: string; qty: number }> }>;
  const restored = orders.find((o) => o.id === orderId);
  expect(restored, "order doc restored from IndexedDB").toBeTruthy();
  expect(restored!.status).toBe("submitted");
  expect(restored!.lines).toHaveLength(1);
  expect(restored!.lines[0].menuId).toBe(MENU_ID);
  expect(restored!.lines[0].qty).toBe(1);
  const ops = (await idbAll(page2, "queue")) as Array<{ type: string; orderId: string }>;
  expect(ops.some((op) => op.orderId === orderId && op.type === "submit-and-sale"), "submit-and-sale op queued").toBe(true);

  // ── (7) back online → sync ─────────────────────────────────────────────────
  await context.setOffline(false);
  await page2.evaluate(() => window.dispatchEvent(new Event("online")));
  // «غير متصل» disappears («متصل» alone would substring-match it)
  await expect(page2.getByText("غير متصل")).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(async () => ((await idbAll(page2, "queue")) as unknown[]).length, {
      timeout: 45_000,
      message: "offline queue drains after reconnect",
    })
    .toBe(0);
  await expect
    .poll(async () => {
      const all = (await idbAll(page2, "orders")) as Array<{ id: string; status: string }>;
      return all.find((o) => o.id === orderId)?.status;
    }, { timeout: 30_000 })
    .toBe("completed");

  // ── (8) exactly ONE MySQL sale row for that clientOrderId ──────────────────
  const [rows] = await db.query(
    "SELECT id, total_final, shift_id FROM sales WHERE client_order_id = ?",
    [orderId],
  );
  expect(rows, "exactly one sale row for the clientOrderId").toHaveLength(1);
  expect(Number((rows as Array<{ total_final: number }>)[0].total_final)).toBeGreaterThan(0);
  expect((rows as Array<{ shift_id: string }>)[0].shift_id).toBe(shiftId);
});

test("PWA installability signals — manifest, icons, SW controller on second load", async ({ page, context }) => {
  // manifest reachable + sane
  const mRes = await api.get("/pos/manifest.webmanifest");
  expect(mRes.status(), "manifest HTTP status").toBe(200);
  const manifest = (await mRes.json()) as {
    name: string; dir: string; lang: string; display: string; start_url: string; scope: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  expect(manifest.name).toBe("كاشير المذاق");
  expect(manifest.dir).toBe("rtl");
  expect(manifest.lang).toBe("ar");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("./");
  expect(manifest.scope).toBe("./");
  const sizes = manifest.icons.map((i) => i.sizes).sort();
  expect(sizes).toEqual(["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    const iRes = await api.get(`/pos/${icon.src}`);
    expect(iRes.status(), `icon ${icon.src}`).toBe(200);
    expect(iRes.headers()["content-type"]).toContain("image/png");
    expect(icon.purpose ?? "").toContain("maskable");
  }
  // the SW script itself is served
  const swRes = await api.get("/pos/sw.js");
  expect(swRes.status(), "sw.js served").toBe(200);

  // first load: registration completes (install + activate = precache done)
  await context.addInitScript((tok) => {
    try { localStorage.setItem("pos_token", tok as string); } catch { /* ignore */ }
  }, token);
  await page.goto("/pos/");
  await waitForApp(page);
  // the built page links the manifest
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest$/);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope.endsWith("/pos/"), `SW scope is the app base (got ${scope})`).toBe(true);

  // second load: the SW CONTROLS the page (clients.claim may already control
  // the first load; the reload makes the signal unambiguous)
  await page.reload();
  await waitForApp(page);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller), "controller active on second load").toBe(true);
});
