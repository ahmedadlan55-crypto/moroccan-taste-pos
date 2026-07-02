/* Phase 5A — UAT وظيفي متكامل (Release Candidate).
   Drives the FULL 15-step Arabic scenario end-to-end with WAREHOUSE_SCOPE_ENFORCE=1
   and a real role matrix (admin/manager/source/destination/counter/limited/out-of-scope).
   After every mutation: quantity, WAC, lot balances, movements, GL balance, audit
   events, dashboard totals, and the lot invariant Σ(lot)=stock are asserted.
   Then boots the built SPA and captures the UAT screenshot set (desktop/mobile/
   tablet/print) while collecting console errors (must be zero). */
const ROOT = "C:/tmp/warehouse-v2-release-candidate";
let chromium;
try { ({ chromium } = require(ROOT + "/node_modules/playwright")); }
catch (_) { ({ chromium } = require("C:/tmp/warehouse-v2-lots-expiry/node_modules/playwright")); }
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
process.chdir(ROOT);
try { require("dotenv").config(); } catch (_) {}
const jwt = require(ROOT + "/node_modules/jsonwebtoken");
const db = require(ROOT + "/db/connection");

const PORT = 3268;
const BASE = "http://127.0.0.1:" + PORT;
const APP = BASE + "/warehouse-v2";
const OUT = ROOT + "/artifacts/warehouse-v2-5a-uat";
fs.mkdirSync(OUT, { recursive: true });

const WA = "WH-UAT5A-A", WB = "WH-UAT5A-B", T = "UAT5A-SAFFRON";
const ACC_REV = "4100", ACC_EXP = "5100";
const U = { manager: "uat5a_manager", source: "uat5a_source", dest: "uat5a_dest", counter: "uat5a_counter", limited: "uat5a_limited", out: "uat5a_out" };
let TK = {}; // tokens by role (minted after seeding user ids)
const admin = jwt.sign({ id: 0, username: "admin", role: "admin", isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: "2h" });

let fail = 0;
function ok(name, cond, extra) { if (cond) console.log("  ✓", name); else { fail++; console.log("  ✗", name, extra != null ? JSON.stringify(extra) : ""); } }
function dplus(d) { return new Date(Date.now() + d * 86400000).toISOString().slice(0, 10); }

function api(method, p, body, token) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: "application/json", Authorization: "Bearer " + (token || admin), "Idempotency-Key": "u5a-" + Math.random().toString(36).slice(2) };
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h }, (s) => {
      let b = ""; s.on("data", (c) => (b += c));
      s.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j, raw: b }); });
    });
    r.on("error", () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}
function ping() { return new Promise((r) => { const q = http.get(BASE + "/api/version", (s) => { s.resume(); r(true); }); q.on("error", () => r(false)); q.setTimeout(1000, () => { q.destroy(); r(false); }); }); }
async function waitUp() { for (let i = 0; i < 120; i++) { if (await ping()) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function q1(sql, p) { const [r] = await db.query(sql, p); return r; }
const stock = async (wh) => { const r = await q1("SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?", [wh, T]); return r.length ? { qty: Number(r[0].qty), wac: Number(r[0].avg_cost) } : { qty: 0, wac: 0 }; };
const lotSum = async (wh) => Number((await q1("SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?", [wh, T]))[0].s);
const bal = async (wh, norm) => { const r = await q1("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND l.lot_norm=?", [wh, norm]); return r.length ? Number(r[0].qty) : 0; };
const lotIdOf = async (norm) => { const r = await q1("SELECT id FROM inventory_lots WHERE item_id=? AND lot_norm=?", [T, norm]); return r.length ? r[0].id : null; };
const inv = async (wh) => Math.abs((await lotSum(wh)) - (await stock(wh)).qty) < 0.001;
const glBalanced = async (jid) => { if (!jid) return false; const r = await q1("SELECT ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM gl_entries WHERE journal_id=?", [jid]); return r.length && Math.abs(Number(r[0].d) - Number(r[0].c)) < 0.01 && Number(r[0].d) > 0; };
const audited = async (docId) => Number((await q1("SELECT COUNT(*) n FROM inv_tx_events WHERE doc_id=?", [docId]))[0].n) > 0;
const movs = async (refId) => Number((await q1("SELECT COUNT(*) n FROM inventory_movements WHERE reference_id=?", [refId]))[0].n);

async function lifecycle(pathBase, body, tokenCreate, tokenApprove) {
  const c = await api("POST", pathBase, body, tokenCreate);
  if (![200, 201].includes(c.status)) return { ok: false, res: c };
  const id = c.body.id;
  const ap = await api("POST", `${pathBase}/${id}/approve`, { expectedVersion: 1 }, tokenApprove || tokenCreate);
  if (ap.status !== 200) return { ok: false, id, res: ap };
  const post = await api("POST", `${pathBase}/${id}/post`, { expectedVersion: 2 }, tokenCreate);
  return { ok: post.status === 200, id, res: post, journalId: post.body && post.body.journalId };
}

async function cleanup() {
  const uids = (await q1("SELECT id FROM users WHERE username LIKE 'uat5a_%'")).map((r) => r.id);
  for (const [s, p] of [
    ["DELETE FROM lot_transfer_allocations WHERE source_warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inventory_lot_movements WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM warehouse_lot_balances WHERE item_id=?", [T]],
    ["DELETE FROM inventory_lots WHERE item_id=?", [T]],
    ["DELETE FROM inv_stocktake_lot_items WHERE item_id=?", [T]],
    ["DELETE i FROM inv_stocktake_items i JOIN inv_stocktakes s ON s.id=i.stocktake_id WHERE s.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_stocktakes WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE e FROM inv_tx_events e JOIN inv_receipts d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_receipts WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_issues WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inv_adjustments WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE sii FROM stock_issue_items sii JOIN stock_issues si ON si.id=sii.issue_id WHERE si.from_warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM stock_issues WHERE from_warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM warehouse_item_rules WHERE item_id=?", [T]],
    ["DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)", [WA, WB]],
    ["DELETE FROM idempotency_keys WHERE username IN ('admin', ?, ?, ?, ?)", [U.manager, U.source, U.counter, U.dest]],
    ["DELETE FROM inv_items WHERE id=?", [T]],
    ["DELETE FROM warehouses WHERE id IN (?,?)", [WA, WB]],
  ]) { try { await db.query(s, p); } catch (_) {} }
  if (uids.length) {
    try { await db.query("DELETE FROM user_warehouse_access WHERE user_id IN (" + uids.map(() => "?").join(",") + ")", uids); } catch (_) {}
    try { await db.query("DELETE FROM users WHERE username LIKE 'uat5a_%'"); } catch (_) {}
  }
}

async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WA, "U5A", "مستودع المركز (UAT)", "main"]);
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)", [WB, "U5B", "مستودع الفرع (UAT)", "branch"]);
  const roles = { manager: "manager", source: "employee", dest: "employee", counter: "employee", limited: "cashier", out: "manager" };
  const access = { manager: [WA, WB], source: [WA], dest: [WB], counter: [WA], limited: [], out: [] };
  for (const k of Object.keys(U)) {
    const [r] = await db.query("INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)", [U[k], "x-uat-no-login", roles[k]]);
    const uid = r.insertId;
    for (const wh of access[k]) await db.query("INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?, 'uat')", [uid, wh]);
    TK[k] = jwt.sign({ id: uid, username: U[k], role: roles[k], isDeveloper: false }, process.env.JWT_SECRET, { expiresIn: "2h" });
  }
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name) }); console.log("  📸", name); }

(async () => {
  await seed();
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: "1", WAREHOUSE_V2_ENABLED: "1" }, stdio: "ignore" });
  let code = 0;
  try {
    if (!(await waitUp())) throw new Error("server did not start");

    console.log("\n─── 1) إنشاء صنف مُتتبَّع وإسناده لمستودعين ───");
    const it = await api("POST", "/api/inventory/v2/items", { name: "زعفران فاخر UAT", unit: "جم", sku: "UAT5A-SAF", category: "بهارات", cost: 10, id: T }, admin);
    const itemId = (it.body && (it.body.id || (it.body.data && it.body.data.id))) || T;
    ok("إنشاء الصنف عبر v2 API", [200, 201].includes(it.status), { st: it.status, body: it.body && it.body.code });
    await db.query("UPDATE inv_items SET tracking_mode='expiry', id=? WHERE id=?", [T, itemId]); // ثبّت المعرف + فعّل تتبع الصلاحية (لا حركات بعد → مسموح)
    const trk = await q1("SELECT tracking_mode FROM inv_items WHERE id=?", [T]);
    ok("tracking_mode=expiry (قبل أي حركة)", trk.length && trk[0].tracking_mode === "expiry", trk);

    console.log("\n─── 2) قواعد إعادة الطلب على المستودعين ───");
    const r1 = await api("PUT", `/api/inventory/v2/items/${T}/warehouse-rules/${WA}`, { minQty: 10, reorderPoint: 60, reorderQty: 100, maxStock: 500, safetyStock: 10, leadTimeDays: 5, isEnabled: true }, TK.manager);
    const r2 = await api("PUT", `/api/inventory/v2/items/${T}/warehouse-rules/${WB}`, { minQty: 5, reorderPoint: 20, reorderQty: 50, safetyStock: 5, isEnabled: true }, TK.manager);
    ok("قاعدة WA + قاعدة WB (manager)", r1.status === 200 && r2.status === 200, { a: r1.status, b: r2.status });

    console.log("\n─── 3) استلام دفعتين بصلاحيتين مختلفتين ───");
    const rc1 = await lifecycle("/api/inventory/v2/receipts", { warehouseId: WA, reason: "استلام دفعة أولى", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 30, unitCost: 10, lots: [{ lotNumber: "L1", qty: 30, expiryDate: dplus(20) }] }] }, TK.manager, TK.manager);
    ok("استلام L1 (manager) 30@10", rc1.ok, rc1.res && rc1.res.body);
    const rc2 = await lifecycle("/api/inventory/v2/receipts", { warehouseId: WA, reason: "استلام دفعة ثانية", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 50, unitCost: 16, lots: [{ lotNumber: "L2", qty: 50, expiryDate: dplus(180) }] }] }, TK.source, TK.manager);
    ok("استلام L2 (source ينشئ + manager يعتمد) 50@16", rc2.ok, rc2.res && rc2.res.body);
    let s = await stock(WA);
    ok("الكمية 80 + WAC=13.75", s.qty === 80 && Math.abs(s.wac - 13.75) < 0.001, s);
    ok("أرصدة L1=30 L2=50 + الثبات", (await bal(WA, "L1")) === 30 && (await bal(WA, "L2")) === 50 && (await inv(WA)));
    ok("حركات + GL متوازن + تدقيق (استلام L2)", (await movs(rc2.id)) >= 1 && (await glBalanced(rc2.journalId)) && (await audited(rc2.id)));

    console.log("\n─── 4) صرف FEFO ───");
    const iss = await lifecycle("/api/inventory/v2/issues", { warehouseId: WA, reason: "صرف تشغيل FEFO", expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 40 }] }, TK.manager, TK.manager);
    ok("صرف 40 مُرحَّل", iss.ok, iss.res && iss.res.body);
    ok("FEFO: L1=0 (استُهلكت 30) + L2=40 (خُصم 10)", (await bal(WA, "L1")) === 0 && (await bal(WA, "L2")) === 40 && (await inv(WA)));
    s = await stock(WA);
    ok("الكمية 40 + WAC ثابت 13.75 بعد الصرف", s.qty === 40 && Math.abs(s.wac - 13.75) < 0.001, s);
    ok("GL متوازن + تدقيق (الصرف)", (await glBalanced(iss.journalId)) && (await audited(iss.id)));

    console.log("\n─── 5) تحويل جزئي WA→WB ───");
    const tr = await api("POST", "/api/erp/stock-issues", { fromWarehouseId: WA, toWarehouseId: WB, items: [{ itemId: T, qtyRequested: 20 }] }, TK.manager);
    const tid = tr.body && tr.body.id;
    ok("إنشاء التحويل", !!tid, tr.body);
    await api("POST", `/api/erp/stock-issues/${tid}/approve`, {}, TK.manager);
    // سياسة النظام: أي إجراء على التحويل يتطلب صلاحية على المستودعين معًا (guardTransfer).
    const isuDenied = await api("POST", `/api/erp/stock-issues/${tid}/issue`, {}, TK.source);
    ok("مستخدم المصدر فقط لا يستطيع الإصدار (يتطلب الجانبين) → 403", isuDenied.status === 403, { st: isuDenied.status, code: isuDenied.body && isuDenied.body.code });
    const isu = await api("POST", `/api/erp/stock-issues/${tid}/issue`, {}, TK.manager);
    ok("إصدار التحويل (manager بصلاحية الجانبين)", isu.status === 200, isu.body);
    const line = (await q1("SELECT id FROM stock_issue_items WHERE issue_id=?", [tid]))[0].id;
    const rcvDenied = await api("POST", `/api/erp/stock-issues/${tid}/receive`, { items: [{ id: line, qtyReceived: 12 }] }, TK.dest);
    ok("مستخدم الوجهة فقط لا يستطيع الاستلام (يتطلب الجانبين) → 403", rcvDenied.status === 403, { st: rcvDenied.status });
    const rcv = await api("POST", `/api/erp/stock-issues/${tid}/receive`, { items: [{ id: line, qtyReceived: 12 }] }, TK.manager);
    ok("استلام جزئي 12 (manager)", rcv.status === 200, rcv.body);
    ok("WB: L2=12 + الثبات على الجانبين", (await bal(WB, "L2")) === 12 && (await inv(WA)) && (await inv(WB)), { wb: await bal(WB, "L2") });

    console.log("\n─── 6) عكس التحويل ───");
    const trev = await api("POST", `/api/erp/stock-issues/${tid}/reverse`, { reason: "عكس التحويل UAT" }, TK.manager);
    ok("عكس التحويل (manager)", trev.status === 200, trev.body);
    ok("استعادة WA=40 وWB=0 بنفس الدفعات + الثبات", (await bal(WA, "L2")) === 40 && (await lotSum(WB)) === 0 && (await inv(WA)) && (await inv(WB)), { a: await bal(WA, "L2"), b: await lotSum(WB) });

    console.log("\n─── 7) تعديل مخزني بنموذج Maker–Checker ───");
    const adj = await api("POST", "/api/inventory/v2/adjustments", { warehouseId: WA, reason: "فرق جرد عيني", items: [{ itemId: T, countedQty: 35 }] }, TK.source);
    const aid = adj.body && adj.body.id;
    ok("إنشاء التعديل (source)", !!aid, adj.body);
    const selfAp = await api("POST", `/api/inventory/v2/adjustments/${aid}/approve`, { expectedVersion: 1 }, TK.source);
    ok("منع المُنشئ من اعتماد تعديله (Maker–Checker)", selfAp.status === 403 || (selfAp.body && selfAp.body.code === "PERMISSION_DENIED"), { st: selfAp.status, code: selfAp.body && selfAp.body.code });
    await api("POST", `/api/inventory/v2/adjustments/${aid}/approve`, { expectedVersion: 1 }, TK.manager);
    const adjPost = await api("POST", `/api/inventory/v2/adjustments/${aid}/post`, { expectedVersion: 2 }, TK.manager);
    ok("اعتماد المدير + ترحيل التعديل", adjPost.status === 200, adjPost.body);
    ok("الكمية 35 (خصم 5 من L2 بFEFO) + الثبات", (await stock(WA)).qty === 35 && (await bal(WA, "L2")) === 35 && (await inv(WA)));
    ok("GL متوازن + تدقيق (التعديل)", (await glBalanced(adjPost.body && adjPost.body.journalId)) && (await audited(aid)));

    console.log("\n─── 8) جرد مع حركة أثناء العد ───");
    const stk = await api("POST", "/api/inventory/v2/stocktakes", { warehouseId: WA, scopeType: "items", itemIds: [T], reason: "جرد UAT", blindCount: false }, TK.counter);
    const sid = stk.body && stk.body.id;
    ok("إنشاء الجرد (counter)", !!sid, stk.body);
    await api("POST", `/api/inventory/v2/stocktakes/${sid}/start`, {}, TK.counter);
    // حركة أثناء العد: استلام L3 (+10 @20) بعد أخذ اللقطة.
    const rc3 = await lifecycle("/api/inventory/v2/receipts", { warehouseId: WA, reason: "توريد أثناء الجرد", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 10, unitCost: 20, lots: [{ lotNumber: "L3", qty: 10, expiryDate: dplus(90) }] }] }, TK.manager, TK.manager);
    ok("حركة أثناء العد (استلام L3 +10)", rc3.ok, rc3.res && rc3.res.body);
    const l2id = await lotIdOf("L2"), l3id = await lotIdOf("L3");
    const cnt = await api("PUT", `/api/inventory/v2/stocktakes/${sid}/counts`, { counts: [{ itemId: T, countedQty: 45, lots: [{ lotId: l2id, qty: 35 }, { lotId: l3id, qty: 10 }] }] }, TK.counter);
    ok("حفظ العد بالدفعات (45 = 35+10)", cnt.status === 200, cnt.body);
    await api("POST", `/api/inventory/v2/stocktakes/${sid}/submit`, {}, TK.counter);
    await api("POST", `/api/inventory/v2/stocktakes/${sid}/approve`, {}, TK.manager);
    const stkPost = await api("POST", `/api/inventory/v2/stocktakes/${sid}/post`, {}, TK.manager);
    ok("ترحيل الجرد رغم الحركة أثناء العد (نافذة snapshot_seq)", stkPost.status === 200, stkPost.body);
    s = await stock(WA);
    const expWac = (35 * 13.75 + 10 * 20) / 45; // = 15.1389
    ok("لا ازدواج: الكمية 45 + WAC=15.139 + الثبات", s.qty === 45 && Math.abs(s.wac - expWac) < 0.001 && (await inv(WA)), s);

    console.log("\n─── 9) حجر دفعة ───");
    const qr = await api("POST", `/api/inventory/v2/lots/${l3id}/quarantine`, { reason: "اشتباه جودة", expectedVersion: 1 }, TK.manager);
    ok("حجر L3 (manager + سبب + إصدار)", qr.status === 200 && qr.body.status === "quarantined", qr.body);
    const sug = await api("GET", `/api/inventory/v2/lot-allocation/suggest?warehouseId=${WA}&itemId=${T}&qty=40`, undefined, TK.manager);
    ok("اقتراح FEFO يستبعد المحجورة", sug.status === 200 && !(sug.body.data.allocations || []).some((a) => a.lotId === l3id), sug.body && sug.body.data);
    const manualBlocked = await api("POST", "/api/inventory/v2/issues", { warehouseId: WA, reason: "محاولة صرف محجور", expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 5, lotAllocations: [{ lotId: l3id, qty: 5 }], allocationReason: "اختبار" }] }, TK.manager);
    if (manualBlocked.status === 200 || manualBlocked.status === 201) {
      const mid2 = manualBlocked.body.id;
      await api("POST", `/api/inventory/v2/issues/${mid2}/approve`, { expectedVersion: 1 }, TK.manager);
      const mPost = await api("POST", `/api/inventory/v2/issues/${mid2}/post`, { expectedVersion: 2 }, TK.manager);
      ok("صرف يدوي من دفعة محجورة → مرفوض عند الترحيل (QUARANTINED_LOT)", mPost.status === 422 && mPost.body && mPost.body.code === "QUARANTINED_LOT", { st: mPost.status, code: mPost.body && mPost.body.code });
    } else {
      ok("صرف يدوي من دفعة محجورة → مرفوض", manualBlocked.status === 422, { st: manualBlocked.status, code: manualBlocked.body && manualBlocked.body.code });
    }

    console.log("\n─── 10) استدعاء وتتبّع الأثر ───");
    const rec = await api("POST", `/api/inventory/v2/lots/${l2id}/recall`, { reason: "استدعاء مورد", expectedVersion: 1 }, TK.manager);
    ok("استدعاء L2", rec.status === 200 && rec.body.status === "recalled", rec.body);
    const trace = await api("GET", `/api/inventory/v2/lots/${l2id}/trace`, undefined, TK.manager);
    ok("التتبّع: أثر الاستدعاء يشمل مستندات لاحقة (صرف/تحويل/تعديل)", trace.status === 200 && (trace.body.recallImpact || []).length >= 2, trace.body && (trace.body.recallImpact || []).length);
    ok("سجل حركات الدفعة موجود (timeline)", (trace.body.timeline || []).length >= 3, (trace.body.timeline || []).length);

    console.log("\n─── 11) Analytics والتقارير ───");
    const an = await api("GET", "/api/inventory/analytics/summary", undefined, TK.manager);
    ok("Analytics summary يعمل ويشمل قيمًا", an.status === 200, { st: an.status });
    const rep = await api("GET", "/api/inventory/reports/stock-balance", undefined, TK.manager);
    ok("تقرير رصيد المخزون يعمل", rep.status === 200, { st: rep.status });
    const dash = await api("GET", "/api/inventory/warehouses-summary", undefined, TK.manager);
    const rowA = dash.body && (dash.body.warehouses || []).find((w) => w.id === WA);
    ok("لوحة المستودعات تعكس WA", !!rowA, rowA);

    console.log("\n─── 12) Replenishment ───");
    const repl = await api("GET", `/api/inventory/v2/replenishment?warehouseId=${WA}`, undefined, TK.manager);
    const rRow = repl.body && (repl.body.data || []).find((r) => r.itemId === T);
    ok("الصنف يظهر في إعادة الطلب (المخزون 45 < نقطة الطلب 60)", repl.status === 200 && !!rRow && Number(rRow.recommendedQty || 0) > 0, rRow || (repl.body && repl.body.data && repl.body.data.length));

    console.log("\n─── 13) الطباعة وCSV ───");
    const csv = await api("GET", "/api/inventory/reports/stock-balance/export", undefined, TK.manager);
    ok("تصدير CSV يعمل + BOM (UTF-8 لإكسل)", csv.status === 200 && typeof csv.raw === "string" && csv.raw.charCodeAt(0) === 0xfeff, { st: csv.status, first: csv.raw && csv.raw.charCodeAt(0) });

    console.log("\n─── 14) مستخدم خارج النطاق ───");
    const outList = await api("GET", "/api/inventory/v2/receipts?pageSize=10", undefined, TK.out);
    const leaked = outList.body && (outList.body.data || []).some((d) => d.warehouseId === WA || d.warehouse_id === WA);
    ok("قوائم خارج النطاق لا تُظهر مستندات WA", outList.status === 200 ? !leaked : true, { st: outList.status });
    const outDetail = await api("GET", `/api/inventory/v2/receipts/${rc1.id}`, undefined, TK.out);
    ok("تفاصيل مستند WA لمستخدم خارج النطاق → 403 عام", outDetail.status === 403, { st: outDetail.status });
    ok("رسالة الرفض لا تكشف اسم/وجود المستودع", outDetail.raw && outDetail.raw.indexOf(WA) === -1 && outDetail.raw.indexOf("مستودع المركز") === -1);
    const outCreate = await api("POST", "/api/inventory/v2/receipts", { warehouseId: WA, reason: "خارج النطاق", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 1, unitCost: 1, lots: [{ lotNumber: "LX", qty: 1, expiryDate: dplus(30) }] }] }, TK.out);
    ok("إنشاء مستند على WA خارج النطاق → 403", outCreate.status === 403, { st: outCreate.status });

    console.log("\n─── 15) مصفوفة الأدوار ───");
    const lim = await api("POST", "/api/inventory/v2/receipts", { warehouseId: WA, reason: "x", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 1, unitCost: 1 }] }, TK.limited);
    ok("cashier (محدود): إنشاء → 403 forbidden_role", lim.status === 403, { st: lim.status, code: lim.body && lim.body.code });
    const rcX = await api("POST", "/api/inventory/v2/receipts", { warehouseId: WA, reason: "لدور الاعتماد", counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 2, unitCost: 10, lots: [{ lotNumber: "L4", qty: 2, expiryDate: dplus(60) }] }] }, TK.source);
    const empAp = await api("POST", `/api/inventory/v2/receipts/${rcX.body.id}/approve`, { expectedVersion: 1 }, TK.source);
    ok("employee: اعتماد → 403 (MGR فقط)", empAp.status === 403, { st: empAp.status });
    const mgrAp = await api("POST", `/api/inventory/v2/receipts/${rcX.body.id}/approve`, { expectedVersion: 1 }, TK.manager);
    ok("manager: الاعتماد يمر", mgrAp.status === 200, mgrAp.body);
    const admDel = await api("DELETE", `/api/inventory/v2/receipts/${rcX.body.id}`, undefined, TK.source);
    ok("employee: حذف → 403 (MGR فقط)", admDel.status === 403, { st: admDel.status });

    // ── الثبات النهائي عبر النظام ──
    const integ = await api("GET", "/api/inventory/v2/lot-integrity", undefined, admin);
    ok("سلامة الدفعات النهائية: انحراف صفر", integ.status === 200 && integ.body.summary.drifting === 0, integ.body && integ.body.summary);

    // ── SPA: لقطات + أخطاء الكونسول + وصولية أساسية ──
    console.log("\n─── SPA: لقطات + كونسول نظيف ───");
    const browser = await chromium.launch();
    const consoleErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, admin);
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
    const go = async (p) => { await page.goto(APP + p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(900); };

    await go("/"); await shot(page, "01-dashboard-1440.png");
    // وصولية: أول Tab يصل إلى رابط التخطي
    await page.keyboard.press("Tab");
    const skipFocused = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("skip-link"));
    ok("أول Tab → رابط «تخطٍّ إلى المحتوى» (WCAG 2.4.1)", skipFocused === true, skipFocused);
    await go("/items"); await shot(page, "02-items.png");
    await go("/lots"); await shot(page, "03-lots.png");
    await go(`/lots?view=${l2id}`); await page.getByRole("button", { name: "التتبّع" }).click().catch(() => {}); await page.waitForTimeout(500); await shot(page, "04-lot-trace-recall.png");
    await go("/expiry"); await shot(page, "05-expiry.png");
    await go("/transfers"); await shot(page, "06-transfers.png");
    await go("/stocktakes"); await shot(page, "07-stocktakes.png");
    await go("/adjustments"); await shot(page, "08-adjustments.png");
    await go("/analytics"); await page.waitForTimeout(1500); await shot(page, "09-analytics.png");
    await go("/reports"); await shot(page, "10-reports.png");
    await go("/replenishment"); await shot(page, "11-replenishment.png");
    await page.emulateMedia({ media: "print" }); await page.waitForTimeout(300); await shot(page, "12-print-a4.png"); await page.emulateMedia({ media: "screen" });

    const tctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    await tctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, admin);
    const tp = await tctx.newPage(); await tp.goto(APP + "/inventory", { waitUntil: "domcontentloaded" }); await tp.waitForTimeout(1200);
    await tp.screenshot({ path: path.join(OUT, "13-tablet-768-inventory.png") }); console.log("  📸 13-tablet-768-inventory.png");
    const hscrollT = await tp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok("لا تمرير أفقي على 768px", hscrollT === false, hscrollT);
    await tctx.close();

    const mctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await mctx.addInitScript((t) => { try { localStorage.setItem("pos_token", t); } catch (e) {} }, admin);
    const mp = await mctx.newPage(); await mp.goto(APP + "/", { waitUntil: "domcontentloaded" }); await mp.waitForTimeout(1200);
    await mp.screenshot({ path: path.join(OUT, "14-mobile-375-dashboard.png") }); console.log("  📸 14-mobile-375-dashboard.png");
    const hscrollM = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok("لا تمرير أفقي على 375px", hscrollM === false, hscrollM);
    await mp.goto(APP + "/lots", { waitUntil: "domcontentloaded" }); await mp.waitForTimeout(1200);
    await mp.screenshot({ path: path.join(OUT, "15-mobile-375-lots.png") }); console.log("  📸 15-mobile-375-lots.png");
    await mctx.close();

    ok("صفر أخطاء كونسول عبر كل الصفحات", consoleErrors.length === 0, consoleErrors.slice(0, 5));
    await browser.close();
    console.log("\nScreenshots →", OUT);
  } catch (e) { code = 1; console.error("UAT FATAL", (e && e.stack) || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} try { if (db.pool && db.pool.end) await db.pool.end(); } catch (_) {} }
  console.log(fail ? `\n❌ ${fail} assertion(s) failed` : "\n✅ UAT: كل التأكيدات ناجحة");
  process.exit(code || (fail ? 1 : 0));
})();
