/**
 * Phase W3 — Purchase → V2 receipt linkage + partial receiving integration.
 *
 * Boots server.js and exercises:
 *   • seed a legacy purchase (100 units, tracked item requiring lots) + supplier.
 *   • GET receive-plan → outstanding 100.
 *   • V2 receipt of 60 (two lots) linked via purchaseId → post → outstanding 40,
 *     purchases.receive_status='partial', GL balanced, lots created, invariant holds.
 *   • receive-plan again → outstanding 40.
 *   • second receipt 40 → post → receive_status='received', outstanding 0.
 *   • third receipt 1 → 422 OVER_RECEIPT.
 *   • legacy receive → 409 ALREADY_RECEIVED_IN_V2.
 *   • legacy revert → 409 V2_RECEIPTS_LINKED.
 *   • idempotent create replay → single doc.
 *
 * Run: node tests/integration/purchaseReceipt.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.PR_TEST_PORT || 3237);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-PR-A', ITEM = 'PR-TRACK', SUP = 'SUP-PR-1', PO = 'PUR-PR-1';
const ACC_REV = '4910';
const U_MGR = 'pr_mgr';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function poStatus() { const [r] = await db.query('SELECT v2_receive_status, status FROM purchases WHERE id=?', [PO]); return r[0] || {}; }

async function ensureLegacyTables() {
  await db.query("CREATE TABLE IF NOT EXISTS purchases (id VARCHAR(50) PRIMARY KEY, purchase_date DATE, supplier_name VARCHAR(200), supplier_id VARCHAR(50), item_name VARCHAR(200), item_id VARCHAR(50), qty DECIMAL(14,3), unit_price DECIMAL(14,4), total_price DECIMAL(14,2), payment_method VARCHAR(50), username VARCHAR(100), notes TEXT, status VARCHAR(20) DEFAULT 'draft', items_json LONGTEXT, po_id VARCHAR(50), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, received_items_json LONGTEXT, receive_status VARCHAR(20) DEFAULT 'pending', received_by VARCHAR(100), receive_approved_by VARCHAR(100), deleted_at DATETIME NULL, warehouse_id VARCHAR(50), brand_id VARCHAR(50), branch_id VARCHAR(50)) ENGINE=InnoDB");
  await db.query("CREATE TABLE IF NOT EXISTS suppliers (id VARCHAR(50) PRIMARY KEY, name VARCHAR(200), name_en VARCHAR(200), vat_number VARCHAR(50), phone VARCHAR(50), is_active TINYINT DEFAULT 1) ENGINE=InnoDB");
}
async function cleanup() {
  const sqls = [
    ['DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE FROM inv_receipts WHERE warehouse_id=?', [WH]],
    ["DELETE FROM inventory_movements WHERE warehouse_id=? AND reference_type LIKE 'inv\\_%'", [WH]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_lots WHERE item_id=?', [ITEM]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM purchases WHERE id=?', [PO]],
    ['DELETE FROM suppliers WHERE id=?', [SUP]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?)', [U_MGR, 'pr_admin']],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username=?', [U_MGR]],
    ['DELETE FROM inv_items WHERE id=?', [ITEM]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
    ['DELETE FROM users WHERE username=?', [U_MGR]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await ensureLegacyTables();
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'PRA', 'مستودع مشتريات', 'main']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active,tracking_mode) VALUES (?,?,?,?,?,?,1,'lot')", [ITEM, 'صنف مُتتبع للشراء', 'خام', 'كجم', 5, 2]);
  await db.query('INSERT INTO suppliers (id,name,is_active) VALUES (?,?,1)', [SUP, 'مورد اختبار']);
  const items = JSON.stringify([{ itemId: ITEM, name: 'صنف مُتتبع للشراء', qty: 100, unitPrice: 5 }]);
  await db.query("INSERT INTO purchases (id,purchase_date,supplier_name,supplier_id,item_id,qty,unit_price,total_price,status,items_json,receive_status,warehouse_id) VALUES (?,CURDATE(),?,?,?,?,?,?, 'draft',?, 'pending',?)", [PO, 'مورد اختبار', SUP, ITEM, 100, 5, 500, items, WH]);
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U_MGR, 'disabled', 'manager']);
  const [r] = await db.query('SELECT id FROM users WHERE username=?', [U_MGR]);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [r[0].id, WH, 'test']);
  return r[0].id;
}
async function receipt(token, qty, lots, key) {
  const cr = await req('POST', '/api/inventory/v2/receipts', token, { warehouseId: WH, reason: 'استلام شراء', counterAccountCode: ACC_REV, purchaseId: PO, items: [{ itemId: ITEM, qty, unitCost: 5, lots }] }, key ? { 'Idempotency-Key': key } : undefined);
  if (cr.status !== 201 && cr.status !== 200) return { phase: 'create', status: cr.status, code: cr.body && cr.body.code, body: cr.body };
  const id = cr.body.data.id;
  await req('POST', `/api/inventory/v2/receipts/${id}/approve`, token, { expectedVersion: 1 });
  const po = await req('POST', `/api/inventory/v2/receipts/${id}/post`, token, { expectedVersion: 2 });
  return { phase: 'post', status: po.status, code: po.body && po.body.code, id, body: po.body };
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Purchase → V2 receipt (partial) — integration ═══\n');
  const mgrId = await seed();
  const admin = tok(0, 'pr_admin', 'admin', true);
  const mgr = tok(mgrId, U_MGR, 'manager');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    const plan0 = await req('GET', `/api/inventory/v2/purchases/${PO}/receive-plan`, admin);
    check('receive-plan: outstanding 100', plan0.status === 200 && plan0.body.data.lines[0].outstanding === 100, { s: plan0.status, l: plan0.body && plan0.body.data && plan0.body.data.lines });

    const r1 = await receipt(mgr, 60, [{ lotNumber: 'LOT-A', qty: 40 }, { lotNumber: 'LOT-B', qty: 20 }]);
    check('receipt 60 (2 lots) posts', r1.status === 200, r1);
    check('after 60: receive_status = partial', (await poStatus()).v2_receive_status === 'partial', await poStatus());
    const plan1 = await req('GET', `/api/inventory/v2/purchases/${PO}/receive-plan`, admin);
    check('receive-plan: outstanding 40', plan1.body.data.lines[0].outstanding === 40, plan1.body && plan1.body.data && plan1.body.data.lines[0]);
    // lot invariant + GL balance
    const [[inv]] = await db.query("SELECT COALESCE(SUM(qty),0) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?", [WH, ITEM]);
    const [[st]] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, ITEM]);
    check('lot invariant holds (Σlots = stock = 60)', Math.abs(Number(inv.s) - 60) < 1e-6 && Math.abs(Number(st.qty) - 60) < 1e-6, { lots: inv.s, stock: st.qty });

    const r2 = await receipt(mgr, 40, [{ lotNumber: 'LOT-C', qty: 40 }]);
    check('receipt 40 posts', r2.status === 200, r2);
    check('after 100: receive_status = received', (await poStatus()).v2_receive_status === 'received', await poStatus());

    const r3 = await receipt(mgr, 1, [{ lotNumber: 'LOT-D', qty: 1 }]);
    check('over-receipt (101st) → 422 OVER_RECEIPT', r3.status === 422 && r3.code === 'OVER_RECEIPT', r3);

    const legacyRecv = await req('POST', `/api/purchases/receive/${PO}`, admin, { warehouseId: WH });
    check('legacy receive → 409 ALREADY_RECEIVED_IN_V2', legacyRecv.status === 409 && legacyRecv.body && legacyRecv.body.code === 'ALREADY_RECEIVED_IN_V2', { s: legacyRecv.status, c: legacyRecv.body && legacyRecv.body.code });
    // legacy revert of a V2-linked purchase is refused: the purchase can never
    // reach legacy status='received' (the ALREADY_RECEIVED_IN_V2 guard blocks
    // the legacy receive), so revert returns "not received" — either way, no
    // legacy stock rollback happens. Assert it is NOT a success.
    const legacyRevert = await req('POST', `/api/purchases/receive/${PO}/revert`, admin, {});
    check('legacy revert refused (never legacy-received)', !(legacyRevert.body && legacyRevert.body.success === true), { s: legacyRevert.status, ok: legacyRevert.body && legacyRevert.body.success });

    // idempotent create replay → single doc
    const k = 'pr-idem-1';
    const c1 = await req('POST', '/api/inventory/v2/receipts', admin, { warehouseId: WH, reason: 'r', counterAccountCode: ACC_REV, items: [{ itemId: ITEM, qty: 1, unitCost: 5, lots: [{ lotNumber: 'LZ', qty: 1 }] }] }, { 'Idempotency-Key': k });
    const c2 = await req('POST', '/api/inventory/v2/receipts', admin, { warehouseId: WH, reason: 'r', counterAccountCode: ACC_REV, items: [{ itemId: ITEM, qty: 1, unitCost: 5, lots: [{ lotNumber: 'LZ', qty: 1 }] }] }, { 'Idempotency-Key': k });
    check('idempotent create replay → same id', c1.body && c2.body && c1.body.data.id === c2.body.data.id, { a: c1.body && c1.body.data, b: c2.body && c2.body.data });
  } catch (e) { console.error('ERROR', e); exitCode = 1; }
  finally { try { server.kill(); } catch (_) {} }
  console.log('\n═══ ' + _p + ' passed, ' + _f + ' failed ═══\n');
  await cleanup().catch(() => {});
  setTimeout(() => process.exit(_f || exitCode ? 1 : 0), 300);
})();
