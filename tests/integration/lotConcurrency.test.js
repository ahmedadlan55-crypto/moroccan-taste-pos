/**
 * Phase 4B — Lot integration for transfers + production + concurrency (ENFORCE=1).
 *
 * Drives the hardened warehouse-ops endpoints (/api/erp) for TRACKED items:
 *   • Transfer: issue FEFO-allocates source lots into an in-transit ledger; a
 *     PARTIAL receive then a final receive add the SAME lots to the destination;
 *     reverse restores both sides. Invariant Σ(lot)=stock after every leg.
 *   • Production: release FEFO-consumes a tracked component (genealogy recorded);
 *     complete creates a finished-goods lot linked back to the consumed lots.
 *   • Concurrency: two parallel transfer issues racing the source's last qty →
 *     exactly one succeeds; the lot balances stay consistent (no double-allocate).
 *
 * Run: node tests/integration/lotConcurrency.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.LOTC_TEST_PORT || 3272);
const BASE = { host: '127.0.0.1', port: PORT };
const TA = 'WH-4BC-A', TB = 'WH-4BC-B';
const C = 'LOTC-COMP', P = 'LOTC-PROD', CC = 'LOTC-RACE';
const U = 'lotc_mgr';
const E = '/api/erp/stock-issues', PO = '/api/erp/production-orders';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function dplus(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code })); r.setTimeout(9000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role) { return jwt.sign({ id, username: u, role }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function stockQty(wh, item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, item]); return r.length ? Number(r[0].qty) : 0; }
async function lotBal(wh, item, lotId) { const [r] = await db.query('SELECT qty FROM warehouse_lot_balances WHERE warehouse_id=? AND lot_id=?', [wh, lotId]); return r.length ? Number(r[0].qty) : 0; }
async function lotSum(wh, item) { const [r] = await db.query('SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [wh, item]); return Number(r[0].s); }
async function invOk(wh, item) { return Math.abs(await lotSum(wh, item) - await stockQty(wh, item)) < 0.001; }

async function cleanup() {
  const sqls = [
    ['DELETE FROM lot_transfer_allocations WHERE source_warehouse_id IN (?,?) OR dest_warehouse_id IN (?,?)', [TA, TB, TA, TB]],
    ['DELETE FROM production_output_lots WHERE work_order_id LIKE ?', ['WO-LOTC%']],
    ['DELETE FROM work_order_lot_consumption WHERE work_order_id LIKE ?', ['WO-LOTC%']],
    ['DELETE FROM inventory_lot_movements WHERE warehouse_id IN (?,?)', [TA, TB]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id IN (?,?)', [TA, TB]],
    ['DELETE FROM inventory_lots WHERE item_id IN (?,?,?)', [C, P, CC]],
    ['DELETE FROM production_consumption WHERE production_order_id LIKE ?', ['WO-LOTC%']],
    ['DELETE FROM production_output WHERE production_order_id LIKE ?', ['WO-LOTC%']],
    ['DELETE FROM production_orders WHERE id LIKE ?', ['WO-LOTC%']],
    ['DELETE sii FROM stock_issue_items sii JOIN stock_issues si ON si.id=sii.issue_id WHERE si.from_warehouse_id IN (?,?)', [TA, TB]],
    ['DELETE FROM stock_issue_events WHERE issue_id IN (SELECT id FROM stock_issues WHERE from_warehouse_id IN (?,?))', [TA, TB]],
    ['DELETE FROM stock_issues WHERE from_warehouse_id IN (?,?)', [TA, TB]],
    ['DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)', [TA, TB]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [TA, TB]],
    ['DELETE FROM idempotency_keys WHERE username=?', [U]],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username=?', [U]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?)', [C, P, CC]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [TA, TB]],
    ['DELETE FROM users WHERE username=?', [U]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [TA, '4BCA', 'مصدر', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [TB, '4BCB', 'وجهة', 'branch']);
  for (const it of [C, P, CC]) await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [it, 'صنف ' + it, 'خام', 'كجم', 5, 2]);
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U, 'disabled', 'manager']);
  const [r] = await db.query('SELECT id FROM users WHERE username=?', [U]);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [r[0].id, TA, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [r[0].id, TB, 'test']);
  return r[0].id;
}
// Seed a tracked item's lot state directly (after boot): stock + 2 lots, invariant-true.
async function seedLots(item, lots, wh) {
  let total = 0;
  for (const l of lots) {
    await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES (?,?,?,?,?, 'active',5,1)", [l.id, item, l.id, l.id.toUpperCase(), l.exp]);
    await db.query('INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES (?,?,?,?,?)', ['B-' + l.id, wh, l.id, item, l.qty]);
    total += l.qty;
  }
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE qty=VALUES(qty)', ['WS-' + wh + '-' + item, wh, item, total, 5]);
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Lot transfers + production + concurrency (ENFORCE=1) ═══\n');
  const uid = await seed();
  const mgr = tok(uid, U, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    // After boot: flag tracked items + seed lot state.
    await db.query("UPDATE inv_items SET tracking_mode='lot' WHERE id IN (?,?,?)", [C, P, CC]);
    await seedLots(C, [{ id: 'LOTCA', qty: 30, exp: dplus(20) }, { id: 'LOTCB', qty: 50, exp: dplus(120) }], TA);

    // ── TRANSFER: issue (FEFO) → partial receive → full receive → reverse ──
    const cr = await req('POST', E, mgr, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: C, qtyRequested: 40 }] }, { 'Idempotency-Key': 'lotc-c' });
    check('transfer create → draft', (cr.status === 200 || cr.status === 201) && cr.body && cr.body.id, { st: cr.status });
    const tid = cr.body.id;
    await req('POST', `${E}/${tid}/approve`, mgr, {});
    const iss = await req('POST', `${E}/${tid}/issue`, mgr, {}, { 'Idempotency-Key': 'lotc-i' });
    check('transfer issue → 200', iss.status === 200, iss.body && iss.body.code);
    check('issue FEFO drained source: LOTCA 30→0, LOTCB 50→40', (await lotBal(TA, C, 'LOTCA')) === 0 && (await lotBal(TA, C, 'LOTCB')) === 40, { A: await lotBal(TA, C, 'LOTCA'), B: await lotBal(TA, C, 'LOTCB') });
    check('in-transit allocations recorded (LOTCA:30, LOTCB:10)', await allocSnapshot(tid), 'mismatch');
    check('source invariant holds after issue', await invOk(TA, C), { stock: await stockQty(TA, C), lot: await lotSum(TA, C) });
    check('destination has NOTHING yet (in transit)', (await lotSum(TB, C)) === 0, await lotSum(TB, C));

    const lineId = (await db.query('SELECT id FROM stock_issue_items WHERE issue_id=?', [tid]))[0][0].id;
    const pr = await req('POST', `${E}/${tid}/receive`, mgr, { items: [{ id: lineId, qtyReceived: 25 }] });
    check('partial receive 25 → 200', pr.status === 200, pr.body && pr.body.code);
    check('dest got 25 from LOTCA (earliest expiry first)', (await lotBal(TB, C, 'LOTCA')) === 25 && (await lotBal(TB, C, 'LOTCB')) === 0, { A: await lotBal(TB, C, 'LOTCA'), B: await lotBal(TB, C, 'LOTCB') });
    check('dest invariant holds after partial receive', await invOk(TB, C), { stock: await stockQty(TB, C), lot: await lotSum(TB, C) });

    const fr = await req('POST', `${E}/${tid}/receive`, mgr, {});
    check('final receive → 200', fr.status === 200, fr.body && fr.body.code);
    check('dest now LOTCA=30, LOTCB=10 (the SAME lots, identity preserved)', (await lotBal(TB, C, 'LOTCA')) === 30 && (await lotBal(TB, C, 'LOTCB')) === 10, { A: await lotBal(TB, C, 'LOTCA'), B: await lotBal(TB, C, 'LOTCB') });
    check('both invariants hold after full receipt', (await invOk(TA, C)) && (await invOk(TB, C)), { ta: await lotSum(TA, C), tb: await lotSum(TB, C) });

    const rev = await req('POST', `${E}/${tid}/reverse`, mgr, { reason: 'إرجاع اختبار الدفعات' });
    check('transfer reverse → 200', rev.status === 200, rev.body && rev.body.code);
    check('reverse restored source LOTCA=30, LOTCB=50; dest empty', (await lotBal(TA, C, 'LOTCA')) === 30 && (await lotBal(TA, C, 'LOTCB')) === 50 && (await lotSum(TB, C)) === 0, { A: await lotBal(TA, C, 'LOTCA'), B: await lotBal(TA, C, 'LOTCB'), tb: await lotSum(TB, C) });
    check('both invariants hold after reverse', (await invOk(TA, C)) && (await invOk(TB, C)), null);

    // ── PRODUCTION: release consumes a tracked component (FEFO) → complete builds a finished lot ──
    const wo = 'WO-LOTC-1';
    await db.query("INSERT INTO production_orders (id, order_number, bom_id, product_id, warehouse_id, output_warehouse_id, qty_planned, status, total_cost) VALUES (?,?,?,?,?,?,?, 'planned', 100)", [wo, 'PO-LOTC-1', 'BOM-TEST', P, TA, TA, 5]);
    await db.query("INSERT INTO production_consumption (id, production_order_id, item_id, warehouse_id, qty_planned, unit_cost, total_cost) VALUES (?,?,?,?,?,?,?)", ['PCC-LOTC-1', wo, C, TA, 20, 5, 100]);
    const rel = await req('POST', `${PO}/${wo}/release`, mgr, { releasedBy: U });
    check('production release → success', rel.status === 200 && rel.body.success, rel.body);
    check('release FEFO-consumed 20 from LOTCA (30→10)', (await lotBal(TA, C, 'LOTCA')) === 10 && (await lotBal(TA, C, 'LOTCB')) === 50, { A: await lotBal(TA, C, 'LOTCA'), B: await lotBal(TA, C, 'LOTCB') });
    const [woc] = await db.query('SELECT lot_id, qty FROM work_order_lot_consumption WHERE work_order_id=?', [wo]);
    check('consumption genealogy recorded (LOTCA, 20)', woc.length === 1 && woc[0].lot_id === 'LOTCA' && Number(woc[0].qty) === 20, woc);
    check('component invariant holds after release', await invOk(TA, C), null);

    const comp = await req('POST', `${PO}/${wo}/complete`, mgr, { completedBy: U, qtyProduced: 5, batchNumber: 'FG-LOTC-001', expiryDate: dplus(200) });
    check('production complete → success', comp.status === 200 && comp.body.success, comp.body);
    const [fg] = await db.query("SELECT l.lot_norm, b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=?", [TA, P]);
    check('finished-goods lot FG-LOTC-001 qty 5 created', fg.length === 1 && fg[0].lot_norm === 'FG-LOTC-001' && Number(fg[0].qty) === 5, fg);
    const [pol] = await db.query('SELECT component_lot_id, qty FROM production_output_lots WHERE work_order_id=?', [wo]);
    check('output→component genealogy links FG lot to LOTCA', pol.length >= 1 && pol.some((x) => x.component_lot_id === 'LOTCA'), pol);
    check('finished-good invariant holds', await invOk(TA, P), { stock: await stockQty(TA, P), lot: await lotSum(TA, P) });

    // ── CONCURRENCY: two transfers racing the source's last qty → one wins ──
    await seedLots(CC, [{ id: 'LOTRACE', qty: 10, exp: dplus(60) }], TA);
    const t1 = (await req('POST', E, mgr, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: CC, qtyRequested: 10 }] })).body.id;
    const t2 = (await req('POST', E, mgr, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: CC, qtyRequested: 10 }] })).body.id;
    await req('POST', `${E}/${t1}/approve`, mgr, {});
    await req('POST', `${E}/${t2}/approve`, mgr, {});
    const [r1, r2] = await Promise.all([req('POST', `${E}/${t1}/issue`, mgr, {}), req('POST', `${E}/${t2}/issue`, mgr, {})]);
    const wins = [r1, r2].filter((r) => r.status === 200).length;
    const loses = [r1, r2].filter((r) => r.status >= 400).length;
    check('two concurrent issues on last 10 → exactly one wins', wins === 1 && loses === 1, { s1: r1.status, s2: r2.status });
    check('source CC drained to 0; invariant intact (no double-allocate)', (await lotSum(TA, CC)) === 0 && (await invOk(TA, CC)), { lot: await lotSum(TA, CC), stock: await stockQty(TA, CC) });

  } catch (e) { _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();

async function allocSnapshot(transferId) {
  const [r] = await db.query('SELECT source_lot_id, qty FROM lot_transfer_allocations WHERE transfer_id=? ORDER BY source_lot_id', [transferId]);
  const m = {}; for (const x of r) m[x.source_lot_id] = Number(x.qty);
  return m.LOTCA === 30 && m.LOTCB === 10; // true when the in-transit split is correct
}
