#!/usr/bin/env node
'use strict';
/**
 * tests/procurementRequisitionCycle.test.js — the branch → requisition → PO
 * cycle, end to end, against the live DB.
 *
 * WHAT WAS BROKEN
 *   · The branch was a free-text id. The list filters by branch id, so a
 *     request typed "الرياض" matched nothing, and a request filed against a
 *     warehouse carried no branch at all — visible under one filter, absent
 *     under the other. Same document, two answers.
 *   · The PO knew nothing of its requisition. The requisition stored po_id;
 *     purchase_orders had no requisition column. From an order you could not
 *     reach the branch request that caused it, and the orders list could not
 *     show it. A one-way reference is not traceability.
 *   · Neither read returned NAMES. Rows carried ids nobody recognises.
 *
 * WHAT THIS FILE PINS
 *   1. A branch names its warehouse: filing with branchId alone stamps the
 *      branch's warehouse_id; filing with warehouseId alone stamps the unique
 *      owning branch. Neither guess overwrites an explicit value.
 *   2. Both filters find the same document, and reads carry branch/warehouse
 *      NAMES and the PO's NUMBER.
 *   3. Converting stamps purchase_orders.requisition_id; the order's own reads
 *      (list + detail) name the requisition; the orders list filters by branch.
 *   4. The dashboard counts submitted requisitions.
 *
 * Runs the REAL routes/procurement router behind the REAL warehouse-scope
 * middleware; every row is created through the HTTP surface, never by an
 * INSERT the test wrote itself.
 */

process.env.PROCUREMENT_P2P_ENABLE = '1';
process.env.WAREHOUSE_SCOPE_ENFORCE = '1';

const express = require('express');
const db = require('../db/connection');
const { loadWarehouseScope, isEnforced } = require('../middleware/warehouseScope');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const WH_A = 'WH-REQCYC-A', WH_B = 'WH-REQCYC-B';
const BR_A = 'BR-REQCYC-A';            // owns WH_A
// TWO branches own WH_B. A warehouse with several owners must not be
// attributed to either of them — that is a guess, and the wrong branch would
// then see (and approve) another branch's request.
const BR_B1 = 'BR-REQCYC-B1', BR_B2 = 'BR-REQCYC-B2';
const ITEM = 'REQCYC-ITEM';
const SUP = 'SUP-REQCYC';
const ADMIN = { id: 990301, username: 'reqcyc_admin', role: 'admin' };
const MGR = { id: 990302, username: 'reqcyc_mgr', role: 'manager' };   // WH_A + WH_B
const EMP = { id: 990303, username: 'reqcyc_emp', role: 'employee' };  // WH_A only
const OUT = { id: 990304, username: 'reqcyc_out', role: 'employee' };  // WH_B only — NOT the branch's warehouse
const ALL_USERS = [ADMIN, MGR, EMP, OUT];
const NOTE_TAG = 'reqcyc-fixture';
const LINES = [{ itemId: ITEM, itemName: 'مادة دورة الطلب', quantity: 3, estimatedPrice: 10 }];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: Number(req.headers['x-test-uid']), username: String(req.headers['x-test-user']), role: String(req.headers['x-test-role']) };
    next();
  });
  app.use('/api/procurement', loadWarehouseScope);
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function seed() {
  // The additive procurement schema (purchase_orders.requisition_id lives
  // there) is applied at server boot by the release chain; a test that boots
  // only the router has to apply it the same way, or it tests a DB the app
  // never runs against.
  await require('../db/migrations/procurement/schema').apply(db, () => {});
  for (const [id, code, name] of [[WH_A, 'RCA', 'مستودع الدورة أ'], [WH_B, 'RCB', 'مستودع الدورة ب']]) {
    await db.query('INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)', [id, code, name]);
  }
  // The branch that OWNS warehouse A. This is the fact the derivation reads.
  await db.query('INSERT INTO branches (id, name, warehouse_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), warehouse_id=VALUES(warehouse_id)',
    [BR_A, 'فرع الدورة', WH_A]);
  for (const [id, name] of [[BR_B1, 'فرع ب ١'], [BR_B2, 'فرع ب ٢']]) {
    await db.query('INSERT INTO branches (id, name, warehouse_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), warehouse_id=VALUES(warehouse_id)', [id, name, WH_B]);
  }
  await db.query("INSERT INTO inv_items (id,name,kind,unit,cost,stock,tracking_mode) VALUES (?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE stock=stock",
    [ITEM, 'مادة دورة الطلب', 'raw', 'حبة']);
  await db.query('INSERT INTO suppliers (id, name, is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE is_active=1', [SUP, 'مورد الدورة']);
  for (const u of ALL_USERS) {
    await db.query('DELETE FROM user_warehouse_access WHERE user_id=?', [u.id]);
    await db.query('INSERT INTO users (id, username, password, role, active) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role), active=1',
      [u.id, u.username, 'x', u.role]);
  }
  for (const [u, whs] of [[MGR, [WH_A, WH_B]], [EMP, [WH_A]], [OUT, [WH_B]]]) {
    for (const w of whs) await db.query('INSERT IGNORE INTO user_warehouse_access (user_id, warehouse_id) VALUES (?,?)', [u.id, w]);
  }
}

async function cleanup() {
  const [reqs] = await db.query('SELECT id, po_id FROM purchase_requisitions WHERE notes LIKE ?', [NOTE_TAG + '%']).catch(() => [[]]);
  for (const r of reqs) {
    if (r.po_id) {
      await db.query('DELETE FROM po_lines WHERE po_id=?', [r.po_id]).catch(() => {});
      await db.query('DELETE FROM procurement_events WHERE document_id=?', [r.po_id]).catch(() => {});
      await db.query('DELETE FROM purchase_orders WHERE id=?', [r.po_id]).catch(() => {});
    }
    await db.query('DELETE FROM purchase_requisition_lines WHERE requisition_id=?', [r.id]).catch(() => {});
  }
  await db.query('DELETE FROM purchase_requisitions WHERE notes LIKE ?', [NOTE_TAG + '%']).catch(() => {});
  for (const id of [BR_A, BR_B1, BR_B2]) await db.query('DELETE FROM branches WHERE id=?', [id]).catch(() => {});
  for (const u of ALL_USERS) {
    await db.query('DELETE FROM user_warehouse_access WHERE user_id=?', [u.id]).catch(() => {});
    await db.query('DELETE FROM users WHERE id=?', [u.id]).catch(() => {});
  }
}

async function main() {
  await cleanup();
  await seed();
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, body, u) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-uid': String(u.id), 'x-test-user': u.username, 'x-test-role': u.role },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const createAs = (u, extra) => call('POST', '/api/procurement/requisitions',
    Object.assign({ lines: LINES, notes: NOTE_TAG + ' ' + u.username }, extra || {}), u);
  const rowOf = async (id) => (await db.query('SELECT * FROM purchase_requisitions WHERE id=?', [id]))[0][0] || null;

  try {
    console.log('\n0. the enforcement this file depends on');
    await test('warehouse-scope enforcement is ON', () => eq(isEnforced(), true));

    // ── 1. attribution ───────────────────────────────────────────────────────
    console.log('\n1. a branch names its warehouse, and a warehouse names its branch');
    let byBranch, byWarehouse, explicitBoth;
    await test('filing with branchId alone stamps the branch\'s warehouse', async () => {
      const r = await createAs(MGR, { branchId: BR_A });
      eq(r.status, 201, 'create');
      byBranch = r.json.data.id;
      const row = await rowOf(byBranch);
      eq(row.branch_id, BR_A, 'branch kept');
      eq(row.warehouse_id, WH_A, 'warehouse derived from the branch');
    });
    await test('filing with warehouseId alone stamps the unique owning branch', async () => {
      const r = await createAs(MGR, { warehouseId: WH_A });
      eq(r.status, 201, 'create');
      byWarehouse = r.json.data.id;
      const row = await rowOf(byWarehouse);
      eq(row.warehouse_id, WH_A, 'warehouse kept');
      eq(row.branch_id, BR_A, 'branch derived from the warehouse');
    });
    await test('a warehouse SEVERAL branches own leaves the branch NULL — no guessing', async () => {
      // BR_B1 and BR_B2 both own WH_B. Picking either would hand one branch
      // the other's request.
      const r = await createAs(MGR, { warehouseId: WH_B });
      eq(r.status, 201, 'create');
      const row = await rowOf(r.json.data.id);
      eq(row.warehouse_id, WH_B);
      eq(row.branch_id, null, 'not invented');
    });
    await test('a branch whose warehouse is OUT of the caller\'s scope is refused, not filed', async () => {
      // OUT may reach WH_B only. BR_A implies WH_A. The derived warehouse has
      // to clear the same guard an explicit one does — otherwise naming a
      // branch is a way around warehouse scope.
      const r = await createAs(OUT, { branchId: BR_A });
      eq(r.status, 403, 'refused: ' + JSON.stringify(r.json).slice(0, 120));
    });
    await test('an explicit warehouse is never overwritten by the branch\'s', async () => {
      const r = await createAs(MGR, { branchId: BR_A, warehouseId: WH_B });
      eq(r.status, 201, 'create');
      explicitBoth = r.json.data.id;
      const row = await rowOf(explicitBoth);
      eq(row.branch_id, BR_A);
      eq(row.warehouse_id, WH_B, 'explicit value wins');
    });
    await test('a derived warehouse still passes the scope guard (EMP may reach WH_A)', async () => {
      const r = await createAs(EMP, { branchId: BR_A });
      eq(r.status, 201, 'create');
      eq((await rowOf(r.json.data.id)).warehouse_id, WH_A);
    });
    await test('editing the branch re-derives the warehouse', async () => {
      const r = await call('PUT', `/api/procurement/requisitions/${explicitBoth}`, { branchId: BR_A, warehouseId: '' }, MGR);
      eq(r.status, 200, 'update');
      eq((await rowOf(explicitBoth)).warehouse_id, WH_A, 're-derived');
    });

    // ── 2. both filters find the same document, with names ────────────────
    console.log('\n2. both filters find the same document, and reads carry names');
    await test('the branch filter finds the request filed by warehouse', async () => {
      const r = await call('GET', `/api/procurement/requisitions?branchId=${BR_A}&pageSize=200`, null, MGR);
      eq(r.status, 200);
      const ids = r.json.data.map((x) => x.id);
      ok(ids.includes(byWarehouse), 'filed by warehouse, found by branch');
      ok(ids.includes(byBranch), 'filed by branch, found by branch');
    });
    await test('the warehouse filter finds the request filed by branch', async () => {
      const r = await call('GET', `/api/procurement/requisitions?warehouseId=${WH_A}&pageSize=200`, null, MGR);
      const ids = r.json.data.map((x) => x.id);
      ok(ids.includes(byBranch), 'filed by branch, found by warehouse');
    });
    await test('the list carries branch and warehouse NAMES, not just ids', async () => {
      const r = await call('GET', `/api/procurement/requisitions?branchId=${BR_A}&pageSize=200`, null, MGR);
      const row = r.json.data.find((x) => x.id === byBranch);
      eq(row.branch_name, 'فرع الدورة');
      eq(row.warehouse_name, 'مستودع الدورة أ');
    });
    await test('mine=1 returns only what the caller filed', async () => {
      const r = await call('GET', '/api/procurement/requisitions?mine=1&pageSize=200', null, EMP);
      eq(r.status, 200);
      ok(r.json.data.length >= 1, 'has own');
      ok(r.json.data.every((x) => x.created_by === EMP.username), 'nobody else\'s');
    });

    // ── 3. the PO knows its requisition ─────────────────────────────────────
    console.log('\n3. converting links the PO back to its requisition');
    let poId, poNumber;
    await test('submit → approve → convert answers with the PO number', async () => {
      eq((await call('POST', `/api/procurement/requisitions/${byBranch}/submit`, {}, MGR)).status, 200, 'submit');
      eq((await call('POST', `/api/procurement/requisitions/${byBranch}/approve`, {}, MGR)).status, 200, 'approve');
      const r = await call('POST', `/api/procurement/requisitions/${byBranch}/convert-to-po`,
        { supplierId: SUP, lines: { } }, MGR);
      eq(r.status, 201, 'convert ' + JSON.stringify(r.json).slice(0, 200));
      poId = r.json.data.poId; poNumber = r.json.documentNumber;
      ok(poId && poNumber, 'poId + documentNumber');
    });
    await test('purchase_orders.requisition_id is stamped', async () => {
      const [[po]] = await db.query('SELECT requisition_id, branch_id, warehouse_id FROM purchase_orders WHERE id=?', [poId]);
      eq(po.requisition_id, byBranch, 'back-reference');
      eq(po.branch_id, BR_A, 'branch carried onto the PO');
      eq(po.warehouse_id, WH_A, 'warehouse carried onto the PO');
    });
    await test('the requisition read names the PO by NUMBER', async () => {
      const r = await call('GET', `/api/procurement/requisitions/${byBranch}`, null, MGR);
      eq(r.json.data.po_number, poNumber);
      eq(r.json.data.status, 'converted');
    });
    await test('the order detail names its source requisition', async () => {
      const r = await call('GET', `/api/procurement/orders/${poId}`, null, ADMIN);
      eq(r.status, 200);
      const req = await rowOf(byBranch);
      eq(r.json.data.requisition_number, req.req_number);
      eq(r.json.data.branch_name, 'فرع الدورة');
    });
    await test('the orders list filters by branch and carries the requisition number', async () => {
      const r = await call('GET', `/api/procurement/orders?branchId=${BR_A}&pageSize=200`, null, ADMIN);
      eq(r.status, 200);
      const row = r.json.data.find((x) => x.id === poId);
      ok(row, 'PO found under its branch');
      const req = await rowOf(byBranch);
      eq(row.requisition_number, req.req_number);
      // And NOT under a branch it does not belong to. Without this the filter
      // could be deleted and the test would still pass, since an unfiltered
      // list also contains the PO.
      const other = await call('GET', `/api/procurement/orders?branchId=${BR_B1}&pageSize=200`, null, ADMIN);
      ok(!other.json.data.some((x) => x.id === poId), 'absent under another branch');
    });
    await test('per-line price override reaches the PO line', async () => {
      // a second requisition, converted with a supplier price on its line
      const c = await createAs(MGR, { branchId: BR_A });
      const id = c.json.data.id;
      await call('POST', `/api/procurement/requisitions/${id}/submit`, {}, MGR);
      await call('POST', `/api/procurement/requisitions/${id}/approve`, {}, MGR);
      const [[line]] = await db.query('SELECT id FROM purchase_requisition_lines WHERE requisition_id=? LIMIT 1', [id]);
      const r = await call('POST', `/api/procurement/requisitions/${id}/convert-to-po`,
        { supplierId: SUP, lines: { [line.id]: { unitPrice: 12.5 } } }, MGR);
      eq(r.status, 201, 'convert with override');
      const [[pl]] = await db.query('SELECT unit_price FROM po_lines WHERE po_id=? LIMIT 1', [r.json.data.poId]);
      eq(Number(pl.unit_price), 12.5, 'the supplier price, not the estimate');
    });

    // ── 4. the dashboard counts the queue ───────────────────────────────────
    console.log('\n4. the dashboard counts submitted requisitions');
    await test('requisitionsPending counts status=submitted', async () => {
      const c = await createAs(MGR, { branchId: BR_A });
      await call('POST', `/api/procurement/requisitions/${c.json.data.id}/submit`, {}, MGR);
      const r = await call('GET', '/api/procurement/dashboard', null, ADMIN);
      eq(r.status, 200, 'dashboard');
      ok(Number(r.json.data.requisitionsPending) >= 1, 'counted: ' + r.json.data.requisitionsPending);
    });
  } finally {
    server.close();
    await cleanup();
    await db.end?.().catch?.(() => {});
  }

  console.log(`\n${_passed}/${_total} passed${_failed ? `, ${_failed} failed` : ''}`);
  if (_failed) process.exit(1);
  console.log('  ✅ branch ⇄ warehouse attribution, names on reads, PO back-reference, dashboard queue');
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
