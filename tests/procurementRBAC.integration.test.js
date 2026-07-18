/**
 * Procurement RBAC proof (live DB): every mutation is gated by its capability,
 * and the actor is taken from the JWT (never the body). Uses REAL seeded role
 * grants (purchasing / finance / inventory / cashier) via requireCapability.
 *
 * Run: node tests/procurementRBAC.integration.test.js
 */
'use strict';

process.env.PROCUREMENT_P2P_ENABLE = '1';
const express = require('express');
const db = require('../db/connection');

let _p = 0, _f = 0;
function ok(c, m) { if (c) { _p++; console.log('  ✅', m); } else { _f++; console.log('  ❌', m); } }

function buildApp() {
  const app = express();
  app.use(express.json());
  // stub auth: role + username come from headers so we can exercise real capability grants
  app.use((req, _res, next) => {
    req.user = { id: 1, username: String(req.headers['x-test-user'] || 'admin'), role: String(req.headers['x-test-role'] || 'admin') };
    req.guardWh = () => true; req.whScopeClause = () => ({ sql: '', params: [] });
    next();
  });
  app.use('/api/procurement', require('../routes/procurement'));
  return app;
}

async function main() {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, p, body, role, user) {
    const res = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', 'x-test-role': role || 'admin', 'x-test-user': user || (role || 'admin') },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  const SUP = 'TEST-P2P-SUP', ITEM = 'TEST-P2P-ITEM', WH = 'TEST-P2P-WH';
  // These POs/receipts never get posted (approve stops short of /post, receipts
  // never get approved+posted here), so no GL journal/inventory movement is
  // ever created — but the header/line rows themselves must not be left behind.
  async function cleanup() {
    await db.query('DELETE prl FROM purchase_receipt_lines prl JOIN purchase_receipts pr ON pr.id=prl.receipt_id WHERE pr.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM purchase_receipts WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE pl FROM po_lines pl JOIN purchase_orders po ON po.id=pl.po_id WHERE po.supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM purchase_orders WHERE supplier_id=?', [SUP]).catch(() => {});
    await db.query('DELETE FROM suppliers WHERE id=?', [SUP]).catch(() => {});
  }
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)', [WH, 'TWH', 'wh']);
  await db.query("INSERT INTO inv_items (id,name,kind,unit,cost,stock,tracking_mode) VALUES (?,?,?,?,0,0,'none') ON DUPLICATE KEY UPDATE stock=stock", [ITEM, 'مادة', 'raw', 'حبة']);
  await db.query("INSERT INTO suppliers (id,name,is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE is_active=1", [SUP, 'مورد']);
  const poBody = { supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, enteredQty: 1, factor: 1, unitPriceEntered: 10, vatRate: 15 }] };
  const invBody = { supplierId: SUP, invoiceKind: 'non_stock', lines: [{ itemId: ITEM, description: 'x', enteredQty: 1, factor: 1, unitPriceEntered: 10, vatRate: 0 }] };
  const rcvBody = { supplierId: SUP, warehouseId: WH, lines: [{ itemId: ITEM, enteredQty: 1, factor: 1, unitCost: 10 }] };

  try {
  console.log('\n── capability enforcement per endpoint/role ──');
  // cashier has NO procurement grants
  ok((await call('POST', '/api/procurement/orders', poBody, 'cashier')).status === 403, 'cashier POST /orders → 403');
  ok((await call('POST', '/api/procurement/suppliers', { name: 'x' }, 'cashier')).status === 403, 'cashier POST /suppliers → 403');
  // purchasing CAN create a PO but CANNOT approve/post
  const poc = await call('POST', '/api/procurement/orders', poBody, 'purchasing', 'pur1');
  ok(poc.status === 201, 'purchasing POST /orders → 201 (has purchase_orders.create)');
  const poId = poc.json.data && poc.json.data.id;
  if (poId) {
    await call('POST', `/api/procurement/orders/${poId}/submit`, {}, 'purchasing', 'pur1');
    ok((await call('POST', `/api/procurement/orders/${poId}/approve`, {}, 'purchasing', 'pur1')).status === 403, 'purchasing POST /orders/:id/approve → 403 (lacks approve)');
    ok((await call('POST', `/api/procurement/orders/${poId}/approve`, {}, 'manager', 'mgr1')).status === 200, 'manager POST /orders/:id/approve → 200 (has approve)');
  }
  // inventory can create receipts, NOT invoices
  ok((await call('POST', '/api/procurement/receipts', rcvBody, 'inventory', 'inv1')).status === 201, 'inventory POST /receipts → 201 (has receipts.create)');
  ok((await call('POST', '/api/procurement/invoices', invBody, 'inventory', 'inv1')).status === 403, 'inventory POST /invoices → 403 (lacks supplier_invoices.create)');
  // finance can create/approve invoices, NOT receipts
  ok((await call('POST', '/api/procurement/receipts', rcvBody, 'finance', 'fin1')).status === 403, 'finance POST /receipts → 403 (lacks receipts.create)');
  ok((await call('POST', '/api/procurement/invoices', invBody, 'finance', 'fin1')).status === 201, 'finance POST /invoices → 201 (has supplier_invoices.create)');
  // reads: cashier lacks procurement.view → 403 on list
  ok((await call('GET', '/api/procurement/orders', null, 'cashier')).status === 403, 'cashier GET /orders → 403 (lacks procurement.view)');
  ok((await call('GET', '/api/procurement/orders', null, 'purchasing')).status === 200, 'purchasing GET /orders → 200 (has procurement.view)');

  console.log('\n── actor is taken from JWT, never the body ──');
  const sup = await call('POST', '/api/procurement/suppliers', { name: 'مورد RBAC', createdBy: 'HACKER', username: 'HACKER' }, 'purchasing', 'realuser');
  ok(sup.status === 201, 'purchasing created supplier');
  if (sup.json.data && sup.json.data.id) {
    const [[row]] = await db.query('SELECT created_by FROM suppliers WHERE id=?', [sup.json.data.id]);
    ok(row.created_by === 'realuser', `supplier created_by = JWT user 'realuser' (ignored body 'HACKER') — got '${row.created_by}'`);
    await db.query('DELETE FROM suppliers WHERE id=?', [sup.json.data.id]).catch(() => {});
  }
  } finally {
    await cleanup();
  }

  server.close();
  await db.end();
  console.log(`\nProcurement RBAC: ${_p} passed, ${_f} failed`);
  process.exit(_f ? 1 : 0);
}

main().catch((e) => { console.error('RBAC TEST ERROR:', e.stack || e.message); process.exit(1); });
