#!/usr/bin/env node
'use strict';
/**
 * tests/procurementReceiving.test.js — «لماذا لا يمكنني عمل استلام».
 *
 * WHAT WAS BROKEN
 *   Two independent obstacles stood between an approved purchase order and a
 *   goods receipt:
 *     1. the SPA never called POST /api/procurement/receipts at all (covered by
 *        frontend/erp/src/modules/purchasing/__tests__/receiving-flow.test.tsx);
 *     2. this route hard-required `warehouseId` and answered 422 «المستودع
 *        مطلوب» — even though the PO it receives against already carries
 *        `purchase_orders.warehouse_id`. Every receipt sent from a screen that
 *        knew only the PO was rejected.
 *
 * WHAT THIS FILE PROVES
 *   It mounts the REAL /api/procurement router behind the REAL warehouse-scope
 *   middleware (WAREHOUSE_SCOPE_ENFORCE=1) against the REAL MySQL dev database,
 *   builds its fixtures by driving the REAL order routes (no hand-written PO
 *   SQL), and pins:
 *     • a receipt that omits warehouseId inherits the PO's;
 *     • an explicit warehouseId still wins;
 *     • the inherited warehouse is STILL subject to req.guardWh — a user scoped
 *       away from the PO's warehouse is refused, and the same user succeeds
 *       when they name a warehouse they do hold. A default that skipped the
 *       guard would be a silent scope bypass, so both directions are asserted;
 *     • over-receipt is refused (the server owns that rule — see the note at
 *       the over-receipt section for exactly WHEN it fires);
 *     • posting moves po_lines.base_received_qty by the base quantity actually
 *       received and walks the PO draft → partially_received → fully_received.
 *
 * Run: node tests/procurementReceiving.test.js   (real DB; writes + cleans up
 *      fixtures prefixed TEST-RCV-)
 */

process.env.PROCUREMENT_P2P_ENABLE = '1';
// Must be set BEFORE middleware/warehouseScope.js is required — it reads the
// flag once, at module load, into a const.
process.env.WAREHOUSE_SCOPE_ENFORCE = '1';

try { require('dotenv').config(); } catch (_) { /* env may already be present */ }

const express = require('express');
const db = require('../db/connection');
const { loadWarehouseScope, isEnforced } = require('../middleware/warehouseScope');

let _passed = 0;
const _failures = [];
function ok(cond, msg, extra) {
  if (cond) { _passed++; console.log('  ✅', msg); return; }
  _failures.push(msg + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.log('  ❌', msg, extra !== undefined ? '→ ' + JSON.stringify(extra) : '');
}
function eqn(a, b, msg, tol = 1e-6) {
  ok(Math.abs(Number(a) - Number(b)) <= tol, msg, { got: Number(a), want: Number(b) });
}

// ── fixtures ────────────────────────────────────────────────────────────────
const SUP = 'TEST-RCV-SUP';
const ITEM = 'TEST-RCV-ITEM';
const WH_A = 'TEST-RCV-WHA';   // the PO's warehouse
const WH_B = 'TEST-RCV-WHB';   // a second warehouse, for the explicit override
const U_SCOPED = 'test_rcv_scoped';  // manager, granted WH_B only

// The PO: 10 cartons × 12 = 120 base units, priced per carton.
const FACTOR = 12;
const ORDER_CARTONS = 10;
const ORDERED_BASE = ORDER_CARTONS * FACTOR;
const CARTON_COST = 120;

/**
 * Auth stub: username → the real users row (so req.user.id resolves the real
 * warehouse grants). Everything after it — capability guard, warehouse scope,
 * the router — is production code.
 */
function buildApp(users) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const name = String(req.headers['x-test-user'] || 'admin');
    req.user = users[name] || { id: 0, username: name, role: 'admin', isDeveloper: true };
    next();
  });
  app.use(loadWarehouseScope);
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function cleanup() {
  const q = (sql, params) => db.query(sql, params).catch(() => {});
  await q("DELETE ge FROM gl_entries ge JOIN gl_journals gj ON gj.id = ge.journal_id WHERE gj.reference_type = 'GoodsReceipt' AND gj.reference_id IN (SELECT id FROM purchase_receipts WHERE supplier_id = ?)", [SUP]);
  await q("DELETE FROM gl_journals WHERE reference_type = 'GoodsReceipt' AND reference_id IN (SELECT id FROM purchase_receipts WHERE supplier_id = ?)", [SUP]);
  await q('DELETE prl FROM purchase_receipt_lines prl JOIN purchase_receipts pr ON pr.id = prl.receipt_id WHERE pr.supplier_id = ?', [SUP]);
  await q('DELETE FROM purchase_receipts WHERE supplier_id = ?', [SUP]);
  await q('DELETE pl FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE po.supplier_id = ?', [SUP]);
  await q('DELETE FROM purchase_orders WHERE supplier_id = ?', [SUP]);
  await q('DELETE FROM inventory_movements WHERE item_id = ? OR warehouse_id IN (?, ?)', [ITEM, WH_A, WH_B]);
  await q('DELETE FROM inventory_cost_history WHERE item_id = ?', [ITEM]);
  await q('DELETE FROM item_cost_history WHERE item_id = ?', [ITEM]);
  await q('DELETE FROM warehouse_stock WHERE item_id = ?', [ITEM]);
  await q('DELETE FROM purchase_lots WHERE inv_item_id = ?', [ITEM]);
  // Posting bumps inv_items.stock alongside warehouse_stock; leaving it behind
  // desyncs the item's counter from Σwarehouse_stock permanently.
  await q('UPDATE inv_items SET stock = 0, cost = 0 WHERE id = ?', [ITEM]);
  await q('DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id = uwa.user_id WHERE u.username = ?', [U_SCOPED]);
  await q('DELETE FROM users WHERE username = ?', [U_SCOPED]);
}

async function seed() {
  await cleanup();
  for (const [id, code, name] of [[WH_A, 'TRA', 'مستودع استلام أ'], [WH_B, 'TRB', 'مستودع استلام ب']]) {
    await db.query('INSERT INTO warehouses (id, code, name, is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE is_active = 1, name = VALUES(name)', [id, code, name]);
  }
  await db.query(
    "INSERT INTO inv_items (id, name, kind, unit, big_unit, conv_rate, cost, stock, tracking_mode) VALUES (?,?,?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE stock = 0, cost = 0, tracking_mode = 'none'",
    [ITEM, 'مادة اختبار الاستلام', 'raw', 'حبة', 'كرتون', FACTOR]);
  await db.query('INSERT INTO suppliers (id, name, is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE is_active = 1', [SUP, 'مورد اختبار الاستلام']);
  await db.query('INSERT INTO users (username, password, role, active) VALUES (?,?,?,1)', [U_SCOPED, 'disabled-for-tests', 'manager']);
  const [u] = await db.query('SELECT id FROM users WHERE username = ?', [U_SCOPED]);
  // Granted WH_B ONLY — deliberately NOT the PO's warehouse.
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)', [u[0].id, WH_B, 'test']);
  return { [U_SCOPED]: { id: u[0].id, username: U_SCOPED, role: 'manager' } };
}

async function main() {
  console.log('\n═══ procurement receiving — warehouse inheritance, scope, over-receipt ═══\n');
  ok(isEnforced(), 'warehouse-scope enforcement is ON for this run (otherwise the scope assertions prove nothing)');

  const users = await seed();
  const app = buildApp(users);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, user) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user || 'admin' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  const receiptRow = async (id) => (await db.query('SELECT * FROM purchase_receipts WHERE id = ?', [id]))[0][0];
  const poRow = async (id) => (await db.query('SELECT * FROM purchase_orders WHERE id = ?', [id]))[0][0];
  const poLine = async (id) => (await db.query('SELECT * FROM po_lines WHERE id = ?', [id]))[0][0];

  /** Create → submit → approve a PO on WH_A, through the real routes. */
  async function approvedPO() {
    const created = await call('POST', '/api/procurement/orders', {
      supplierId: SUP, warehouseId: WH_A,
      lines: [{ itemId: ITEM, itemName: 'مادة اختبار الاستلام', enteredQty: ORDER_CARTONS, factor: FACTOR, enteredUnitCode: 'كرتون', unitPriceEntered: CARTON_COST, vatRate: 15 }],
    }, 'test_rcv_maker');
    if (created.status !== 201) throw new Error('fixture PO create failed: ' + JSON.stringify(created));
    const id = created.json.data.id;
    await call('POST', `/api/procurement/orders/${id}/submit`, {}, 'test_rcv_maker');
    const approved = await call('POST', `/api/procurement/orders/${id}/approve`, {}, 'test_rcv_checker');
    if (approved.status !== 200) throw new Error('fixture PO approve failed: ' + JSON.stringify(approved));
    const [lines] = await db.query('SELECT id, base_qty FROM po_lines WHERE po_id = ?', [id]);
    return { id, lineId: lines[0].id, orderedBase: Number(lines[0].base_qty) };
  }
  const receiptBody = (po, cartons, extra) => Object.assign({
    poId: po.id, supplierId: SUP,
    lines: [{ itemId: ITEM, itemName: 'مادة اختبار الاستلام', poLineId: po.lineId, enteredQty: cartons, factor: FACTOR, unitCost: CARTON_COST }],
  }, extra || {});

  let exitCode = 0;
  try {
    // ── 1. the warehouse is inherited from the PO ───────────────────────────
    console.log('\n── 1. omitted warehouseId inherits the PO\'s ──');
    const po1 = await approvedPO();
    eqn(po1.orderedBase, ORDERED_BASE, 'fixture PO line ordered in base units');
    ok((await poRow(po1.id)).warehouse_id === WH_A, 'the PO itself carries the warehouse');

    const r1 = await call('POST', '/api/procurement/receipts', receiptBody(po1, 4), 'test_rcv_admin');
    ok(r1.status === 201, 'receipt created WITHOUT warehouseId (was 422 «المستودع مطلوب»)', r1.json);
    const row1 = await receiptRow(r1.json.data.id);
    ok(row1.warehouse_id === (await poRow(po1.id)).warehouse_id,
      'the receipt header inherited the PO\'s warehouse — not a hardcoded default', { receipt: row1.warehouse_id, po: WH_A });
    const [ln1] = await db.query('SELECT warehouse_id FROM purchase_receipt_lines WHERE receipt_id = ?', [r1.json.data.id]);
    ok(ln1.every((l) => l.warehouse_id === WH_A), 'every receipt LINE inherited it too', ln1.map((l) => l.warehouse_id));

    // ── 2. an explicit warehouse still wins ────────────────────────────────
    console.log('\n── 2. an explicit warehouseId overrides the PO\'s ──');
    const r2 = await call('POST', '/api/procurement/receipts', receiptBody(po1, 1, { warehouseId: WH_B }), 'test_rcv_admin');
    ok(r2.status === 201, 'receipt created with an explicit warehouse', r2.json);
    const row2 = await receiptRow(r2.json.data.id);
    ok(row2.warehouse_id === WH_B && row2.warehouse_id !== (await poRow(po1.id)).warehouse_id,
      'the explicit value won over the PO\'s', { receipt: row2.warehouse_id, po: WH_A });

    // ── 3. the inherited warehouse is STILL scope-guarded ──────────────────
    // The whole point of the default is convenience; if it also skipped
    // req.guardWh it would be a silent way into a warehouse the caller was
    // deliberately kept out of. Both directions are asserted so a guard that
    // simply denies everything cannot pass this section.
    console.log('\n── 3. the default does not bypass req.guardWh ──');
    const denied = await call('POST', '/api/procurement/receipts', receiptBody(po1, 1), U_SCOPED);
    ok(denied.status === 403 && denied.json.code === 'WAREHOUSE_ACCESS_DENIED',
      'a user without the PO\'s warehouse is refused even though they never named it', denied.json);
    const [afterDenied] = await db.query('SELECT COUNT(*) AS c FROM purchase_receipts WHERE po_id = ? AND created_by = ?', [po1.id, U_SCOPED]);
    eqn(afterDenied[0].c, 0, 'the refused request wrote no receipt');

    const allowed = await call('POST', '/api/procurement/receipts', receiptBody(po1, 1, { warehouseId: WH_B }), U_SCOPED);
    ok(allowed.status === 201, 'the SAME user succeeds for a warehouse they do hold', allowed.json);
    ok((await receiptRow(allowed.json.data.id)).warehouse_id === WH_B, 'and it landed in that warehouse');

    // A per-line warehouse reaches applyReceiptStock (`ln.warehouse_id ||
    // grn.warehouse_id`), so it must clear the same guard — otherwise a caller
    // could name an allowed header and smuggle a forbidden line through.
    const smuggled = await call('POST', '/api/procurement/receipts', {
      poId: po1.id, supplierId: SUP, warehouseId: WH_B,
      lines: [{ itemId: ITEM, itemName: 'مادة', poLineId: po1.lineId, enteredQty: 1, factor: FACTOR, unitCost: CARTON_COST, warehouseId: WH_A }],
    }, U_SCOPED);
    ok(smuggled.status === 403 && smuggled.json.code === 'WAREHOUSE_ACCESS_DENIED',
      'a forbidden PER-LINE warehouse is refused behind an allowed header', smuggled.json);

    // ── 4. receiving moves po_lines.base_received_qty + the PO status ──────
    console.log('\n── 4. posting moves base_received_qty and the PO status ──');
    const po2 = await approvedPO();
    ok((await poRow(po2.id)).status === 'approved', 'fresh PO starts approved');
    eqn((await poLine(po2.lineId)).base_received_qty, 0, 'nothing received yet');

    async function receiveAndPost(po, cartons, extra) {
      const created = await call('POST', '/api/procurement/receipts', receiptBody(po, cartons, extra), 'test_rcv_admin');
      if (created.status !== 201) return { phase: 'create', status: created.status, json: created.json };
      const id = created.json.data.id;
      const app2 = await call('POST', `/api/procurement/receipts/${id}/approve`, {}, 'test_rcv_admin');
      if (app2.status !== 200) return { phase: 'approve', status: app2.status, json: app2.json, id };
      const posted = await call('POST', `/api/procurement/receipts/${id}/post`, {}, 'test_rcv_admin');
      return { phase: 'post', status: posted.status, json: posted.json, id };
    }

    const partial = await receiveAndPost(po2, 4);
    ok(partial.phase === 'post' && partial.status === 200, 'partial receipt (4 cartons) posted', partial);
    // The property: received base = exactly what was sent × the conversion
    // factor. A hardcoded 48 would still pass if the factor were dropped.
    eqn((await poLine(po2.lineId)).base_received_qty, 4 * FACTOR, 'base_received_qty moved by enteredQty × factor');
    ok((await poRow(po2.id)).status === 'partially_received', 'PO rolled up to partially_received', (await poRow(po2.id)).status);

    const rest = await receiveAndPost(po2, ORDER_CARTONS - 4);
    ok(rest.phase === 'post' && rest.status === 200, 'the remaining 6 cartons posted', rest);
    const lineFull = await poLine(po2.lineId);
    eqn(lineFull.base_received_qty, lineFull.base_qty, 'received now equals ordered');
    ok((await poRow(po2.id)).status === 'fully_received', 'PO rolled up to fully_received', (await poRow(po2.id)).status);
    const [stock] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?', [WH_A, ITEM]);
    eqn(stock.length ? stock[0].qty : 0, ORDERED_BASE, 'the stock that moved equals what was received');

    // ── 5. over-receipt is refused ─────────────────────────────────────────
    // The server owns this rule, against a LOCKED po_lines row inside the
    // posting transaction (services/procurement/InventoryPostingService.js) —
    // the only race-free place for it. NOTE the timing: a draft receipt for
    // more than the remaining quantity is still ACCEPTED at create; the
    // refusal lands at POST, before any stock or GL effect. The refusal, not
    // the acceptance, is what must never regress.
    console.log('\n── 5. over-receipt is refused (server-side, at post) ──');
    const over = await receiveAndPost(po2, 1);
    ok(over.phase === 'post' && over.status === 422 && over.json.code === 'OVER_RECEIPT',
      'receiving beyond the remaining quantity is refused', over);
    const lineAfterOver = await poLine(po2.lineId);
    eqn(lineAfterOver.base_received_qty, lineAfterOver.base_qty, 'the refused over-receipt moved nothing');
    const [stockAfterOver] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?', [WH_A, ITEM]);
    eqn(stockAfterOver.length ? stockAfterOver[0].qty : 0, ORDERED_BASE, 'and no stock leaked in');

    // Partially-received lines are refused above their own remainder too, not
    // just fully-received ones.
    const po3 = await approvedPO();
    const half = await receiveAndPost(po3, 6);
    ok(half.phase === 'post' && half.status === 200, 'PO3: 6 of 10 cartons posted', half);
    const tooMany = await receiveAndPost(po3, 5); // only 4 remain
    ok(tooMany.phase === 'post' && tooMany.status === 422 && tooMany.json.code === 'OVER_RECEIPT',
      'a partial line refuses more than ITS remainder (5 > 4)', tooMany);
    eqn((await poLine(po3.lineId)).base_received_qty, 6 * FACTOR, 'the partial line kept exactly what it had');
    const exact = await receiveAndPost(po3, 4);
    ok(exact.phase === 'post' && exact.status === 200, 'receiving exactly the remainder is allowed', exact);
  } catch (e) {
    _failures.push('threw: ' + (e && e.stack ? e.stack : String(e)));
    console.error('  ❌ threw:', e);
  } finally {
    server.close();
    await cleanup();
  }

  console.log(`\n──────── ${_passed} passed, ${_failures.length} failed ────────`);
  if (_failures.length) {
    console.error('\nFAILURES:');
    _failures.forEach((f) => console.error('  • ' + f));
    exitCode = 1;
  }
  await db.end().catch(() => {});
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
