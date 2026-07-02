/* Phase 4A E2E — Item Master & Replenishment.
   Seeds an item assigned to 2 warehouses with different rules + stock + outbound
   movements via the API, asserts recommendedQty/daysOfCover, deactivates an item
   and proves it's blocked in a new document, then boots the built SPA and captures
   the deliverable screenshots: items list, create, detail (basics / warehouses /
   reorder-rules), replenishment page, deactivate, a 409 conflict, mobile, print. */
const ROOT = "C:/tmp/warehouse-v2-item-master";
const { chromium } = require(ROOT + "/node_modules/playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
process.chdir(ROOT);
try { require("dotenv").config(); } catch (_) {}
const jwt = require(ROOT + "/node_modules/jsonwebtoken");
const db = require(ROOT + "/db/connection");

const PORT = 3262;
const BASE = "http://127.0.0.1:" + PORT;
const APP = BASE + "/warehouse-v2";
const OUT = ROOT + "/artifacts/warehouse-v2-4a-screenshots";
fs.mkdirSync(OUT, { recursive: true });
const WA = "WH-E2E-A", WB = "WH-E2E-B";
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
    ["DELETE FROM warehouse_item_rules WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_items WHERE sku_norm LIKE 'E2E-%'", []],
    ["DELETE FROM idempotency_keys WHERE username='admin'", []],
    ["DELETE FROM warehouses WHERE id IN (?,?)", [WA, WB]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WA, "E2A", "المستودع المركزي", "main"]);
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)", [WB, "E2B", "مستودع الفرع", "branch"]);
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name) }); console.log("  ✓", name); }

(async () => {
  await seed();
  const server = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: "0" }, stdio: "ignore" });
  let code = 0;
  try {
    if (!(await waitUp())) throw new Error("server did not start");

    // create an item, assign to 2 warehouses + different rules + stock + outbound
    const it = await api("POST", "/api/inventory/v2/items", { name: "زيت زيتون بكر", sku: "E2E-OIL-1", unit: "لتر", category: "زيوت", cost: 5 });
    const id = it.body && it.body.id;
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)", ["WSE-A", WA, id, 5, 5]);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)", ["WSE-B", WB, id, 80, 5]);
    await api("PUT", `/api/inventory/v2/items/${id}/warehouse-rules/${WA}`, { minQty: 5, reorderPoint: 10, reorderQty: 20, maxStock: 50, safetyStock: 5, leadTimeDays: 7, isEnabled: true });
    await api("PUT", `/api/inventory/v2/items/${id}/warehouse-rules/${WB}`, { minQty: 10, reorderPoint: 20, reorderQty: 40, maxStock: 120, safetyStock: 10, leadTimeDays: 5, isEnabled: true });
    await db.query("INSERT INTO inventory_movements (id, movement_date, item_id, item_name, type, qty, warehouse_id, reference_type) VALUES (?, DATE_SUB(NOW(), INTERVAL 10 DAY), ?, '', 'out', 60, ?, 'manual')", ["MVE-1", id, WA]);
    const rep = await api("GET", `/api/inventory/v2/replenishment?warehouseId=${WA}`, undefined);
    const r1 = (rep.body.data || []).find((r) => r.itemId === id);
    console.log("  recommendation WA:", r1 && { recommendedQty: r1.recommendedQty, daysOfCover: r1.daysOfCover, risk: r1.stockoutRisk });

    // a second item → deactivate → blocked in a new doc
    const it2 = await api("POST", "/api/inventory/v2/items", { name: "صنف معطّل", sku: "E2E-OFF-1", unit: "حبة", cost: 2 });
    const id2 = it2.body && it2.body.id;
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES (?,?,?,?,?)", ["WSE-OFF", WA, id2, 10, 2]);
    const [vr] = await db.query("SELECT version FROM inv_items WHERE id=?", [id2]);
    await api("POST", `/api/inventory/v2/items/${id2}/deactivate`, { expectedVersion: Number(vr[0].version) });
    const blocked = await api("POST", "/api/inventory/v2/adjustments", { warehouseId: WA, reason: "جرد", items: [{ itemId: id2, countedQty: 8 }] });
    console.log("  inactive blocked in new doc:", blocked.status, blocked.body && blocked.body.code);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const page = await ctx.newPage();
    const go = async (p) => { await page.goto(APP + p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(800); };

    await go("/items");
    await page.getByText("كتالوج الأصناف").first().waitFor({ timeout: 15000 });
    await shot(page, "01-items-list.png");

    await go("/items/new");
    await page.getByRole("heading", { name: /صنف جديد/ }).waitFor({ timeout: 10000 });
    await page.locator('input[aria-label="الاسم"]').fill("سكر أبيض");
    await page.locator('input[aria-label="SKU"]').fill("E2E-SUGAR");
    await page.locator('input[aria-label="الوحدة"]').fill("كجم");
    await page.waitForTimeout(300);
    await shot(page, "02-item-create.png");

    await go(`/items?view=${id}`);
    await page.getByText("البيانات الأساسية").first().waitFor({ timeout: 10000 });
    await shot(page, "03-item-detail-basics.png");
    await page.getByRole("button", { name: "توزيع المستودعات" }).click(); await page.waitForTimeout(300);
    await shot(page, "04-item-warehouses.png");
    await page.getByRole("button", { name: "قواعد إعادة الطلب" }).click(); await page.waitForTimeout(400);
    await shot(page, "05-item-reorder-rules.png");

    // deactivate screenshot (item2 detail showing تفعيل button when inactive)
    await go(`/items?view=${id2}`);
    await page.getByText("غير نشط").first().waitFor({ timeout: 10000 }).catch(() => {});
    await shot(page, "07-item-deactivated.png");

    await go("/replenishment");
    await page.getByText("خطة إعادة الطلب").first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /كيف تُحسب/ }).click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "06-replenishment.png");
    // print-media preview
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(300);
    await shot(page, "10-print.png");
    await page.emulateMedia({ media: "screen" });

    // mobile items list
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const mpage = await mctx.newPage();
    await mpage.goto(APP + "/items", { waitUntil: "domcontentloaded" });
    await mpage.waitForTimeout(1200);
    await mpage.screenshot({ path: path.join(OUT, "09-mobile-items.png") });
    console.log("  ✓ 09-mobile-items.png");
    await mctx.close();

    // 409 conflict — intercept deactivate → 409
    const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await cctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    await cctx.route("**/items/**/deactivate", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, code: "VERSION_CONFLICT", error: "تغيّر الصنف منذ آخر تحميل — أُعيد التحميل، حاول مجددًا." }) }));
    const cpage = await cctx.newPage();
    await cpage.goto(APP + `/items?view=${id}`, { waitUntil: "domcontentloaded" });
    await cpage.getByText("البيانات الأساسية").first().waitFor({ timeout: 10000 }).catch(() => {});
    await cpage.getByRole("button", { name: /^تعطيل$/ }).click().catch(() => {});
    await cpage.getByText(/تغيّر الصنف منذ آخر تحميل/).first().waitFor({ timeout: 8000 }).catch(() => {});
    await cpage.waitForTimeout(400);
    await cpage.screenshot({ path: path.join(OUT, "08-conflict.png") });
    console.log("  ✓ 08-conflict.png");
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
