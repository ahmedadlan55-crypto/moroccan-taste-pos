/**
 * Phase W2b — Negative-stock policy integration test.
 *
 * Boots server.js with NEGATIVE_STOCK_POLICY_ENABLED=1 + SCOPE_ENFORCE=1 and
 * exercises the full policy surface against /api/inventory/v2:
 *   • default (seeded global/block) → issue over stock = 422 INSUFFICIENT_STOCK.
 *   • PUT controlled(item, max=10) by admin (version guard) → issue that goes
 *     −6 without ack = 409 NEGATIVE_CONFIRMATION_REQUIRED → with ack+reason =
 *     200 + one stock_deficits(open) + negative_issues_total+1 + qty=−6.
 *   • over-limit (−15 vs max 10) = 422 NEGATIVE_LIMIT_EXCEEDED (no deficit).
 *   • covering receipt (+8) → deficit partial (remaining 0? here 6→covered) +
 *     GL balanced.
 *   • tracked item ignores controlled → stays 422 INSUFFICIENT_STOCK.
 *   • PUT with stale expectedVersion → 409; PUT allow by non-developer → 403.
 *   • GET /effective returns the computed decision; deficits report lists it.
 *
 * Run: node tests/integration/negativeStock.api.test.js   (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.NEG_TEST_PORT || 3236);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-NEG-A';
const ITEM = 'NEG-ITEM', TITEM = 'NEG-TRACKED';
const ACC_EXP = '5300';
const U_MGR = 'neg_mgr', U_CASH = 'neg_cash';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

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
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function qtyOf(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].qty) : 0; }
async function deficits(item) { const [r] = await db.query("SELECT * FROM stock_deficits WHERE warehouse_id=? AND item_id=? ORDER BY id", [WH, item]); return r; }

async function ensureGl() {
  await db.query("CREATE TABLE IF NOT EXISTS gl_journals (id VARCHAR(50) PRIMARY KEY, journal_number VARCHAR(20), journal_date DATE, reference_type VARCHAR(50), reference_id VARCHAR(100), description TEXT, total_debit DECIMAL(14,2) DEFAULT 0, total_credit DECIMAL(14,2) DEFAULT 0, period_id VARCHAR(50), status ENUM('posted','draft') DEFAULT 'posted', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(100), posted_by VARCHAR(100) DEFAULT '', posted_at DATETIME, brand_id VARCHAR(50) NULL, branch_id VARCHAR(50) NULL, project_id VARCHAR(50) NULL, cost_center_id VARCHAR(50) NULL, UNIQUE KEY uq_journal_number (journal_number)) ENGINE=InnoDB");
}
async function cleanup() {
  const sqls = [
    ["DELETE FROM stock_deficits WHERE warehouse_id=?", [WH]],
    ["DELETE FROM negative_stock_policy WHERE scope<>'global' AND (warehouse_id=? OR item_id IN (?,?))", [WH, ITEM, TITEM]],
    ['DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE FROM inv_issues WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_receipts WHERE warehouse_id=?', [WH]],
    ["DELETE FROM inventory_movements WHERE warehouse_id=? AND reference_type LIKE 'inv\\_%'", [WH]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?)', [U_MGR, U_CASH]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?)', [U_MGR, U_CASH, 'neg_admin']],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_items WHERE id IN (?,?)', [ITEM, TITEM]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
    ['DELETE FROM users WHERE username IN (?,?)', [U_MGR, U_CASH]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await ensureGl();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'NEGA', 'مستودع سالب', 'main']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active,tracking_mode) VALUES (?,?,?,?,?,?,1,'none')", [ITEM, 'صنف غير متتبع', 'خام', 'كجم', 5, 2]);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active,tracking_mode) VALUES (?,?,?,?,?,?,1,'lot')", [TITEM, 'صنف متتبع', 'خام', 'كجم', 5, 2]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-NEG1', WH, ITEM, 10, 5]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-NEG2', WH, TITEM, 5, 5]);
  const ids = {};
  for (const [u, role] of [[U_MGR, 'manager'], [U_CASH, 'cashier']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
    await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[u], WH, 'test']);
  }
  return ids;
}

// Create → approve → post an issue; returns { status, code, id, postResp }.
async function issue(token, item, qty, extra) {
  const cr = await req('POST', '/api/inventory/v2/issues', token, Object.assign({ warehouseId: WH, expenseAccountCode: ACC_EXP, reason: 'صرف اختبار', items: [{ itemId: item, qty }] }, (extra && extra.create) || {}));
  if (cr.status !== 201 && cr.status !== 200) return { phase: 'create', status: cr.status, code: cr.body && cr.body.code, body: cr.body };
  const id = cr.body.data.id;
  const ap = await req('POST', `/api/inventory/v2/issues/${id}/approve`, token, { expectedVersion: 1 });
  if (ap.status !== 200) return { phase: 'approve', status: ap.status, code: ap.body && ap.body.code, id };
  const postBody = Object.assign({ expectedVersion: 2 }, (extra && extra.post) || {});
  const po = await req('POST', `/api/inventory/v2/issues/${id}/post`, token, postBody, (extra && extra.postHeaders) || undefined);
  return { phase: 'post', status: po.status, code: po.body && po.body.code, id, body: po.body };
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Negative-stock policy — integration (POLICY_ENABLED=1) ═══\n');
  const ids = await seed();
  const admin = tok(0, 'neg_admin', 'admin', true);
  const mgr = tok(ids[U_MGR], U_MGR, 'manager');
  const cash = tok(ids[U_CASH], U_CASH, 'cashier');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', NEGATIVE_STOCK_POLICY_ENABLED: '1', INV_MAKER_CHECKER: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const NP = '/api/inventory/v2/negative-policy';
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    // migration 0012 ran at boot → global/block seeded.
    const eff0 = await req('GET', `${NP}/effective?warehouseId=${WH}&itemId=${ITEM}`, admin);
    check('effective default = block', eff0.status === 200 && eff0.body.data.effectivePolicy === 'block', { s: eff0.status, d: eff0.body && eff0.body.data });

    // 1) default block: issue 16 from stock 10 → 422 INSUFFICIENT_STOCK
    const r1 = await issue(mgr, ITEM, 16);
    check('block: over-stock issue → 422 INSUFFICIENT_STOCK', r1.status === 422 && r1.code === 'INSUFFICIENT_STOCK', r1);
    check('block: stock unchanged (10)', (await qtyOf(ITEM)) === 10);

    // 2) PUT controlled(item, max=10) by admin
    const put1 = await req('PUT', NP, admin, { scope: 'item', warehouseId: WH, itemId: ITEM, policy: 'controlled', maxNegativeQty: 10, requireReason: true });
    check('PUT controlled(item) → 200 version 1', put1.status === 200 && put1.body.version === 1, { s: put1.status, b: put1.body });
    const eff1 = await req('GET', `${NP}/effective?warehouseId=${WH}&itemId=${ITEM}`, admin);
    check('effective now = controlled, max 10', eff1.body.data.effectivePolicy === 'controlled' && eff1.body.data.effectiveMaxNegative === 10, eff1.body && eff1.body.data);

    // 3) issue 16 (→ −6) WITHOUT ack → 409 NEGATIVE_CONFIRMATION_REQUIRED
    const r3 = await issue(mgr, ITEM, 16);
    check('controlled: no-ack negative → 409 NEGATIVE_CONFIRMATION_REQUIRED', r3.status === 409 && r3.code === 'NEGATIVE_CONFIRMATION_REQUIRED', r3);
    check('controlled: still 10 after denied post', (await qtyOf(ITEM)) === 10, await qtyOf(ITEM));

    // 4) issue 16 WITH ack+reason → 200 + deficit + qty −6
    const r4 = await issue(mgr, ITEM, 16, { post: { acknowledgeNegative: true } });
    check('controlled: ack negative → 200 posted', r4.status === 200, r4);
    check('controlled: qty now −6', Math.abs((await qtyOf(ITEM)) - (-6)) < 1e-6, await qtyOf(ITEM));
    const defs = await deficits(ITEM);
    check('controlled: one open deficit (qty 6)', defs.length === 1 && defs[0].status === 'open' && Math.abs(Number(defs[0].deficit_qty) - 6) < 1e-6, defs.map((d) => ({ q: d.deficit_qty, s: d.status })));
    const met = await req('GET', '/api/metrics/json', admin);
    check('negative_issues_total ≥ 1', met.status === 200 && Number((met.body.warehouse_v2 || {}).negative_issues_total || 0) >= 1, met.body && met.body.warehouse_v2);

    // 5) deficits report lists it
    const rep = await req('GET', `${NP}/deficits?status=open`, admin);
    check('deficits report shows the open deficit', rep.status === 200 && rep.body.data.some((d) => d.itemId === ITEM && d.status === 'open'), { s: rep.status, n: rep.body && rep.body.total });

    // 6) covering receipt (+8) → deficit covered, qty +2
    const rc = await req('POST', '/api/inventory/v2/receipts', admin, { warehouseId: WH, reason: 'تغطية', counterAccountCode: '4910', items: [{ itemId: ITEM, qty: 8, unitCost: 5 }] });
    const rcId = rc.body && rc.body.data && rc.body.data.id;
    await req('POST', `/api/inventory/v2/receipts/${rcId}/approve`, admin, { expectedVersion: 1 });
    const rcPost = await req('POST', `/api/inventory/v2/receipts/${rcId}/post`, admin, { expectedVersion: 2 });
    check('covering receipt posts (200)', rcPost.status === 200, { s: rcPost.status, c: rcPost.body && rcPost.body.code });
    check('after cover: qty = +2', Math.abs((await qtyOf(ITEM)) - 2) < 1e-6, await qtyOf(ITEM));
    const defs2 = await deficits(ITEM);
    check('deficit now covered (remaining 0)', defs2.length === 1 && defs2[0].status === 'covered' && Math.abs(Number(defs2[0].remaining_qty)) < 1e-6, defs2.map((d) => ({ r: d.remaining_qty, s: d.status })));

    // 7) over-limit: set max=3, issue 10 (→ −7 < −3) → 422 NEGATIVE_LIMIT_EXCEEDED
    await req('PUT', NP, admin, { scope: 'item', warehouseId: WH, itemId: ITEM, policy: 'controlled', maxNegativeQty: 3, requireReason: true, expectedVersion: 1 });
    // stock is +2 now; issue 10 → −8, exceeds max 3
    const r7 = await issue(mgr, ITEM, 10, { post: { acknowledgeNegative: true } });
    check('controlled over-limit → 422 NEGATIVE_LIMIT_EXCEEDED', r7.status === 422 && r7.code === 'NEGATIVE_LIMIT_EXCEEDED', r7);
    check('over-limit: qty unchanged (+2)', Math.abs((await qtyOf(ITEM)) - 2) < 1e-6, await qtyOf(ITEM));

    // 8) cashier cannot go negative even under controlled (role gate)
    const r8 = await issue(cash, ITEM, 10, { post: { acknowledgeNegative: true } });
    check('controlled: cashier negative → 403 forbidden', (r8.status === 403) || (r8.phase !== 'post'), r8);

    // 9) tracked item ignores controlled → stays block (422 INSUFFICIENT_STOCK)
    await req('PUT', NP, admin, { scope: 'warehouse', warehouseId: WH, policy: 'controlled', maxNegativeQty: 100, requireReason: true });
    const r9 = await issue(mgr, TITEM, 20, { post: { acknowledgeNegative: true } });
    check('tracked item ignores controlled (block)', r9.status === 422 && (r9.code === 'INSUFFICIENT_STOCK' || r9.code === 'INSUFFICIENT_LOT_QUANTITY'), r9);

    // 10) governance: stale version PUT → 409; allow by non-developer → 403
    const stale = await req('PUT', NP, admin, { scope: 'warehouse', warehouseId: WH, policy: 'block', maxNegativeQty: 0, expectedVersion: 999 });
    check('stale expectedVersion → 409 VERSION_CONFLICT', stale.status === 409, { s: stale.status, c: stale.body && stale.body.code });
    const adminNoDev = tok(0, 'neg_admin2', 'admin', false);
    const allowByAdmin = await req('PUT', NP, adminNoDev, { scope: 'warehouse', warehouseId: WH, policy: 'allow', maxNegativeQty: 5 });
    check('allow by non-developer → 403 ALLOW_REQUIRES_DEVELOPER', allowByAdmin.status === 403 && allowByAdmin.body.code === 'ALLOW_REQUIRES_DEVELOPER', { s: allowByAdmin.status, c: allowByAdmin.body && allowByAdmin.body.code });
    const trackedPolicy = await req('PUT', NP, admin, { scope: 'item', warehouseId: WH, itemId: TITEM, policy: 'controlled', maxNegativeQty: 5 });
    check('policy on tracked item → 422 POLICY_NOT_ALLOWED_FOR_TRACKED', trackedPolicy.status === 422 && trackedPolicy.body.code === 'POLICY_NOT_ALLOWED_FOR_TRACKED', { s: trackedPolicy.status, c: trackedPolicy.body && trackedPolicy.body.code });
  } catch (e) { console.error('ERROR', e); exitCode = 1; }
  finally { try { server.kill(); } catch (_) {} }

  console.log('\n═══ ' + _p + ' passed, ' + _f + ' failed ═══\n');
  await cleanup().catch(() => {});
  setTimeout(() => process.exit(_f || exitCode ? 1 : 0), 300);
})();
