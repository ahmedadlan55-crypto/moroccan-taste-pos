/* Phase 3C E2E — professional stocktake.
   Seeds a warehouse + items, builds several stocktake states via the API
   (posted-with-variance, counting-partial, blind-counting, submitted), boots the
   built SPA and captures the deliverable screenshots: list, wizard, counting
   workspace (desktop+mobile), blind count, progress, variance review, posted+GL,
   timeline, request-recount dialog, a 409 conflict, and the RTL print sheets. */
const ROOT = "C:/tmp/warehouse-v2-stocktake";
const { chromium } = require(ROOT + "/node_modules/playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
process.chdir(ROOT);
try { require("dotenv").config(); } catch (_) {}
const jwt = require(ROOT + "/node_modules/jsonwebtoken");
const db = require(ROOT + "/db/connection");

const PORT = 3242;
const BASE = "http://127.0.0.1:" + PORT;
const APP = BASE + "/warehouse-v2";
const OUT = ROOT + "/artifacts/warehouse-v2-3c-screenshots";
fs.mkdirSync(OUT, { recursive: true });
const WH = "WH-E2E-STK";
const ITEMS = [["E2S-1", 100], ["E2S-2", 50], ["E2S-3", 30], ["E2S-4", 80], ["E2S-5", 12], ["E2S-6", 5]];
const token = jwt.sign({ id: 0, username: "admin", role: "admin", isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: "2h" });

function api(method, p, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: "application/json", Authorization: "Bearer " + token, "Idempotency-Key": "e2e-" + Math.random().toString(36).slice(2) };
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h }, (s) => { let b = ""; s.on("data", (c) => (b += c)); s.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j }); }); });
    r.on("error", () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}
function ping() { return new Promise((r) => { const q = http.get(BASE + "/api/version", (s) => { s.resume(); r(true); }); q.on("error", () => r(false)); q.setTimeout(1000, () => { q.destroy(); r(false); }); }); }
async function waitUp() { for (let i = 0; i < 90; i++) { if (await ping()) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function cleanup() {
  for (const [s, p] of [
    ["DELETE e FROM inv_tx_events e JOIN inv_stocktakes d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE i FROM inv_stocktake_items i JOIN inv_stocktakes d ON d.id=i.stocktake_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE FROM inv_stocktakes WHERE warehouse_id=?", [WH]],
    ["DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE FROM inv_adjustments WHERE warehouse_id=?", [WH]],
    ["DELETE FROM inventory_movements WHERE warehouse_id=?", [WH]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id=?", [WH]],
    ["DELETE FROM idempotency_keys WHERE username='admin'", []],
    ["DELETE FROM inv_items WHERE id LIKE 'E2S-%'", []],
    ["DELETE FROM warehouses WHERE id=?", [WH]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, "E2S", "المستودع المركزي", "main"]);
  for (const [id, q] of ITEMS) {
    await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)", [id, "صنف " + id, "خام", "كجم", 5, 0]);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", ["WS-" + id, WH, id, q, 5]);
  }
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name) }); console.log("  ✓", name); }

(async () => {
  await seed();
  const server = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: "0", STOCKTAKE_MAKER_CHECKER: "0" }, stdio: "ignore" });
  let code = 0;
  try {
    if (!(await waitUp())) throw new Error("server did not start");
    const S = "/api/inventory/v2/stocktakes";

    // A) POSTED with variance (E2S-1: count 90 vs 100 → −10)
    const a = await api("POST", S, { warehouseId: WH, scopeType: "items", itemIds: ["E2S-1"], reason: "جرد دوري" });
    await api("POST", `${S}/${a.body.id}/start`, {});
    await api("PUT", `${S}/${a.body.id}/counts`, { counts: [{ itemId: "E2S-1", countedQty: 90 }] });
    await api("POST", `${S}/${a.body.id}/submit`, {});
    await api("POST", `${S}/${a.body.id}/approve`, {});
    await api("POST", `${S}/${a.body.id}/post`, {});

    // B) COUNTING partial (all 6 items, 3 counted)
    const b = await api("POST", S, { warehouseId: WH, scopeType: "full", reason: "جرد كامل" });
    await api("POST", `${S}/${b.body.id}/start`, {});
    await api("PUT", `${S}/${b.body.id}/counts`, { counts: [{ itemId: "E2S-2", countedQty: 48 }, { itemId: "E2S-3", countedQty: 30 }, { itemId: "E2S-4", countedQty: 79 }] });

    // C) BLIND counting
    const c = await api("POST", S, { warehouseId: WH, scopeType: "full", reason: "عدّ أعمى", blindCount: true });
    await api("POST", `${S}/${c.body.id}/start`, {});
    await api("PUT", `${S}/${c.body.id}/counts`, { counts: [{ itemId: "E2S-5", countedQty: 11 }] });

    // D) SUBMITTED (for request-recount dialog + approval state)
    const dd = await api("POST", S, { warehouseId: WH, scopeType: "items", itemIds: ["E2S-6"], reason: "مراجعة فرق" });
    await api("POST", `${S}/${dd.body.id}/start`, {});
    await api("PUT", `${S}/${dd.body.id}/counts`, { counts: [{ itemId: "E2S-6", countedQty: 3 }] });
    await api("POST", `${S}/${dd.body.id}/submit`, {});

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const page = await ctx.newPage();
    const go = async (p) => { await page.goto(APP + p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(800); };

    // 1) list
    await go("/stocktakes");
    await page.getByText("الجرد والتسويات").first().waitFor({ timeout: 15000 });
    await shot(page, "01-stocktakes-list.png");

    // 2) wizard
    await go("/stocktakes/new");
    await page.getByRole("heading", { name: /جرد جديد/ }).waitFor({ timeout: 10000 });
    await page.locator('select[aria-label="المستودع"]').selectOption(WH);
    await page.locator('input[aria-label="السبب"]').fill("جرد دوري شهري");
    await page.waitForTimeout(300);
    await shot(page, "02-stocktake-wizard.png");

    // 3) counting workspace desktop
    await go(`/stocktakes/${b.body.id}/count`);
    await page.getByText(/ورشة العد/).first().waitFor({ timeout: 10000 });
    await shot(page, "03-counting-desktop.png");
    // 6) progress (same page shows progress + remaining)
    await shot(page, "06-progress.png");

    // 5) blind count
    await go(`/stocktakes/${c.body.id}/count`);
    await page.getByText(/عدّ أعمى/).first().waitFor({ timeout: 10000 }).catch(() => {});
    await shot(page, "05-blind-count.png");

    // 7) variance review (posted detail)
    await go(`/stocktakes?view=${a.body.id}`);
    await page.getByText("مراجعة الفروقات").first().waitFor({ timeout: 10000 });
    await shot(page, "07-variance-review.png");
    // 10) posted + GL, 11) timeline
    await page.getByText("القيد المحاسبي").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, "10-posted-gl.png");
    await page.getByText("السجل الزمني").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, "11-timeline-gl.png");

    // 9) approval state (submitted detail shows اعتماد)
    await go(`/stocktakes?view=${dd.body.id}`);
    await page.getByText("بانتظار الاعتماد").first().waitFor({ timeout: 10000 });
    await shot(page, "09-approval.png");
    // 8) request-recount dialog
    await page.getByRole("button", { name: /إعادة عد/ }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "08-request-recount.png");

    // 13) print count sheet, 14) print variance report (popups from posted detail)
    await go(`/stocktakes?view=${a.body.id}`);
    await page.getByText("مراجعة الفروقات").first().waitFor({ timeout: 10000 });
    let pop = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    await page.getByRole("button", { name: /ورقة عد/ }).first().click();
    let popup = await pop;
    if (popup) { await popup.waitForLoadState("domcontentloaded").catch(() => {}); await popup.waitForTimeout(500); await popup.screenshot({ path: path.join(OUT, "13-print-count.png") }); console.log("  ✓ 13-print-count.png"); await popup.close().catch(() => {}); }
    pop = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    await page.getByRole("button", { name: /تقرير الفروقات/ }).first().click();
    popup = await pop;
    if (popup) { await popup.waitForLoadState("domcontentloaded").catch(() => {}); await popup.waitForTimeout(500); await popup.screenshot({ path: path.join(OUT, "14-print-variance.png") }); console.log("  ✓ 14-print-variance.png"); await popup.close().catch(() => {}); }

    // 4) counting mobile
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const mpage = await mctx.newPage();
    await mpage.goto(APP + `/stocktakes/${b.body.id}/count`, { waitUntil: "domcontentloaded" });
    await mpage.waitForTimeout(1200);
    await mpage.screenshot({ path: path.join(OUT, "04-counting-mobile.png") });
    console.log("  ✓ 04-counting-mobile.png");
    await mctx.close();

    // 12) conflict — intercept approve → 409
    const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await cctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    await cctx.route("**/stocktakes/**/approve", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, code: "VERSION_CONFLICT", error: "تغيّرت البيانات منذ آخر تحميل — أُعيد التحميل، حاول مجددًا." }) }));
    const cpage = await cctx.newPage();
    await cpage.goto(APP + `/stocktakes?view=${dd.body.id}`, { waitUntil: "domcontentloaded" });
    await cpage.getByText("بانتظار الاعتماد").first().waitFor({ timeout: 10000 }).catch(() => {});
    await cpage.getByRole("button", { name: /^اعتماد$/ }).click().catch(() => {});
    await cpage.getByText(/تغيّرت البيانات/).first().waitFor({ timeout: 8000 }).catch(() => {});
    await cpage.waitForTimeout(400);
    await cpage.screenshot({ path: path.join(OUT, "12-conflict.png") });
    console.log("  ✓ 12-conflict.png");
    await cctx.close();

    await browser.close();
    console.log("\nE2E screenshots written to", OUT);
  } catch (e) {
    code = 1; console.error("E2E FATAL", e && e.stack || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  process.exit(code);
})();
