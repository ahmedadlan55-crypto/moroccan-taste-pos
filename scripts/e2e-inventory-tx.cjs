/* Phase 3B E2E — independent receipts / issues / adjustments.
   Seeds a warehouse + item (open 100@5), boots the built SPA, drives the real
   flow (receipt 50@7 → issue 30 → adjustment counted 110), and captures the 12
   deliverable screenshots: lists, wizards, posted detail (timeline+GL),
   adjustment delta, a 409 conflict, mobile cards, and the RTL print view. */
const { chromium } = require("C:/tmp/warehouse-v2-inventory-transactions/node_modules/playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
process.chdir("C:/tmp/warehouse-v2-inventory-transactions");
try { require("dotenv").config(); } catch (_) {}
const jwt = require("C:/tmp/warehouse-v2-inventory-transactions/node_modules/jsonwebtoken");
const db = require("C:/tmp/warehouse-v2-inventory-transactions/db/connection");

const PORT = 3208;
const BASE = "http://127.0.0.1:" + PORT;
const APP = BASE + "/warehouse-v2";
const OUT = "C:/tmp/warehouse-v2-inventory-transactions/artifacts/warehouse-v2-3b-screenshots";
fs.mkdirSync(OUT, { recursive: true });
const WA = "WH-E2E-A", IT = "E2E-ITEM";
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
    ["DELETE e FROM inv_tx_events e JOIN inv_receipts d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WA]],
    ["DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WA]],
    ["DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WA]],
    ["DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id=?", [WA]],
    ["DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id=?", [WA]],
    ["DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id=?", [WA]],
    ["DELETE FROM inv_receipts WHERE warehouse_id=?", [WA]],
    ["DELETE FROM inv_issues WHERE warehouse_id=?", [WA]],
    ["DELETE FROM inv_adjustments WHERE warehouse_id=?", [WA]],
    ["DELETE FROM inventory_movements WHERE reference_type LIKE 'inv\\_%' AND warehouse_id=?", [WA]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id=?", [WA]],
    ["DELETE FROM idempotency_keys WHERE username='admin'", []],
    ["DELETE FROM inv_items WHERE id=?", [IT]],
    ["DELETE FROM warehouses WHERE id=?", [WA]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WA, "E2A", "المستودع المركزي", "main"]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)", [IT, "زيت زيتون", "خام", "لتر", 5, 5]);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())", ["WS-E2A", WA, IT, 100, 5]);
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name) }); console.log("  ✓", name); }
async function postDoc(kind, payload) {
  const c = await api("POST", `/api/inventory/v2/${kind}`, payload);
  const id = c.body && c.body.id;
  await api("POST", `/api/inventory/v2/${kind}/${id}/approve`, {});
  const p = await api("POST", `/api/inventory/v2/${kind}/${id}/post`, {});
  return { id, number: c.body && c.body.documentNumber, post: p };
}

(async () => {
  await seed();
  const server = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: "0" }, stdio: "ignore" });
  let code = 0;
  try {
    if (!(await waitUp())) throw new Error("server did not start");

    // Build the numeric chain via API (fast + deterministic), then screenshot the UI.
    const rcv = await postDoc("receipts", { warehouseId: WA, reason: "رصيد افتتاحي", counterAccountCode: "4910", sourceRef: "رصيد افتتاحي", items: [{ itemId: IT, qty: 50, unitCost: 7 }] });
    console.log("  receipt", rcv.number, "value", rcv.post.body && rcv.post.body.affectedValue);
    const isu = await postDoc("issues", { warehouseId: WA, reason: "صرف للمطبخ المركزي", expenseAccountCode: "5300", items: [{ itemId: IT, qty: 30 }] });
    console.log("  issue", isu.number);
    const adv = await postDoc("adjustments", { warehouseId: WA, reason: "جرد دوري", items: [{ itemId: IT, countedQty: 110 }] });
    console.log("  adjustment", adv.number);
    // a fresh DRAFT receipt for the 409-conflict capture
    const draft = await api("POST", "/api/inventory/v2/receipts", { warehouseId: WA, reason: "مسودة", counterAccountCode: "4910", items: [{ itemId: IT, qty: 3, unitCost: 7 }] });
    const draftId = draft.body && draft.body.id;

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const page = await ctx.newPage();
    const go = async (p) => { await page.goto(APP + p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(800); };

    // 1) receipts list
    await go("/receipts");
    await page.getByText("الاستلامات المستقلة").first().waitFor({ timeout: 15000 });
    await shot(page, "01-receipts-list.png");

    // 2) receipt wizard (step 2 with a line)
    await go("/receipts/new");
    await page.getByRole("heading", { name: /استلام جديد/ }).waitFor({ timeout: 10000 });
    await page.locator('select[aria-label="المستودع"]').selectOption(WA);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /التالي/ }).click();
    await page.waitForTimeout(600);
    await page.locator('select[aria-label="إضافة صنف"]').selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "02-receipt-wizard.png");

    // 3) posted receipt detail (timeline + GL)
    await go(`/receipts?view=${rcv.id}`);
    await page.getByText("مُرحّل").first().waitFor({ timeout: 10000 });
    await shot(page, "03-receipt-posted.png");

    // 9) timeline + GL — scroll the same drawer to the journals section
    await page.getByText("الحركات والقيود").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, "09-timeline-gl.png");

    // 4) issues list, 5) issue wizard, 6) posted issue
    await go("/issues");
    await shot(page, "04-issues-list.png");
    await go("/issues/new");
    await page.locator('select[aria-label="المستودع"]').selectOption(WA);
    await page.locator('input[aria-label="السبب"]').fill("صرف للمطبخ المركزي");
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /التالي/ }).click();
    await page.waitForTimeout(600);
    await page.locator('select[aria-label="إضافة صنف"]').selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "05-issue-wizard.png");
    await go(`/issues?view=${isu.id}`);
    await page.getByText("مُرحّل").first().waitFor({ timeout: 10000 });
    await shot(page, "06-issue-posted.png");

    // 7) adjustments list, 8) adjustment detail (delta −10)
    await go("/adjustments");
    await shot(page, "07-adjustments-list.png");
    await go(`/adjustments?view=${adv.id}`);
    await page.getByText("مُرحّل").first().waitFor({ timeout: 10000 });
    await shot(page, "08-adjustment-detail.png");

    // 10) 409 conflict — intercept approve, click اعتماد on the draft
    const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await cctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    await cctx.route("**/inventory/v2/**/approve", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, code: "VERSION_CONFLICT", error: "تغيّرت البيانات منذ آخر تحميل — أعد التحميل وحاول مجددًا" }) }));
    const cpage = await cctx.newPage();
    await cpage.goto(APP + `/receipts?view=${draftId}`, { waitUntil: "domcontentloaded" });
    await cpage.getByText("مسودة").first().waitFor({ timeout: 10000 });
    await cpage.getByRole("button", { name: "اعتماد" }).click().catch(() => {});
    await cpage.getByText(/تغيّرت البيانات/).first().waitFor({ timeout: 8000 }).catch(() => {});
    await cpage.waitForTimeout(400);
    await cpage.screenshot({ path: path.join(OUT, "10-conflict-error.png") });
    console.log("  ✓ 10-conflict-error.png");
    await cctx.close();

    // 11) mobile cards
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const mpage = await mctx.newPage();
    await mpage.goto(APP + "/receipts", { waitUntil: "domcontentloaded" });
    await mpage.waitForTimeout(1000);
    await mpage.screenshot({ path: path.join(OUT, "11-mobile-receipts.png") });
    console.log("  ✓ 11-mobile-receipts.png");
    await mctx.close();

    // 12) RTL print view (popup)
    await go(`/receipts?view=${rcv.id}`);
    await page.getByText("مُرحّل").first().waitFor({ timeout: 10000 });
    const popupPromise = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
    await page.getByRole("button", { name: "طباعة" }).click();
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      await popup.waitForTimeout(600);
      await popup.screenshot({ path: path.join(OUT, "12-print.png") });
      console.log("  ✓ 12-print.png");
      await popup.close().catch(() => {});
    } else { console.log("  ⚠ print popup not captured"); }

    await browser.close();
    console.log("E2E DONE");
  } catch (e) { console.error("E2E FATAL", e && e.stack || e.message); code = 1; }
  finally { try { server.kill(); } catch (_) {} await cleanup(); }
  process.exit(code);
})();
