/**
 * Phase 4B — Lot-aware shared-engine writers integration test (ENFORCE=1).
 *
 * Boots server.js and drives the v2 receipts / issues / adjustments + reverse for a
 * TRACKED item (tracking_mode='expiry') through /api/inventory/v2, proving:
 *   • receipt of a tracked item REQUIRES lots whose Σqty = line qty (LOT_REQUIRED).
 *   • the mandatory FEFO scenario: lot A(30, near-expiry) + B(50, later); issue 40
 *     ⇒ A=30, B=10 (earliest-expiry first).
 *   • the hard invariant Σ(warehouse_lot_balances)=warehouse_stock after every post.
 *   • already-expired lot receipt is blocked (EXPIRED_LOT).
 *   • manual allocation (with reason) honored; over-a-lot → INSUFFICIENT_LOT_QUANTITY.
 *   • quarantined lot is skipped by FEFO.
 *   • reverse restores the EXACT original lots (never re-runs FEFO).
 *   • an UNTRACKED item still works with no lot rows (regression).
 *
 * Run: node tests/integration/lots.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.LOTS_TEST_PORT || 3271);
const BASE = { host: '127.0.0.1', port: PORT };
const WA = 'WH-4B-A';
const T = 'LOTS-TRACKED', U = 'LOTS-UNTRACKED';
const ACC_REV = '4910', ACC_EXP = '5300';
const ADMIN = 'lots_admin';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.001 : tol); }
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
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

const R = '/api/inventory/v2/receipts', I = '/api/inventory/v2/issues', A = '/api/inventory/v2/adjustments';

async function stockQty(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WA, item]); return r.length ? Number(r[0].qty) : 0; }
async function lotBal(item, lotNumber) { const [r] = await db.query("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_norm=?", [WA, item, lotNumber.toUpperCase()]); return r.length ? Number(r[0].qty) : 0; }
async function lotSum(item) { const [r] = await db.query('SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [WA, item]); return Number(r[0].s); }
async function invariantOk(item) { return near(await lotSum(item), await stockQty(item)); }
async function lotMoveCount(item) { const [r] = await db.query('SELECT COUNT(*) n FROM inventory_lot_movements WHERE warehouse_id=? AND item_id=?', [WA, item]); return Number(r[0].n); }

// create → approve → post a doc; returns the POST response (+ id).
async function lifecycle(path, token, body, idem) {
  const c = await req('POST', path, token, body, { 'Idempotency-Key': idem + '-c' });
  if (c.status !== 201) return { ok: false, stage: 'create', res: c };
  const id = c.body.id;
  const a = await req('POST', `${path}/${id}/approve`, token, { expectedVersion: 1 });
  if (a.status !== 200) return { ok: false, stage: 'approve', res: a, id };
  const p = await req('POST', `${path}/${id}/post`, token, { expectedVersion: 2 }, { 'Idempotency-Key': idem + '-p' });
  return { ok: p.status === 200, stage: 'post', res: p, id };
}

async function cleanup() {
  const sqls = [
    ['DELETE m FROM inventory_lot_movements m WHERE m.warehouse_id=?', [WA]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [WA]],
    ['DELETE FROM inventory_lots WHERE item_id IN (?,?)', [T, U]],
    ['DELETE e FROM inv_tx_events e JOIN inv_receipts d ON d.id=e.doc_id WHERE d.warehouse_id=?', [WA]],
    ['DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id=?', [WA]],
    ['DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id=?', [WA]],
    ['DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id=?', [WA]],
    ['DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id=?', [WA]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id=?', [WA]],
    ['DELETE FROM inv_receipts WHERE warehouse_id=?', [WA]],
    ['DELETE FROM inv_issues WHERE warehouse_id=?', [WA]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id=?', [WA]],
    ["DELETE FROM inventory_movements WHERE warehouse_id=?", [WA]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WA]],
    ["DELETE FROM gl_journals WHERE reference_type LIKE 'inv\\_%' AND (reference_id LIKE 'RCV-%' OR reference_id LIKE 'ISU-%' OR reference_id LIKE 'ADV-%')", []],
    ['DELETE FROM idempotency_keys WHERE username=?', [ADMIN]],
    ['DELETE FROM inv_items WHERE id IN (?,?)', [T, U]],
    ['DELETE FROM warehouses WHERE id=?', [WA]],
    ['DELETE FROM users WHERE username=?', [ADMIN]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WA, '4BA', 'مستودع الدفعات', 'main']);
  // Tracked item starts at ZERO stock (no warehouse_stock row) so the invariant holds
  // from t0. tracking_mode is set AFTER the server boots (the migration adds the column).
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)", [T, 'صنف بدفعات', 'خام', 'كجم', 5, 2]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)", [U, 'صنف بلا دفعات', 'خام', 'كجم', 5, 2]);
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Lots — shared-engine writers (ENFORCE=1) ═══\n');
  await seed();
  const admin = tok(0, ADMIN, 'admin', true);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', INV_MAKER_CHECKER: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    // Now the migration has added tracking_mode — flag the tracked item (U stays 'none').
    await db.query("UPDATE inv_items SET tracking_mode='expiry' WHERE id=?", [T]);

    // 1) Receipt of a tracked item WITHOUT lots → 422 LOT_REQUIRED (at build).
    const noLots = await req('POST', R, admin, { warehouseId: WA, reason: 'بلا دفعات', counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 10, unitCost: 5 }] });
    check('tracked receipt WITHOUT lots → 422 LOT_REQUIRED', noLots.status === 422 && noLots.body.code === 'LOT_REQUIRED', noLots.body && noLots.body.code);

    // lot sum ≠ line qty → 422
    const badSum = await req('POST', R, admin, { warehouseId: WA, reason: 'مجموع خاطئ', counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 80, unitCost: 5, lots: [{ lotNumber: 'LOT-A', qty: 30, expiryDate: dplus(20) }] }] });
    check('lot sum ≠ line qty → 422 VALIDATION_ERROR', badSum.status === 422 && badSum.body.code === 'VALIDATION_ERROR', badSum.body && badSum.body.code);

    // expiry mode lot WITHOUT expiry → 422
    const noExp = await req('POST', R, admin, { warehouseId: WA, reason: 'بلا صلاحية', counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 10, unitCost: 5, lots: [{ lotNumber: 'LOT-X', qty: 10 }] }] });
    check('expiry-mode lot WITHOUT expiry → 422', noExp.status === 422 && noExp.body.code === 'VALIDATION_ERROR', noExp.body && noExp.body.code);

    // 2) Receipt with A(30, near) + B(50, later) → post.
    const rc = await lifecycle(R, admin, { warehouseId: WA, reason: 'استلام بدفعات', counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 80, unitCost: 5, lots: [{ lotNumber: 'LOT-A', qty: 30, expiryDate: dplus(20) }, { lotNumber: 'LOT-B', qty: 50, expiryDate: dplus(120) }] }] }, 'rcv1');
    check('tracked receipt with 2 lots → posted', rc.ok, { stage: rc.stage, res: rc.res && rc.res.body });
    check('lot balances A=30, B=50 after receipt', (await lotBal(T, 'LOT-A')) === 30 && (await lotBal(T, 'LOT-B')) === 50, { A: await lotBal(T, 'LOT-A'), B: await lotBal(T, 'LOT-B') });
    check('stock=80 and INVARIANT holds (Σlot=stock)', (await stockQty(T)) === 80 && (await invariantOk(T)), { stock: await stockQty(T), lotSum: await lotSum(T) });

    // 3) Receipt of an already-expired lot → blocked at post (EXPIRED_LOT).
    const expd = await lifecycle(R, admin, { warehouseId: WA, reason: 'دفعة منتهية', counterAccountCode: ACC_REV, items: [{ itemId: T, qty: 5, unitCost: 5, lots: [{ lotNumber: 'LOT-EXP', qty: 5, expiryDate: dplus(-5) }] }] }, 'rcvexp');
    check('expired-lot receipt → 422 EXPIRED_LOT at post', expd.res && expd.res.status === 422 && expd.res.body.code === 'EXPIRED_LOT', expd.res && expd.res.body && expd.res.body.code);
    check('expired-lot receipt did NOT move stock (still 80)', (await stockQty(T)) === 80 && (await invariantOk(T)), await stockQty(T));

    // 4) FEFO issue 40 → A=30, B=10 (the mandatory scenario).
    const iss = await lifecycle(I, admin, { warehouseId: WA, reason: 'صرف FEFO', expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 40 }] }, 'iss1');
    check('FEFO issue 40 → posted', iss.ok, { stage: iss.stage, res: iss.res && iss.res.body });
    check('FEFO allocated A=30, B=10 → balances A=0, B=40', (await lotBal(T, 'LOT-A')) === 0 && (await lotBal(T, 'LOT-B')) === 40, { A: await lotBal(T, 'LOT-A'), B: await lotBal(T, 'LOT-B') });
    check('stock=40 and INVARIANT holds after issue', (await stockQty(T)) === 40 && (await invariantOk(T)), { stock: await stockQty(T), lotSum: await lotSum(T) });

    // 5) Reverse the issue → restores the EXACT original lots (A+30, B+10).
    const rev = await req('POST', `${I}/${iss.id}/reverse`, admin, { expectedVersion: 3, reason: 'عكس الصرف' }, { 'Idempotency-Key': 'iss1-rev' });
    check('issue reverse → 200', rev.status === 200, rev.body && rev.body.code);
    check('reverse restored A=30, B=50 (exact lots, NOT re-FEFO)', (await lotBal(T, 'LOT-A')) === 30 && (await lotBal(T, 'LOT-B')) === 50, { A: await lotBal(T, 'LOT-A'), B: await lotBal(T, 'LOT-B') });
    check('stock=80 and INVARIANT holds after reverse', (await stockQty(T)) === 80 && (await invariantOk(T)), { stock: await stockQty(T), lotSum: await lotSum(T) });

    // 6) Manual allocation: issue 10 from LOT-B specifically (with reason).
    const man = await lifecycle(I, admin, { warehouseId: WA, reason: 'صرف يدوي', expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 10, lotAllocations: [{ lotId: await lotId('LOT-B'), qty: 10 }], allocationReason: 'تخصيص يدوي مبرر' }] }, 'man1');
    check('manual allocation issue → posted, B=40 (A untouched=30)', man.ok && (await lotBal(T, 'LOT-B')) === 40 && (await lotBal(T, 'LOT-A')) === 30, { ok: man.ok, A: await lotBal(T, 'LOT-A'), B: await lotBal(T, 'LOT-B') });

    // manual allocation exceeding a lot → INSUFFICIENT_LOT_QUANTITY (at post)
    const manBad = await lifecycle(I, admin, { warehouseId: WA, reason: 'تخصيص زائد', expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 999, lotAllocations: [{ lotId: await lotId('LOT-B'), qty: 999 }] }] }, 'man2');
    check('manual allocation over the lot → INSUFFICIENT (blocked)', manBad.res && manBad.res.status === 422 && /INSUFFICIENT/.test(manBad.res.body.code || ''), manBad.res && manBad.res.body && manBad.res.body.code);

    // 7) Quarantined lot is skipped by FEFO. Quarantine LOT-A (30 left), issue 20 → must come from B.
    await db.query("UPDATE inventory_lots SET lifecycle_status='quarantined' WHERE item_id=? AND lot_norm='LOT-A'", [T]);
    const issQ = await lifecycle(I, admin, { warehouseId: WA, reason: 'صرف مع حجر', expenseAccountCode: ACC_EXP, items: [{ itemId: T, qty: 20 }] }, 'issq');
    check('FEFO skips quarantined LOT-A → takes from B', issQ.ok && (await lotBal(T, 'LOT-A')) === 30 && (await lotBal(T, 'LOT-B')) === 20, { ok: issQ.ok, A: await lotBal(T, 'LOT-A'), B: await lotBal(T, 'LOT-B') });
    check('INVARIANT still holds after quarantine-aware issue', await invariantOk(T), { stock: await stockQty(T), lotSum: await lotSum(T) });
    await db.query("UPDATE inventory_lots SET lifecycle_status='active' WHERE item_id=? AND lot_norm='LOT-A'", [T]);

    // 8) Lot movements recorded throughout.
    check('inventory_lot_movements recorded (> 4)', (await lotMoveCount(T)) > 4, await lotMoveCount(T));

    // 9) UNTRACKED item still works with NO lot rows (regression).
    const ut = await lifecycle(R, admin, { warehouseId: WA, reason: 'استلام عادي', counterAccountCode: ACC_REV, items: [{ itemId: U, qty: 25, unitCost: 5 }] }, 'utr');
    check('untracked receipt → posted, stock 25, ZERO lot rows', ut.ok && (await stockQty(U)) === 25 && (await lotSum(U)) === 0, { ok: ut.ok, stock: await stockQty(U), lotSum: await lotSum(U) });

  } catch (e) { _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();

async function lotId(lotNumber) { const [r] = await db.query('SELECT id FROM inventory_lots WHERE item_id=? AND lot_norm=?', [T, lotNumber.toUpperCase()]); return r.length ? r[0].id : null; }
