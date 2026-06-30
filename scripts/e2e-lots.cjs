/* Phase 4B E2E — Lots / Expiry / FEFO / Traceability.
   Drives the FULL lifecycle via the API (receipt with 2 lots → FEFO issue 40 →
   A=30/B=10 → partial transfer → quarantine → recall + trace), asserts the
   invariant Σ(lot)=warehouse_stock after every step, then boots the built SPA and
   captures the deliverable screenshots: lots list, create (receipt+lot wizard),
   detail, trace, expiry, quarantine, recall, integrity, mobile, print. */
const ROOT = "C:/tmp/warehouse-v2-lots-expiry";
const { chromium } = require(ROOT + "/node_modules/playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
process.chdir(ROOT);
try { require("dotenv").config(); } catch (_) {}
const jwt = require(ROOT + "/node_modules/jsonwebtoken");
const db = require(ROOT + "/db/connection");

const PORT = 3266;
const BASE = "http://127.0.0.1:" + PORT;
const APP = BASE + "/warehouse-v2";
const OUT = ROOT + "/artifacts/warehouse-v2-4b-screenshots";
fs.mkdirSync(OUT, { recursive: true });
const WA = "WH-E4B-A", WB = "WH-E4B-B", T = "E4B-OIL";
const ACC_REV = "4910", ACC_EXP = "5300";
const token = jwt.sign({ id: 0, username: "admin", role: "admin", isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: "2h" });
let fail = 0;
function ok(name, cond, extra) { if (cond) console.log("  ✓", name); else { fail++; console.log("  ✗", name, extra != null ? JSON.stringify(extra) : ""); } }
function dplus(d) { return new Date(Date.now() + d * 86400000).toISOString().slice(0, 10); }

function api(method, p, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: "application/json", Authorization: "Bearer " + token, "Idempotency-Key": "e4b-" + Math.random().toString(36).slice(2) };
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h }, (s) => { let b = ""; s.on("data", (c) => (b += c)); s.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j }); }); });
    r.on("error", () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}
function ping() { return new Promise((r) => { const q = http.get(BASE + "/api/version", (s) => { s.resume(); r(true); }); q.on("error", () => r(false)); q.setTimeout(1000, () => { q.destroy(); r(false); }); }); }
async function waitUp() { for (let i = 0; i < 90; i++) { if (await ping()) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function q1(sql, p) { const [r] = await db.query(sql, p); return r; }
async function stock(wh) { const r = await q1("SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?", [wh, T]); return r.length ? Number(r[0].qty) : 0; }
async function lotSum(wh) { const r = await q1("SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?", [wh, T]); return Number(r[0].s); }
async function bal(wh, norm) { const r = await q1("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND l.lot_norm=?", [wh, norm]); return r.length ? Number(r[0].qty) : 0; }
async function lotId(norm) { const r = await q1("SELECT id FROM inventory_lots WHERE item_id=? AND lot_norm=?", [T, norm]); return r.length ? r[0].id : null; }
async function inv(wh) { return Math.abs(await lotSum(wh) - await stock(wh)) < 0.001; }

async function lifecycle(pathBase, body, idem) {
  const c = await api("POST", pathBase, body); if (![200, 201].includes(c.status)) return { ok: false, res: c };
  const id = c.body.id;
  await api("POST", `${pathBase}/${id}/approve`, { expectedVersion: 1 });
  const post = await api("POST", `${pathBase}/${id}/post`, { expectedVersion: 2 });
  return { ok: post.status === 200, id, res: post };
}
async function cleanup() {
  for (const [s, p] of [
    ["DELETE FROM lot_transfer_allocations WHERE source_warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inventory_lot_movements WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM warehouse_lot_balances WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inventory_lots WHERE item_id=?", [T]],
    ["DELETE e FROM inv_tx_events e JOIN inv_receipts d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_receipts WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_issues WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE sii FROM stock_issue_items sii JOIN stock_issues si ON si.id=sii.issue_id WHERE si.from_warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM stock_issues WHERE from_warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM idempotency_keys WHERE username='admin'", []],
    ["DELETE FROM inv_items WHERE id=?", [T]],
    ["DELETE FROM warehouses WHERE id IN (?,?)", [WA, WB]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WA, "E4A", "المستودع المركزي", "main"]);
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)", [WB, "E4B", "مستودع الفرع", "branch"]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [T, "زيت زيتون بكر", "زيوت", "لتر", 5]);
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name) }); console.log("  📸", name); }

(async () => {
  await seed();
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: "0" }, stdio: "ignore" });
  let code = 0;
  try {
    if (!(await waitUp())) throw new Error("server did not start");
    await db.query("UPDATE inv_items SET tracking_mode='expiry' WHERE id=?", [T]);

    // 1) Receipt with 2 lots (A=30 near-expiry, B=50 later) + C=40 safe → stock 120.
    const rc = await lifecycle("/api/inventory/v2/receipts", { warehouseId: WA, reason: "استلام بدفعات", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 120, unitCost: 5, lots: [{ lotNumber: "LOT-A", qty: 30, expiryDate: dplus(15) }, { lotNumber: "LOT-B", qty: 50, expiryDate: dplus(120) }, { lotNumber: "LOT-C", qty: 40, expiryDate: dplus(220) }] }] }, "rc");
    ok("receipt with 3 lots posted", rc.ok, rc.res && rc.res.body);
    ok("balances A=30,B=50,C=40 + invariant", (await bal(WA, "LOT-A")) === 30 && (await bal(WA, "LOT-B")) === 50 && (await bal(WA, "LOT-C")) === 40 && (await inv(WA)), { a: await bal(WA, "LOT-A"), b: await bal(WA, "LOT-B"), c: await bal(WA, "LOT-C") });
    // an EXPIRED lot for the expiry page (simulating an aged lot) — keep invariant.
    await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES ('E4B-X',?,?,?,?, 'active',5,1)", [T, "LOT-X", "LOT-X", dplus(-5)]);
    await db.query("INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES ('E4B-BX',?,?,?,10)", [WA, "E4B-X", T]);
    await db.query("UPDATE warehouse_stock SET qty = qty + 10 WHERE warehouse_id=? AND item_id=?", [WA, T]);

    // 2) MANDATORY FEFO: issue 40 → A=30, B=10.
    const iss = await lifecycle("/api/inventory/v2/issues", { warehouseId: WA, reason: "صرف FEFO", expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 40 }] }, "iss");
    ok("FEFO issue 40 posted", iss.ok, iss.res && iss.res.body);
    ok("FEFO allocated A=30, B=10 → A=0, B=40 (mandatory)", (await bal(WA, "LOT-A")) === 0 && (await bal(WA, "LOT-B")) === 40 && (await inv(WA)), { a: await bal(WA, "LOT-A"), b: await bal(WA, "LOT-B") });

    // 3) Partial transfer of LOT-B WA→WB (issue 20 → receive 12).
    const tr = await api("POST", "/api/erp/stock-issues", { fromWarehouseId: WA, toWarehouseId: WB, items: [{ itemId: T, qtyRequested: 20 }] });
    const tid = tr.body.id;
    await api("POST", `/api/erp/stock-issues/${tid}/approve`, {});
    await api("POST", `/api/erp/stock-issues/${tid}/issue`, {});
    const lineId = (await q1("SELECT id FROM stock_issue_items WHERE issue_id=?", [tid]))[0].id;
    await api("POST", `/api/erp/stock-issues/${tid}/receive`, { items: [{ id: lineId, qtyReceived: 12 }] });
    ok("partial transfer: WB got 12 of LOT-B; invariant both sides", (await bal(WB, "LOT-B")) === 12 && (await inv(WA)) && (await inv(WB)), { wb: await bal(WB, "LOT-B"), a: await lotSum(WA), b: await lotSum(WB) });

    // 4) Quarantine LOT-C → FEFO suggest must exclude it.
    const cId = await lotId("LOT-C");
    const qr = await api("POST", `/api/inventory/v2/lots/${cId}/quarantine`, { reason: "فحص جودة", expectedVersion: 1 });
    ok("quarantine LOT-C → quarantined", qr.status === 200 && qr.body.status === "quarantined", qr.body);
    const sug = await api("GET", `/api/inventory/v2/lot-allocation/suggest?warehouseId=${WA}&itemId=${T}&qty=30`, undefined);
    ok("FEFO suggest excludes quarantined LOT-C", sug.status === 200 && !(sug.body.data.allocations || []).some((a) => a.lotId === cId), sug.body && sug.body.data);

    // 5) Recall LOT-B → trace shows the downstream impact (issue + transfer).
    const bId = await lotId("LOT-B");
    const rec = await api("POST", `/api/inventory/v2/lots/${bId}/recall`, { reason: "استدعاء جودة", expectedVersion: 1 });
    ok("recall LOT-B → recalled", rec.status === 200 && rec.body.status === "recalled", rec.body);
    const trace = await api("GET", `/api/inventory/v2/lots/${bId}/trace`, undefined);
    ok("trace shows recall impact (downstream out-movements)", trace.status === 200 && (trace.body.recallImpact || []).length >= 1, trace.body && trace.body.recallImpact);

    // 6) Integrity: every tracked group balanced (Σlot=stock).
    const integ = await api("GET", `/api/inventory/v2/lot-integrity`, undefined);
    ok("lot-integrity: zero drift across all groups", integ.status === 200 && integ.body.summary.drifting === 0, integ.body && integ.body.summary);

    // ── SCREENSHOTS ──
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const page = await ctx.newPage();
    const go = async (p) => { await page.goto(APP + p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(900); };

    await go("/lots"); await page.getByText("كتالوج الدفعات").first().waitFor({ timeout: 15000 }); await shot(page, "01-lots-list.png");
    await go("/receipts/new");
    await page.getByRole("heading").first().waitFor({ timeout: 10000 }).catch(() => {});
    await shot(page, "02-receipt-lot-wizard.png");
    await go(`/lots?view=${bId}`); await page.getByText("البيانات الأساسية").first().waitFor({ timeout: 10000 }).catch(() => {}); await shot(page, "03-lot-detail.png");
    await page.getByRole("button", { name: "التتبّع" }).click().catch(() => {}); await page.waitForTimeout(500); await shot(page, "04-lot-trace.png");
    await go("/expiry"); await page.getByText("تحذيرات الصلاحية").first().waitFor({ timeout: 10000 }).catch(() => {}); await shot(page, "05-expiry.png");
    await go(`/lots?view=${cId}`); await page.waitForTimeout(600); await shot(page, "06-quarantine.png");
    await go(`/lots?view=${bId}`); await page.getByRole("button", { name: "التتبّع" }).click().catch(() => {}); await page.waitForTimeout(500); await shot(page, "07-recall-impact.png");
    await go("/lots?tab=integrity"); await page.getByText("تكامل الدفعات").first().waitFor({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500); await shot(page, "08-integrity.png");
    await page.emulateMedia({ media: "print" }); await page.waitForTimeout(300); await shot(page, "10-print.png"); await page.emulateMedia({ media: "screen" });

    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, token);
    const mp = await mctx.newPage(); await mp.goto(APP + "/lots", { waitUntil: "domcontentloaded" }); await mp.waitForTimeout(1200);
    await mp.screenshot({ path: path.join(OUT, "09-mobile-lots.png") }); console.log("  📸 09-mobile-lots.png");
    await mctx.close(); await browser.close();
    console.log("\nScreenshots →", OUT);
  } catch (e) { code = 1; console.error("E2E FATAL", e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} try { await db.end(); } catch (_) {} }
  console.log(fail ? `\n❌ ${fail} assertion(s) failed` : "\n✅ all E2E assertions passed");
  process.exit(code || (fail ? 1 : 0));
})();
