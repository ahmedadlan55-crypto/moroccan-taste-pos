/**
 * Phase P1 — Production Orders V2 integration test (ENFORCE=1, MAKER_CHECKER=1).
 *
 * Boots server.js and exercises /api/inventory/v2/production-orders end-to-end:
 *   • create draft expands the BOM (batches × (1+waste%)); PATCH re-expands
 *     (version-guarded); stale version → 409.
 *   • Maker–Checker: creator can't approve own order; a second manager can.
 *   • partial issue: stock −@WAC frozen, FEFO picks the earliest-expiry lot,
 *     lot movements + genealogy rows, invariant, GL Dr WIP / Cr 1200 (+5400).
 *   • idempotency replay (same key → same event, stock moved once).
 *   • over-issue: beyond planned×(1+tol) → OVER_ISSUE; manager override works.
 *   • manual lot override sum mismatch → VALIDATION_ERROR.
 *   • record-output: tracked FG requires batch (LOT_REQUIRED); waste requires
 *     a reason; employee beyond scrap allowance → WASTE_ALLOWANCE_EXCEEDED;
 *     u = wip/remaining, FG WAC updates, GL Dr 1230 (+5122 waste) / Cr 1220.
 *   • complete: needs ≥1 output (NO_OUTPUT_RECORDED); short-close needs reason.
 *   • close: WIP residual → PRODUCTION_VARIANCE 5420.
 *   • reverse: exact component lots restored, FG lot removed, one reversing
 *     journal per original; blocked when FG was already consumed.
 *   • cancel after an issue is blocked; delete draft only; scope 403s;
 *     employee can't approve; legacy rows are inert to V2 mutations.
 *   • concurrency: two parallel issues, one 200 / one 409, stock moved once.
 *   • FINAL: all stock/lot balances return exactly to baseline.
 *
 * Run: node tests/integration/production.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.PROD_TEST_PORT || 3211);
const BASE = { host: '127.0.0.1', port: PORT };
const WPA = 'WH-P1-SRC', WPB = 'WH-P1-OUT';
const RAW1 = 'P1-RAW1', RAW2 = 'P1-RAW2', FG1 = 'P1-FG1', FG2 = 'P1-FG2';
const BOM1 = 'BOM-P1-1', BOM2 = 'BOM-P1-2';
const U_A = 'prod_a', U_B = 'prod_b', U_EMP = 'prod_emp', U_OUT = 'prod_out';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.02 : tol); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
const API = '/api/inventory/v2/production-orders';
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function qty(wh, item) { const [r] = await db.query('SELECT qty, avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, item]); return r.length ? { q: Number(r[0].qty), c: Number(r[0].avg_cost) } : { q: 0, c: 0 }; }
async function lotBal(wh, item) { const [r] = await db.query('SELECT wl.lot_number, b.qty FROM warehouse_lot_balances b JOIN inventory_lots wl ON wl.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? ORDER BY wl.lot_number', [wh, item]); return r.map((x) => ({ lot: x.lot_number, qty: Number(x.qty) })); }
async function glTotals(journalId) { const [r] = await db.query('SELECT total_debit, total_credit FROM gl_journals WHERE id=?', [journalId]); return r.length ? { d: Number(r[0].total_debit), c: Number(r[0].total_credit) } : null; }
async function glEntries(journalId) { const [r] = await db.query('SELECT account_code, debit, credit FROM gl_entries WHERE journal_id=? ORDER BY id', [journalId]); return r; }

async function cleanup() {
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN production_orders po ON po.id=e.doc_id WHERE e.doc_type='production' AND po.warehouse_id=?", [WPA]],
    ['DELETE pil FROM production_issue_lines pil JOIN production_orders po ON po.id=pil.production_order_id WHERE po.warehouse_id=?', [WPA]],
    ['DELETE pie FROM production_issue_events pie JOIN production_orders po ON po.id=pie.production_order_id WHERE po.warehouse_id=?', [WPA]],
    ['DELETE pout FROM production_output pout JOIN production_orders po ON po.id=pout.production_order_id WHERE po.warehouse_id=?', [WPA]],
    ['DELETE pc FROM production_consumption pc JOIN production_orders po ON po.id=pc.production_order_id WHERE po.warehouse_id=?', [WPA]],
    ['DELETE pol FROM production_output_lots pol JOIN production_orders po ON po.id=pol.work_order_id WHERE po.warehouse_id=?', [WPA]],
    ['DELETE wolc FROM work_order_lot_consumption wolc JOIN production_orders po ON po.id=wolc.work_order_id WHERE po.warehouse_id=?', [WPA]],
    ['DELETE FROM production_orders WHERE warehouse_id=?', [WPA]],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?) AND (reference_type LIKE 'prod\\_%' OR item_id IN (?,?,?,?))", [WPA, WPB, RAW1, RAW2, FG1, FG2]],
    ['DELETE lm FROM inventory_lot_movements lm WHERE lm.warehouse_id IN (?,?)', [WPA, WPB]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id IN (?,?)', [WPA, WPB]],
    ['DELETE wl FROM inventory_lots wl WHERE wl.item_id IN (?,?,?,?)', [RAW1, RAW2, FG1, FG2]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WPA, WPB]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type LIKE 'prod\\_%'", []],
    ["DELETE FROM gl_journals WHERE reference_type LIKE 'prod\\_%'", []],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?,?,?)', [U_A, U_B, U_EMP, U_OUT, 'prod_admin']],
    ['DELETE FROM bom_lines WHERE bom_id IN (?,?)', [BOM1, BOM2]],
    ['DELETE FROM bom WHERE id IN (?,?)', [BOM1, BOM2]],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?,?,?)', [U_A, U_B, U_EMP, U_OUT]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?,?)', [RAW1, RAW2, FG1, FG2]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WPA, WPB]],
    ['DELETE FROM users WHERE username IN (?,?,?,?)', [U_A, U_B, U_EMP, U_OUT]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WPA, 'P1S', 'مستودع مواد الإنتاج', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WPB, 'P1O', 'مستودع الإخراج', 'branch']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [RAW1, 'مادة خام 1', 'خام', 'كجم', 4]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,tracking_mode) VALUES (?,?,?,?,?,1,'expiry')", [RAW2, 'مادة خام متتبعة', 'خام', 'كجم', 6]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,tracking_mode,kind) VALUES (?,?,?,?,0,1,'lot','semi')", [FG1, 'منتج نهائي متتبع', 'إنتاج', 'حبة']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,kind) VALUES (?,?,?,?,0,1,'semi')", [FG2, 'منتج نهائي حر', 'إنتاج', 'حبة']);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-P1-R1', WPA, RAW1, 100, 4]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-P1-R2', WPA, RAW2, 50, 6]);
  // Two RAW2 lots — L1 expires FIRST (FEFO must pick it before L2).
  const L = require('../../lib/lotLedger');
  await L.openingLot(db, { warehouseId: WPA, itemId: RAW2, qty: 30, lotNumber: 'L1-EARLY', expiryDate: '2026-12-01', unitCost: 6, actor: 'seed', occurredAt: new Date() });
  await L.openingLot(db, { warehouseId: WPA, itemId: RAW2, qty: 20, lotNumber: 'L2-LATE', expiryDate: '2027-06-01', unitCost: 6, actor: 'seed', occurredAt: new Date() });
  // BOM1 → FG1 (tracked): yield 10; lines RAW1×2, RAW2×1 per batch (no waste%).
  await db.query("INSERT INTO bom (id,product_id,version,yield_quantity,yield_unit,is_active,product_source) VALUES (?,?,1,10,'PCS',1,'inv')", [BOM1, FG1]);
  await db.query("INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct) VALUES ('BL-P1-1',?,?,2,'كجم',0)", [BOM1, RAW1]);
  await db.query("INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct) VALUES ('BL-P1-2',?,?,1,'كجم',0)", [BOM1, RAW2]);
  // BOM2 → FG2 (untracked): yield 1; RAW1×1.
  await db.query("INSERT INTO bom (id,product_id,version,yield_quantity,yield_unit,is_active,product_source) VALUES (?,?,1,1,'PCS',1,'inv')", [BOM2, FG2]);
  await db.query("INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct) VALUES ('BL-P1-3',?,?,1,'كجم',0)", [BOM2, RAW1]);
  const ids = {};
  for (const [u, role] of [[U_A, 'manager'], [U_B, 'manager'], [U_EMP, 'employee'], [U_OUT, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  for (const u of [U_A, U_B, U_EMP]) {
    await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?),(?,?,?)', [ids[u], WPA, 'test', ids[u], WPB, 'test']);
  }
  // U_OUT deliberately has access to NEITHER production warehouse.
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Production Orders V2 — integration (ENFORCE=1, MAKER_CHECKER=1) ═══\n');
  const ids = await seed();
  const ua = tok(ids[U_A], U_A, 'manager');
  const ub = tok(ids[U_B], U_B, 'manager');
  const uemp = tok(ids[U_EMP], U_EMP, 'employee');
  const uout = tok(ids[U_OUT], U_OUT, 'manager');

  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', INV_MAKER_CHECKER: '1', WAREHOUSE_V2_CANARY_USERS: '', WAREHOUSE_V2_CANARY_ROLES: '' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── 1) Create draft — BOM expansion ─────────────────────────────────────
    console.log('▸ create + expansion');
    let r = await req('POST', API, ua, { bomId: BOM1, qtyPlanned: 50, warehouseId: WPA, outputWarehouseId: WPB, allowedScrapPct: 10, notes: 'أمر اختبار' }, { 'Idempotency-Key': 'p1-create-1' });
    check('create draft → 201 v1', r.status === 201 && r.body && r.body.status === 'draft' && r.body.version === 1, r.body);
    const O1 = r.body && r.body.data && r.body.data.id;
    r = await req('GET', API + '/' + O1, ua);
    const plan1 = (r.body && r.body.plan) || [];
    check('plan expanded: RAW1=10 (2×5 batches), RAW2=5', plan1.length === 2
      && near((plan1.find((p) => p.item_id === RAW1) || {}).qty_planned, 10)
      && near((plan1.find((p) => p.item_id === RAW2) || {}).qty_planned, 5), plan1.map((p) => [p.item_id, p.qty_planned]));
    check('detail exposes source=v2 + zero WIP', r.body.data.source === 'v2' && near(r.body.data.wip_balance, 0));

    // ── 2) PATCH: stale version → 409; correct → re-expansion ───────────────
    r = await req('PATCH', API + '/' + O1, ua, { qtyPlanned: 60, expectedVersion: 99 });
    check('PATCH stale version → 409 VERSION_CONFLICT', r.status === 409 && r.body.code === 'VERSION_CONFLICT', r.body);
    r = await req('PATCH', API + '/' + O1, ua, { qtyPlanned: 50, expectedVersion: 1 });
    check('PATCH ok → v2', r.status === 200 && r.body.version === 2, r.body);

    // ── 3) Maker–Checker + RBAC ─────────────────────────────────────────────
    console.log('▸ approve (maker–checker, RBAC, scope)');
    r = await req('POST', API + '/' + O1 + '/approve', ua, { expectedVersion: 2 });
    check('creator self-approve → 403', r.status === 403 && r.body.code === 'PERMISSION_DENIED', r.body);
    r = await req('POST', API + '/' + O1 + '/approve', uemp, { expectedVersion: 2 });
    check('employee approve → 403 (RBAC)', r.status === 403, r.body);
    r = await req('GET', API + '/' + O1, uout);
    check('out-of-scope detail → 403', r.status === 403, r.body);
    r = await req('POST', API + '/' + O1 + '/approve', ub, { expectedVersion: 2 });
    check('second manager approves → approved v3', r.status === 200 && r.body.status === 'approved' && r.body.version === 3, r.body);

    // ── 4) Issue #1 (partial, FEFO, labor) ──────────────────────────────────
    console.log('▸ issue-materials #1 (partial + FEFO + GL)');
    const issue1Body = { lines: [{ itemId: RAW1, qty: 6 }, { itemId: RAW2, qty: 3 }], laborCost: 20, reason: 'دفعة أولى', expectedVersion: 3 };
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, issue1Body, { 'Idempotency-Key': 'p1-issue-1' });
    check('issue#1 → 200 in_progress v4', r.status === 200 && r.body.status === 'in_progress' && r.body.version === 4, r.body);
    const EV1 = r.body && r.body.data && r.body.data.eventId;
    const J1 = r.body && r.body.journalId;
    check('issue#1 affectedValue = 62 (24+18+20 labor)', near(r.body.affectedValue, 62), r.body.affectedValue);
    let s = await qty(WPA, RAW1);
    check('RAW1 stock 100→94', near(s.q, 94), s);
    s = await qty(WPA, RAW2);
    check('RAW2 stock 50→47', near(s.q, 47), s);
    let lots = await lotBal(WPA, RAW2);
    check('FEFO consumed L1-EARLY first (30→27, L2 intact 20)', near((lots.find((l) => l.lot === 'L1-EARLY') || {}).qty, 27) && near((lots.find((l) => l.lot === 'L2-LATE') || {}).qty, 20), lots);
    let g = await glTotals(J1);
    check('issue#1 journal balanced 62/62', g && near(g.d, 62) && near(g.c, 62), g);
    let ge = await glEntries(J1);
    check('issue#1 GL: Dr1220 62 / Cr1200 42 + Cr5400 20', near(ge.filter((e) => e.account_code === '1220').reduce((x, e) => x + Number(e.debit), 0), 62)
      && near((ge.find((e) => e.account_code === '1200') || {}).credit, 42)
      && near((ge.find((e) => e.account_code === '5400') || {}).credit, 20), ge);
    const [wolc1] = await db.query('SELECT * FROM work_order_lot_consumption WHERE work_order_id=?', [O1]);
    check('genealogy: work_order_lot_consumption row (L1, qty 3)', wolc1.length === 1 && near(wolc1[0].qty, 3), wolc1);

    // ── 5) Idempotency replay ───────────────────────────────────────────────
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, issue1Body, { 'Idempotency-Key': 'p1-issue-1' });
    check('same Idempotency-Key → replay (same eventId, 200)', r.status === 200 && r.body.data && r.body.data.eventId === EV1, r.body && r.body.data);
    s = await qty(WPA, RAW1);
    check('replay did NOT move stock again (RAW1 still 94)', near(s.q, 94), s);
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 1 }], expectedVersion: 4 }, { 'Idempotency-Key': 'p1-issue-1' });
    check('same key + different payload → IDEMPOTENCY_CONFLICT', r.status === 409 && r.body.code === 'IDEMPOTENCY_CONFLICT', r.body);

    // ── 6) Manual lot override mismatch + issue #2 ──────────────────────────
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, { lines: [{ itemId: RAW2, qty: 2, lotAllocations: [{ lotId: 'X', qty: 1 }] }], expectedVersion: 4 });
    check('manual allocation sum ≠ qty → VALIDATION_ERROR', r.status === 422 && r.body.code === 'VALIDATION_ERROR', r.body);
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 4 }, { itemId: RAW2, qty: 2 }], reason: 'استكمال', expectedVersion: 4 }, { 'Idempotency-Key': 'p1-issue-2' });
    check('issue#2 completes the plan → v5 (wip 62+28=90)', r.status === 200 && r.body.version === 5 && near(r.body.affectedValue, 28), r.body && r.body.affectedValue);

    // ── 7) Over-issue tolerance + manager override ──────────────────────────
    console.log('▸ over-issue');
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 6 }], expectedVersion: 5 });
    check('cumulative 16 > cap 11 → OVER_ISSUE', r.status === 422 && r.body.code === 'OVER_ISSUE', r.body);
    r = await req('POST', API + '/' + O1 + '/issue-materials', uemp, { lines: [{ itemId: RAW1, qty: 6 }], allowOverIssue: true, reason: 'محاولة موظف', expectedVersion: 5 });
    check('employee override → still OVER_ISSUE', r.status === 422 && r.body.code === 'OVER_ISSUE', r.body);
    r = await req('POST', API + '/' + O1 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 6 }], allowOverIssue: true, reason: 'زيادة معتمدة', expectedVersion: 5 }, { 'Idempotency-Key': 'p1-issue-3' });
    check('manager override + reason → 200 v6 (wip 114)', r.status === 200 && r.body.version === 6 && near(r.body.affectedValue, 24), r.body && r.body.affectedValue);
    s = await qty(WPA, RAW1);
    check('RAW1 stock now 84 (100−16)', near(s.q, 84), s);

    // ── 8) Record output — guards then partial #1 ───────────────────────────
    console.log('▸ record-output (lot guard, waste gates, costing)');
    r = await req('POST', API + '/' + O1 + '/record-output', ua, { goodQty: 20, expectedVersion: 6 });
    check('tracked FG without batch → LOT_REQUIRED', r.status === 422 && r.body.code === 'LOT_REQUIRED', r.body);
    r = await req('POST', API + '/' + O1 + '/record-output', ua, { goodQty: 5, wasteQty: 2, batchNumber: 'FG-B1', expectedVersion: 6 });
    check('waste without reason → REASON_REQUIRED', r.status === 422 && r.body.code === 'REASON_REQUIRED', r.body);
    r = await req('POST', API + '/' + O1 + '/record-output', uemp, { goodQty: 5, wasteQty: 6, wasteReason: 'تلف كبير', batchNumber: 'FG-B1', expectedVersion: 6 });
    check('employee waste 6 > allowance 5 (10% × 50) → WASTE_ALLOWANCE_EXCEEDED', r.status === 403 && r.body.code === 'WASTE_ALLOWANCE_EXCEEDED', r.body);
    r = await req('POST', API + '/' + O1 + '/record-output', ua, { goodQty: 20, batchNumber: 'FG-B1', expectedVersion: 6 }, { 'Idempotency-Key': 'p1-out-1' });
    check('output#1 → 200 v7; u = 114/50 = 2.28', r.status === 200 && r.body.version === 7 && near(r.body.data.unitCost, 2.28), r.body && r.body.data);
    const JO1 = r.body.journalId;
    s = await qty(WPB, FG1);
    check('FG stock in WPB = 20 @ WAC 2.28', near(s.q, 20) && near(s.c, 2.28), s);
    ge = await glEntries(JO1);
    check('output#1 GL: Dr1230 45.6 / Cr1220 45.6', near((ge.find((e) => e.account_code === '1230') || {}).debit, 45.6) && near((ge.find((e) => e.account_code === '1220') || {}).credit, 45.6), ge);
    lots = await lotBal(WPB, FG1);
    check('FG lot FG-B1 created (20)', lots.length === 1 && lots[0].lot === 'FG-B1' && near(lots[0].qty, 20), lots);

    // ── 9) Output #2 with waste ─────────────────────────────────────────────
    r = await req('POST', API + '/' + O1 + '/record-output', ua, { goodQty: 25, wasteQty: 5, wasteReason: 'هدر تشغيل', batchNumber: 'FG-B2', expectedVersion: 7 }, { 'Idempotency-Key': 'p1-out-2' });
    check('output#2 (good25/waste5) → v8; u = 68.4/30 = 2.28', r.status === 200 && r.body.version === 8 && near(r.body.data.unitCost, 2.28), r.body && r.body.data);
    const JO2 = r.body.journalId;
    ge = await glEntries(JO2);
    check('output#2 GL: Dr1230 57 + Dr5122 11.4 / Cr1220 68.4', near((ge.find((e) => e.account_code === '1230') || {}).debit, 57)
      && near((ge.find((e) => e.account_code === '5122') || {}).debit, 11.4)
      && near((ge.find((e) => e.account_code === '1220') || {}).credit, 68.4), ge);
    r = await req('GET', API + '/' + O1, ua);
    check('order: produced 45, waste 5, wip 0, partially flag off pre-complete', near(r.body.data.qty_produced, 45) && near(r.body.data.qty_waste, 5) && near(r.body.data.wip_balance, 0, 0.03), { p: r.body.data.qty_produced, w: r.body.data.qty_waste, wip: r.body.data.wip_balance });

    // ── 10) Complete + variance/close on a second order ─────────────────────
    console.log('▸ complete / close / variance');
    r = await req('POST', API + '/' + O1 + '/complete', ua, { expectedVersion: 8 });
    check('complete O1 (45+5=50=planned) → completed, yield 90%', r.status === 200 && r.body.status === 'completed' && near(r.body.data.yieldPct, 90), r.body && r.body.data);

    // O2: untracked FG2, short production → residual → variance at close.
    r = await req('POST', API, ua, { bomId: BOM2, qtyPlanned: 10, warehouseId: WPA, outputWarehouseId: WPB }, { 'Idempotency-Key': 'p1-create-2' });
    const O2 = r.body.data.id;
    await req('POST', API + '/' + O2 + '/approve', ub, {});
    r = await req('POST', API + '/' + O2 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 10 }] }, { 'Idempotency-Key': 'p1-o2-issue' });
    check('O2 issue 10×4 → wip 40', r.status === 200 && near(r.body.affectedValue, 40), r.body && r.body.affectedValue);
    r = await req('POST', API + '/' + O2 + '/complete', ua, {});
    check('complete with NO output → NO_OUTPUT_RECORDED', r.status === 422 && r.body.code === 'NO_OUTPUT_RECORDED', r.body);
    r = await req('POST', API + '/' + O2 + '/record-output', ua, { goodQty: 8 }, { 'Idempotency-Key': 'p1-o2-out' });
    check('O2 output 8: u = 40/10 = 4, wip → 8', r.status === 200 && near(r.body.data.unitCost, 4), r.body && r.body.data);
    r = await req('POST', API + '/' + O2 + '/complete', ua, {});
    check('short-close without reason → REASON_REQUIRED', r.status === 422 && r.body.code === 'REASON_REQUIRED', r.body);
    r = await req('POST', API + '/' + O2 + '/complete', ua, { reason: 'انتهت المواد' });
    check('short-close with reason → completed (yield 80%)', r.status === 200 && near(r.body.data.yieldPct, 80), r.body && r.body.data);
    r = await req('POST', API + '/' + O2 + '/close', uemp, {});
    check('employee close → 403 (MGR only)', r.status === 403, r.body);
    r = await req('POST', API + '/' + O2 + '/close', ub, {});
    check('close O2 → variance 8 flushed', r.status === 200 && near(r.body.affectedValue, 8), r.body && r.body.affectedValue);
    const JC2 = r.body.journalId;
    ge = await glEntries(JC2);
    check('close GL: Dr5420 8 / Cr1220 8', near((ge.find((e) => e.account_code === '5420') || {}).debit, 8) && near((ge.find((e) => e.account_code === '1220') || {}).credit, 8), ge);

    // ── 11) Reverse O2 (from closed) ────────────────────────────────────────
    console.log('▸ reverse');
    const rawBeforeRev = (await qty(WPA, RAW1)).q;
    r = await req('POST', API + '/' + O2 + '/reverse', ub, { reason: 'عكس اختباري' }, { 'Idempotency-Key': 'p1-o2-rev' });
    check('reverse O2 (closed) → reversed, 3 reversing journals (issue+output+close)', r.status === 200 && r.body.status === 'reversed' && (r.body.data.reverseJournalIds || []).length === 3, r.body && r.body.data);
    s = await qty(WPA, RAW1);
    check('RAW1 restored +10 after O2 reverse', near(s.q, rawBeforeRev + 10), { before: rawBeforeRev, after: s.q });
    s = await qty(WPB, FG2);
    check('FG2 stock removed (8→0)', near(s.q, 0), s);
    const [consAfter] = await db.query('SELECT qty_actual FROM production_consumption WHERE production_order_id=?', [O2]);
    check('O2 consumption aggregates reset to 0', consAfter.every((c) => Number(c.qty_actual) === 0), consAfter);

    // ── 12) Reverse blocked when FG consumed ────────────────────────────────
    await db.query('UPDATE warehouse_stock SET qty = qty - 40 WHERE warehouse_id=? AND item_id=?', [WPB, FG1]);
    r = await req('POST', API + '/' + O1 + '/reverse', ub, { reason: 'محاولة' });
    check('reverse O1 with consumed FG → INSUFFICIENT_STOCK', r.status === 422 && r.body.code === 'INSUFFICIENT_STOCK', r.body);
    await db.query('UPDATE warehouse_stock SET qty = qty + 40 WHERE warehouse_id=? AND item_id=?', [WPB, FG1]);
    r = await req('POST', API + '/' + O1 + '/reverse', ub, { reason: 'عكس كامل' }, { 'Idempotency-Key': 'p1-o1-rev' });
    check('reverse O1 → reversed (5 journals: 3 issues + 2 outputs)', r.status === 200 && r.body.status === 'reversed' && (r.body.data.reverseJournalIds || []).length === 5, r.body && r.body.data && (r.body.data.reverseJournalIds || []).length);
    lots = await lotBal(WPA, RAW2);
    check('EXACT lots restored: L1 back to 30, L2 to 20', near((lots.find((l) => l.lot === 'L1-EARLY') || {}).qty, 30) && near((lots.find((l) => l.lot === 'L2-LATE') || {}).qty, 20), lots);
    lots = await lotBal(WPB, FG1);
    check('FG lots emptied after reverse', lots.every((l) => near(l.qty, 0)), lots);
    r = await req('POST', API + '/' + O1 + '/reverse', ub, { reason: 'تكرار' });
    check('double reverse → INVALID_STATE_TRANSITION', r.status === 422 && r.body.code === 'INVALID_STATE_TRANSITION', r.body);

    // ── 13) Cancel/delete rules ─────────────────────────────────────────────
    console.log('▸ cancel / delete / coexistence / concurrency');
    r = await req('POST', API, ua, { bomId: BOM2, qtyPlanned: 5, warehouseId: WPA }, { 'Idempotency-Key': 'p1-create-3' });
    const O3 = r.body.data.id;
    await req('POST', API + '/' + O3 + '/approve', ub, {});
    await req('POST', API + '/' + O3 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 1 }] }, { 'Idempotency-Key': 'p1-o3-issue' });
    r = await req('POST', API + '/' + O3 + '/cancel', ub, { reason: 'إلغاء' });
    check('cancel AFTER issue → blocked (INVALID_STATE_TRANSITION)', r.status === 422 && r.body.code === 'INVALID_STATE_TRANSITION', r.body);
    r = await req('POST', API, ua, { bomId: BOM2, qtyPlanned: 5, warehouseId: WPA }, { 'Idempotency-Key': 'p1-create-4' });
    const O4 = r.body.data.id;
    await req('POST', API + '/' + O4 + '/approve', ub, {});
    r = await req('POST', API + '/' + O4 + '/cancel', ub, { reason: 'لم يعد مطلوبًا' });
    check('cancel approved (no issues) → cancelled', r.status === 200 && r.body.status === 'cancelled', r.body);
    r = await req('POST', API, ua, { bomId: BOM2, qtyPlanned: 5, warehouseId: WPA }, { 'Idempotency-Key': 'p1-create-5' });
    const O5 = r.body.data.id;
    r = await req('DELETE', API + '/' + O5, ua);
    check('delete draft → deleted', r.status === 200 && r.body.status === 'deleted', r.body);
    r = await req('DELETE', API + '/' + O4, ua);
    check('delete cancelled → INVALID_STATE_TRANSITION', r.status === 422 && r.body.code === 'INVALID_STATE_TRANSITION', r.body);

    // ── 14) Legacy coexistence ──────────────────────────────────────────────
    await db.query(
      "INSERT INTO production_orders (id, order_number, bom_id, product_id, warehouse_id, output_warehouse_id, qty_planned, status, source, created_by) VALUES ('PO-LEGACY-P1','PRD-LEG-1',?,?,?,?,10,'planned','legacy','legacy_user')",
      [BOM2, FG2, WPA, WPB]);
    r = await req('POST', API + '/PO-LEGACY-P1/approve', ub, {});
    check('V2 approve on LEGACY row → VALIDATION_ERROR (inert)', r.status === 422 && r.body.code === 'VALIDATION_ERROR', r.body);
    r = await req('POST', API + '/PO-LEGACY-P1/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 1 }] });
    check('V2 issue on LEGACY row → VALIDATION_ERROR (inert)', r.status === 422 && r.body.code === 'VALIDATION_ERROR', r.body);
    r = await req('GET', API + '/?source=legacy&q=PRD-LEG', ua);
    check('list surfaces legacy rows with source badge', r.status === 200 && (r.body.data || []).some((x) => x.id === 'PO-LEGACY-P1' && x.source === 'legacy'), (r.body.data || []).length);

    // ── 15) Concurrency: two parallel issues, same version ──────────────────
    r = await req('POST', API, ua, { bomId: BOM2, qtyPlanned: 5, warehouseId: WPA }, { 'Idempotency-Key': 'p1-create-6' });
    const O6 = r.body.data.id;
    await req('POST', API + '/' + O6 + '/approve', ub, {});
    r = await req('GET', API + '/' + O6, ua);
    const v6 = r.body.data.version;
    const rawBefore6 = (await qty(WPA, RAW1)).q;
    const [c1, c2] = await Promise.all([
      req('POST', API + '/' + O6 + '/issue-materials', ua, { lines: [{ itemId: RAW1, qty: 1 }], expectedVersion: v6 }),
      req('POST', API + '/' + O6 + '/issue-materials', ub, { lines: [{ itemId: RAW1, qty: 1 }], expectedVersion: v6 }),
    ]);
    const okCount = [c1, c2].filter((x) => x.status === 200).length;
    const conflictCount = [c1, c2].filter((x) => x.status === 409).length;
    check('concurrent issues: exactly one 200 + one 409', okCount === 1 && conflictCount === 1, { a: c1.status, b: c2.status });
    s = await qty(WPA, RAW1);
    check('stock moved exactly once (−1)', near(s.q, rawBefore6 - 1), { before: rawBefore6, after: s.q });

    // ── 16) KPIs + availability + variance-report endpoints ─────────────────
    r = await req('GET', API + '/?pageSize=50', ua);
    check('list KPIs present (reversed=2, cancelled=1)', r.status === 200 && r.body.kpis && r.body.kpis.reversed === 2 && r.body.kpis.cancelled === 1, r.body && r.body.kpis);
    r = await req('GET', API + '/' + O3 + '/availability', ua);
    check('availability endpoint returns remaining plan', r.status === 200 && Array.isArray(r.body.items) && r.body.items.length === 1, r.body);
    r = await req('GET', API + '/' + O1 + '/variance-report', ua);
    check('variance-report: yield 90, components with variance', r.status === 200 && near(r.body.data.yieldPct, 90) && r.body.data.components.length === 2, r.body && r.body.data);
    r = await req('GET', API + '/' + O1 + '/print', ua);
    check('print payload assembled', r.status === 200 && r.body.data && r.body.data.header && Array.isArray(r.body.data.outputs), null);
    r = await req('POST', API + '/preview-availability', ua, { bomId: BOM1, qtyPlanned: 20, warehouseId: WPA });
    check('preview-availability (2 components, batches=2)', r.status === 200 && r.body.summary && near(r.body.summary.batches, 2) && r.body.items.length === 2, r.body && r.body.summary);
    r = await req('GET', API + '/boms', ua);
    check('boms picker lists both BOMs', r.status === 200 && (r.body.data || []).filter((b) => [BOM1, BOM2].includes(b.id)).length === 2, (r.body.data || []).length);

    // ── 17) FINAL — cleanup O3/O6 by reverse, then baseline invariants ───────
    await req('POST', API + '/' + O3 + '/reverse', ub, { reason: 'تنظيف' }, { 'Idempotency-Key': 'p1-o3-rev' });
    await req('POST', API + '/' + O6 + '/reverse', ub, { reason: 'تنظيف' }, { 'Idempotency-Key': 'p1-o6-rev' });
    s = await qty(WPA, RAW1);
    check('BASELINE: RAW1 returns to exactly 100', near(s.q, 100), s);
    s = await qty(WPA, RAW2);
    check('BASELINE: RAW2 returns to exactly 50', near(s.q, 50), s);
    s = await qty(WPB, FG1);
    check('BASELINE: FG1 zero', near(s.q, 0), s);
    s = await qty(WPB, FG2);
    check('BASELINE: FG2 zero', near(s.q, 0), s);
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  const exitCode = _f === 0 ? 0 : 1;
  console.log(`\n${_f === 0 ? '✅' : '❌'} production.api: ${_p} passed, ${_f} failed\n`);
  process.exit(exitCode);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
