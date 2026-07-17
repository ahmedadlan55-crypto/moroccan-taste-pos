'use strict';
/* Integration — G-INV: capability guards + JWT-only actor on /api/inventory
 * and /api/stocktake-pro (real server + DB, synthesized ITEST- fixtures).
 *
 * What this proves:
 *   (a) A role with NO inventory-write capability (accountant) gets 403 on a
 *       stocktake create and the stocktakes table count is UNCHANGED; a role
 *       without manager-level caps (custody) is denied destructive/valuation
 *       routes (item delete, receive-approve) — the guard runs BEFORE any
 *       handler lookup. (Note: custody IS seeded inventory.stocktake.create —
 *       the legacy _CAP_MATRIX allowed custody counts — so the stocktake-403
 *       subject here is accountant — a real users.role ENUM member holding no inventory caps.)
 *   (b) The cashier POS flows KEEP WORKING through the g-inv capability seeds
 *       (db/migrations/capability-seeds/g-inv.json): a cashier creates a
 *       legacy POS stocktake, a stocktake-pro draft, and a shortage request —
 *       real success, rows written, then cleaned.
 *   (c) A spoofed body.username is IGNORED: the recorded actor on every
 *       document is the JWT user.
 *
 * The test applies the g-inv.json capability seed to permissions_v3 /
 * role_permissions exactly as a deploy would, tracking which rows IT created
 * and removing only those in cleanup (a production-seeded DB is untouched).
 *
 * Run: node tests/integration/inventoryAuthz.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = 3992;
const CASHIER = 'itest_ginv_cashier';
const AUDITOR = 'itest_ginv_accountant'; // users.role ENUM has no 'auditor' — accountant is a real role with no inventory caps
const CUSTODY = 'itest_ginv_custody';
const PW = 'GInv#Test!2026';
const WH = 'ITEST-WH-GINV';
const ITEM = 'ITEST-ITEM-GINV';
const SPOOF = 'itest_ginv_spoofed_ghost';

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) { if (c) { pass++; console.log('  ✅', n); } else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 220) : ''); } }

function call(method, p, token, body, headers = {}) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false))); if (ok) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

const stocktakeCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM stocktakes'); return Number(r[0].c); };
const shortageCount = async () => { const [r] = await db.query('SELECT COUNT(*) c FROM shortage_requests'); return Number(r[0].c); };

// ── capability seed fixtures (the g-inv.json proposal, applied as a deploy would) ──
const SEED_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', 'capability-seeds', 'g-inv.json');
const SEEDS = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const createdPerms = []; const createdGrants = [];
async function applySeeds() {
  for (const cap of SEEDS) {
    const [ex] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [cap.id]);
    if (!ex.length) {
      await db.query(
        'INSERT INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive) VALUES (?,?,?,?,?)',
        [cap.id, 'inventory', cap.label_ar, cap.label_en || '', cap.is_sensitive ? 1 : 0]);
      createdPerms.push(cap.id);
    }
    for (const role of cap.roles) {
      const [g] = await db.query('SELECT 1 FROM role_permissions WHERE role = ? AND permission_id = ?', [role, cap.id]);
      if (!g.length) {
        await db.query('INSERT INTO role_permissions (role, permission_id) VALUES (?,?)', [role, cap.id]);
        createdGrants.push([role, cap.id]);
      }
    }
  }
}
async function removeSeeds() {
  // Only rows THIS run inserted — an already-seeded (production) DB keeps its grants.
  for (const [role, pid] of createdGrants) { try { await db.query('DELETE FROM role_permissions WHERE role = ? AND permission_id = ?', [role, pid]); } catch (_) {} }
  for (const pid of createdPerms) { try { await db.query('DELETE FROM permissions_v3 WHERE id = ?', [pid]); } catch (_) {} }
}

async function cleanup() {
  for (const u of [CASHIER, AUDITOR, CUSTODY]) { try { await db.query('DELETE FROM users WHERE username = ?', [u]); } catch (_) {} }
  try {
    const [sts] = await db.query('SELECT id FROM stocktakes WHERE warehouse_id = ?', [WH]);
    for (const s of sts) { await db.query('DELETE FROM stocktake_items WHERE stocktake_id = ?', [s.id]).catch(() => {}); }
    await db.query('DELETE FROM stocktakes WHERE warehouse_id = ?', [WH]);
  } catch (_) {}
  try {
    const [shr] = await db.query('SELECT id FROM shortage_requests WHERE warehouse_id = ?', [WH]);
    for (const r of shr) { await db.query('DELETE FROM shortage_items WHERE request_id = ?', [r.id]).catch(() => {}); }
    await db.query('DELETE FROM shortage_requests WHERE warehouse_id = ?', [WH]);
  } catch (_) {}
  try { await db.query('DELETE FROM inventory_movements WHERE warehouse_id = ?', [WH]); } catch (_) {}
  try { await db.query('DELETE FROM warehouse_stock WHERE warehouse_id = ?', [WH]); } catch (_) {}
  try { await db.query('DELETE FROM inv_items WHERE id = ?', [ITEM]); } catch (_) {}
  try { await db.query('DELETE FROM warehouses WHERE id = ?', [WH]); } catch (_) {}
}

(async () => {
  await cleanup();
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [AUDITOR, hash, 'accountant']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [CUSTODY, hash, 'custody']);
  await db.query("INSERT INTO warehouses (id, name, code) VALUES (?, 'ITEST G-INV WH', 'ITGNV')", [WH]);
  await db.query("INSERT INTO inv_items (id, name, unit, cost, stock) VALUES (?, 'ITEST g-inv item', 'PCS', 10, 50)", [ITEM]);
  await db.query('INSERT INTO warehouse_stock (id, warehouse_id, item_id, qty) VALUES (?,?,?,50)', [`WS-${WH}-${ITEM}`, WH, ITEM]);
  await applySeeds();

  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    console.log('\n═══ G-INV inventory authz ═══');

    check('g-inv.json seed entries are well-formed ({id,label_ar,label_en,is_sensitive,roles})',
      Array.isArray(SEEDS) && SEEDS.length === 3 && SEEDS.every((c) => c.id && c.label_ar && typeof c.label_en === 'string' && Array.isArray(c.roles) && c.roles.length > 0));

    const cashier = await login(CASHIER);
    const auditor = await login(AUDITOR);
    const custody = await login(CUSTODY);
    check('users authenticate (cashier / accountant / custody)', !!cashier && !!auditor && !!custody);

    // zero-variance count lines → header + lines only, no stock/GL side-effects
    const stPayload = (extra = {}) => ({
      warehouseId: WH, notes: 'ITEST g-inv',
      items: [{ id: ITEM, sys: 50, actual: 50 }],
      ...extra,
    });

    // ── (a) unauthorized roles are DENIED, and nothing is written ──
    const noTok = await call('POST', '/api/inventory/stocktakes', null, stPayload());
    check('unauthenticated stocktake create is blocked (401/403)', noTok.status === 401 || noTok.status === 403, { status: noTok.status });

    const stBefore = await stocktakeCount();
    const denied = await call('POST', '/api/inventory/stocktakes', auditor, stPayload());
    check('accountant (no capability) gets 403 on POST /api/inventory/stocktakes', denied.status === 403 && denied.body && denied.body.code === 'PERMISSION_DENIED', { status: denied.status, body: denied.body });
    check('…and the stocktakes table count is UNCHANGED', (await stocktakeCount()) === stBefore, { before: stBefore, after: await stocktakeCount() });

    const deniedPro = await call('POST', '/api/stocktake-pro', auditor, { warehouseId: WH });
    check('auditor gets 403 on POST /api/stocktake-pro (create draft)', deniedPro.status === 403, { status: deniedPro.status });

    const shrBefore = await shortageCount();
    const deniedShr = await call('POST', '/api/inventory/shortage-requests', auditor, { warehouseId: WH, items: [{ invItemId: ITEM, invItemName: 'ITEST g-inv item', requestedQty: 5 }] });
    check('auditor gets 403 on POST /api/inventory/shortage-requests', deniedShr.status === 403, { status: deniedShr.status });
    check('…and the shortage_requests table count is UNCHANGED', (await shortageCount()) === shrBefore, { before: shrBefore, after: await shortageCount() });

    // manager-level (destructive / valuation) routes deny custody — the guard
    // fires BEFORE the handler even looks the document up.
    const delItem = await call('DELETE', '/api/inventory/items/' + ITEM, custody);
    check('custody gets 403 on DELETE /api/inventory/items/:id (inventory.edit)', delItem.status === 403, { status: delItem.status });
    const [itemStill] = await db.query('SELECT id FROM inv_items WHERE id = ? AND deleted_at IS NULL', [ITEM]);
    check('…and the item was NOT (soft-)deleted', itemStill.length === 1);
    const rcvApprove = await call('POST', '/api/inventory/receive-approve/NO-SUCH-ID', custody, {});
    // Under PROCUREMENT_P2P_ENABLE=1 the mount-level legacy gate answers 409
    // V2_RECEIPTS_LINKED before the route's capability guard can 403 — EVERYONE
    // is pushed to the unified procurement module (which has its own RBAC).
    // Either answer proves custody cannot approve a receipt here; flag-off
    // deployments exercise the 403 branch.
    const rcvDenied = rcvApprove.status === 403
      || (rcvApprove.status === 409 && rcvApprove.body && rcvApprove.body.code === 'V2_RECEIPTS_LINKED');
    check('custody CANNOT reach receive-approve (403 cap-guard, or 409 procurement gate)', rcvDenied, { status: rcvApprove.status, body: rcvApprove.body });
    const adjDenied = await call('POST', '/api/inventory/adjustments', cashier, { warehouseId: WH, items: [{ id: ITEM, qty: 1 }], reason: 'damaged' });
    check('cashier gets 403 on POST /api/inventory/adjustments (not in inventory.adjustment.create)', adjDenied.status === 403, { status: adjDenied.status });

    // ── (b) + (c) the cashier POS flows still work; spoofed body.username is ignored ──
    const stOk = await call('POST', '/api/inventory/stocktakes', cashier, stPayload({ username: SPOOF }));
    check('cashier CAN create a POS stocktake (real success)', stOk.status === 200 && stOk.body && stOk.body.success === true && !!stOk.body.stocktakeId, { status: stOk.status, body: stOk.body });
    if (stOk.body && stOk.body.stocktakeId) {
      const [hdr] = await db.query('SELECT username, warehouse_id, items_count FROM stocktakes WHERE id = ?', [stOk.body.stocktakeId]);
      check('…the stocktake row was really written (warehouse + counted line)', hdr.length === 1 && hdr[0].warehouse_id === WH && Number(hdr[0].items_count) === 1, hdr[0]);
      check('…spoofed body.username is IGNORED — recorded actor is the JWT user', hdr.length === 1 && hdr[0].username === CASHIER, hdr[0]);
      const [lines] = await db.query('SELECT COUNT(*) c FROM stocktake_items WHERE stocktake_id = ?', [stOk.body.stocktakeId]);
      check('…its stocktake_items line exists', Number(lines[0].c) === 1);
    }

    const proOk = await call('POST', '/api/stocktake-pro', cashier, { warehouseId: WH, username: SPOOF, notes: 'ITEST g-inv pro' });
    check('cashier CAN create a stocktake-pro draft', proOk.status === 200 && proOk.body && proOk.body.success === true && !!proOk.body.id, { status: proOk.status, body: proOk.body });
    if (proOk.body && proOk.body.id) {
      const [pro] = await db.query('SELECT username, workflow_status FROM stocktakes WHERE id = ?', [proOk.body.id]);
      check('…draft written with workflow_status=draft and the JWT actor (spoof ignored)',
        pro.length === 1 && pro[0].workflow_status === 'draft' && pro[0].username === CASHIER, pro[0]);
    }

    const shrOk = await call('POST', '/api/inventory/shortage-requests', cashier, {
      warehouseId: WH, username: SPOOF, notes: 'ITEST g-inv shortage',
      items: [{ invItemId: ITEM, invItemName: 'ITEST g-inv item', unit: 'PCS', currentQty: 1, minQty: 5, requestedQty: 10, unitPrice: 2 }],
    });
    check('cashier CAN create a shortage request (real success)', shrOk.status === 200 && shrOk.body && shrOk.body.success === true && !!shrOk.body.id, { status: shrOk.status, body: shrOk.body });
    if (shrOk.body && shrOk.body.id) {
      const [row] = await db.query('SELECT username, warehouse_id, total_items FROM shortage_requests WHERE id = ?', [shrOk.body.id]);
      check('…the shortage row was really written', row.length === 1 && row[0].warehouse_id === WH && Number(row[0].total_items) === 1, row[0]);
      check('…spoofed body.username is IGNORED on the shortage request too', row.length === 1 && row[0].username === CASHIER, row[0]);
      const [sit] = await db.query('SELECT COUNT(*) c FROM shortage_items WHERE request_id = ?', [shrOk.body.id]);
      check('…its shortage_items line exists', Number(sit[0].c) === 1);
      // cashier may EDIT the pending request (inventory.requisition.create)…
      const edit = await call('PUT', '/api/inventory/shortage-requests/' + shrOk.body.id, cashier, {
        notes: 'ITEST g-inv edited',
        items: [{ invItemId: ITEM, invItemName: 'ITEST g-inv item', unit: 'PCS', currentQty: 1, minQty: 5, requestedQty: 7, unitPrice: 2 }],
      });
      check('cashier CAN edit their pending shortage request', edit.status === 200 && edit.body && edit.body.success === true, { status: edit.status, body: edit.body });
      // …but NOT approve it (purchasing.requisitions.approve is manager-level).
      const app = await call('POST', '/api/inventory/shortage-requests/' + shrOk.body.id + '/approve', cashier, {});
      check('cashier gets 403 on shortage-request APPROVE (manager capability)', app.status === 403, { status: app.status });
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} inventoryAuthz: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    await removeSeeds();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
