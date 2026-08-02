#!/usr/bin/env node
'use strict';
/**
 * Two follow-ups to the procurement fixes, both found by observation rather
 * than by reading.
 *
 * A) PURCHASE ORDERS CARRIED THE REQUISITION BUG, ARMED BUT NOT YET FIRED.
 *    `purchase_orders.warehouse_id` is NULLABLE and the list filters it with
 *    `IN (…)`. NULL matches no IN-list, so the first PO created without a
 *    warehouse would have become invisible to every scoped user — including
 *    the person who created it. There were zero NULL rows in the dev database,
 *    which is exactly why nobody had seen it: the defect was latent, and a
 *    test written against today's data would have passed while the trap stayed
 *    armed. The detail route had the same hole in a worse form — it applied no
 *    scope at all, so a filtered list sat in front of an unfiltered read-by-id.
 *
 * B) A RECEIPT COULD BE POSTED AGAINST A PO IN ANY STATUS.
 *    Observed live: a PO stuck at `submitted` — its approval refused by the
 *    self-approval guard — accepted a receipt, which posted and rolled it
 *    straight to `fully_received`. Goods entering stock against an order
 *    nobody approved makes the approval step optional in practice. The UI only
 *    offered the action on approved/sent/partially_received; this makes that a
 *    server contract instead of a client courtesy.
 *
 * The routers run behind the REAL warehouse-scope middleware with enforcement
 * ON (the flag is read once at module load, so it is set before the require),
 * and every document is created by speaking HTTP to the real endpoints — never
 * by hand-written fixture SQL, which is free to describe a shape production
 * never writes.
 */
process.env.WAREHOUSE_SCOPE_ENFORCE = '1';

const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const db = require('./../db/connection');

let pass = 0, fail = 0;
function it(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log('  ok   ' + name); })
    .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); });
}

const P = '__TEST_POSCOPE__';
const WH_A = P + 'WH-A';
const WH_B = P + 'WH-B';
const SUP = P + 'SUP';
const ITEM = P + 'ITEM';
// Numeric ids, because `user_warehouse_access` keys on user_id — not username.
const USER_GLOBAL = { id: 990301, username: P + 'admin', role: 'admin' };
const USER_A = { id: 990302, username: P + 'usr_a', role: 'manager' };

let server, port;

function sign(u) {
  return jwt.sign(
    { id: u.id, username: u.username, role: u.role, tokenVersion: 1 },
    process.env.JWT_SECRET || 'dev-secret-change-me',
    { expiresIn: '1h' });
}

function call(token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, json: j, raw: b.slice(0, 300) });
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    if (data) req.write(data);
    req.end();
  });
}

async function cleanup() {
  const like = P + '%';
  for (const [t, c] of [
    ['purchase_receipt_lines', 'receipt_id'], ['purchase_receipts', 'id'],
    ['po_lines', 'po_id'], ['purchase_orders', 'id'],
  ]) {
    try {
      if (c === 'id') await db.query(`DELETE FROM \`${t}\` WHERE id LIKE ? OR warehouse_id LIKE ?`, [like, like]);
      else await db.query(`DELETE FROM \`${t}\` WHERE ${c} IN (SELECT id FROM ${t === 'po_lines' ? 'purchase_orders' : 'purchase_receipts'} WHERE id LIKE ?)`, [like]);
    } catch (_) {}
  }
  for (const [t, w] of [['purchase_orders', 'warehouse_id'], ['purchase_receipts', 'warehouse_id']]) {
    try { await db.query(`DELETE FROM \`${t}\` WHERE ${w} LIKE ?`, [like]); } catch (_) {}
  }
  for (const u of [990301, 990302]) {
    try { await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [u]); } catch (_) {}
    try { await db.query('DELETE FROM users WHERE id = ?', [u]); } catch (_) {}
  }
  try { await db.query('DELETE FROM warehouses WHERE id LIKE ?', [like]); } catch (_) {}
  try { await db.query('DELETE FROM suppliers WHERE id LIKE ?', [like]); } catch (_) {}
  try { await db.query('DELETE FROM inv_items WHERE id LIKE ?', [like]); } catch (_) {}
}

async function seed() {
  await cleanup();
  for (const w of [WH_A, WH_B]) {
    await db.query(
      'INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)',
      [w, w.slice(-8), w]);
  }
  await db.query('INSERT INTO suppliers (id,name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [SUP, SUP]);
  await db.query(
    "INSERT INTO inv_items (id,name,kind,unit,cost,stock,tracking_mode) VALUES (?,?,'raw','PC',0,0,'none') ON DUPLICATE KEY UPDATE stock=stock",
    [ITEM, ITEM]);
  for (const u of [USER_GLOBAL, USER_A]) {
    await db.query('DELETE FROM user_warehouse_access WHERE user_id=?', [u.id]).catch(() => {});
    await db.query(
      'INSERT INTO users (id,username,password,role,active) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role), active=1',
      [u.id, u.username, 'x', u.role]);
  }
  // USER_A is granted WH_A only; USER_GLOBAL is admin → global scope, no grants.
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)',
    [USER_A.id, WH_A, 'poscope']);
}

async function main() {
  console.log('procurementOrderScopeAndReceiptStatus');
  try { await db.query('SELECT 1'); } catch (e) {
    console.log('  FATAL: MySQL unreachable — ' + (e.code || e.message));
    process.exit(2);
  }
  await seed();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const h = String(req.headers.authorization || '');
    try { req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'dev-secret-change-me'); } catch (_) {}
    next();
  });
  // The module exports named helpers, not a bare middleware — same mounting as
  // tests/procurementRequisitionVisibility.test.js.
  const { loadWarehouseScope } = require('../middleware/warehouseScope');
  app.use('/api/procurement', loadWarehouseScope);
  app.use('/api/procurement', require('../routes/procurement'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  const TG = sign(USER_GLOBAL);
  const TA = sign(USER_A);

  /** Create a PO through the REAL route, as the given user. */
  async function makePo(token, warehouseId) {
    const r = await call(token, 'POST', '/api/procurement/orders', {
      supplierId: SUP,
      warehouseId,
      lines: [{ itemId: ITEM, enteredQty: 10, unitPrice: 5, enteredUnitCode: 'PC' }],
    });
    return r;
  }

  console.log('\n1. a PO with NO warehouse must stay visible to the person who created it');

  await it('the scoped creator sees their own warehouse-less PO', async () => {
    const c = await makePo(TA, null);
    assert.strictEqual(c.status, 201, 'create failed: ' + JSON.stringify(c.json || c.raw));
    const id = c.json.data.id;
    const [row] = await db.query('SELECT warehouse_id, created_by FROM purchase_orders WHERE id = ?', [id]);
    assert.strictEqual(row[0].warehouse_id, null, 'this test is vacuous unless the row really is NULL');

    const list = await call(TA, 'GET', '/api/procurement/orders?pageSize=200');
    assert.strictEqual(list.status, 200);
    const seen = (list.json.data || []).some((o) => o.id === id);
    assert.ok(seen, 'the creator cannot see the PO they just filed');
  });

  await it('…and can open it by id', async () => {
    const c = await makePo(TA, null);
    const d = await call(TA, 'GET', '/api/procurement/orders/' + c.json.data.id);
    assert.strictEqual(d.status, 200, 'detail refused the creator their own row');
  });

  console.log('\n2. …without opening anyone else\'s');

  await it('a scoped user does NOT see another user\'s warehouse-less PO', async () => {
    // The NULL branch is bounded by created_by. Widening it to a bare
    // `OR warehouse_id IS NULL` would pass test 1 and fail this one.
    const c = await makePo(TG, null);
    assert.strictEqual(c.status, 201);
    const list = await call(TA, 'GET', '/api/procurement/orders?pageSize=200');
    assert.ok(!(list.json.data || []).some((o) => o.id === c.json.data.id),
      'a scoped user was handed an unassigned PO created by somebody else');
  });

  await it('a scoped user does NOT see another WAREHOUSE\'s PO', async () => {
    const c = await makePo(TG, WH_B);
    assert.strictEqual(c.status, 201);
    const list = await call(TA, 'GET', '/api/procurement/orders?pageSize=200');
    assert.ok(!(list.json.data || []).some((o) => o.id === c.json.data.id));
  });

  await it('reading another warehouse\'s PO by id is 404, not 403', async () => {
    // A 403 confirms the id exists. The body must be indistinguishable from a
    // never-issued id.
    const c = await makePo(TG, WH_B);
    const d = await call(TA, 'GET', '/api/procurement/orders/' + c.json.data.id);
    assert.strictEqual(d.status, 404, 'detail leaked an out-of-scope PO (status ' + d.status + ')');
    const ghost = await call(TA, 'GET', '/api/procurement/orders/' + P + 'no-such-id');
    assert.strictEqual(d.json.code, ghost.json.code, 'out-of-scope and missing must answer identically');
  });

  await it('the global user sees every one of them — the clause is not a blanket deny', async () => {
    const list = await call(TG, 'GET', '/api/procurement/orders?pageSize=200');
    const mine = (list.json.data || []).filter((o) => String(o.supplier_id || '') === SUP);
    assert.ok(mine.length >= 4, `global user saw only ${mine.length} of the seeded POs`);
  });

  console.log('\n3. a receipt may only be filed against an APPROVED purchase order');

  await it('a draft PO refuses a receipt', async () => {
    const c = await makePo(TG, WH_A);
    const r = await call(TG, 'POST', '/api/procurement/receipts', {
      poId: c.json.data.id,
      lines: [{ itemId: ITEM, enteredQty: 1, unitPrice: 5 }],
    });
    assert.strictEqual(r.status, 422, 'a draft PO accepted goods (status ' + r.status + ')');
    assert.match(String(r.json.error || ''), /اعتماده|حالته/, 'the refusal must name the reason');
  });

  await it('a SUBMITTED PO refuses a receipt — the case seen live', async () => {
    // This is the exact shape observed: approval refused by the self-approval
    // guard, PO left at `submitted`, and a receipt posted anyway.
    const c = await makePo(TG, WH_A);
    const id = c.json.data.id;
    const s = await call(TG, 'POST', '/api/procurement/orders/' + id + '/submit', { expectedVersion: 1 });
    assert.ok(s.status < 400, 'submit failed: ' + JSON.stringify(s.json || s.raw));
    const [row] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    assert.strictEqual(String(row[0].status), 'submitted', 'fixture is not in the state under test');

    const r = await call(TG, 'POST', '/api/procurement/receipts', {
      poId: id, lines: [{ itemId: ITEM, enteredQty: 1, unitPrice: 5 }],
    });
    assert.strictEqual(r.status, 422, 'a submitted PO accepted goods — approval is optional in practice');
    const [after] = await db.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    assert.strictEqual(String(after[0].status), 'submitted', 'the refused receipt still moved the PO');
    const [grn] = await db.query('SELECT COUNT(*) c FROM purchase_receipts WHERE po_id = ?', [id]);
    assert.strictEqual(Number(grn[0].c), 0, 'the refused receipt was written anyway');
  });

  await it('a non-existent PO is a clean 404, not a crash', async () => {
    const r = await call(TG, 'POST', '/api/procurement/receipts', {
      poId: P + 'ghost', lines: [{ itemId: ITEM, enteredQty: 1, unitPrice: 5 }],
    });
    assert.strictEqual(r.status, 404);
  });

  await it('a DIRECT receipt with no PO is still allowed — that path is legitimate', async () => {
    // The status gate must not turn into "receipts require a PO".
    const r = await call(TG, 'POST', '/api/procurement/receipts', {
      warehouseId: WH_A, supplierId: SUP,
      lines: [{ itemId: ITEM, enteredQty: 1, unitPrice: 5 }],
    });
    assert.notStrictEqual(r.status, 422,
      'the PO-status gate rejected a direct receipt: ' + JSON.stringify(r.json || r.raw));
  });

  await new Promise((r) => server.close(r));
  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch (_) {}
  process.exit(2);
});
