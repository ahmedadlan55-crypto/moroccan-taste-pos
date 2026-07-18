'use strict';
/*
 * Integration — close2/stocktake-pro-pos: the POS cashier now drives the v2
 * professional stocktake at /api/inventory/v2/stocktakes (routes/inventory-
 * stocktakes.js) after the count-entry gate was swapped from the BACKOFFICE
 * role-list to requireCapability('inventory.stocktake.create').
 *
 * What this proves (real server + real DB, ITEST- fixtures, full cleanup):
 *   (1) CASHIER GATE — a cashier CAN create/start/counts/submit (previously a
 *       403 under the old BACKOFFICE role-list) but STILL gets 403 on the
 *       manager-only transitions approve / request-recount / post / cancel /
 *       delete (separation of duties preserved).
 *   (2) TWO-WAREHOUSE ISOLATION — a cashier's WH-A count, once approved+posted,
 *       moves ONLY WH-A stock; WH-B's stock and an in-flight WH-B stocktake are
 *       byte-for-byte untouched, and the created adjustment carries WH-A.
 *   (3) CONCURRENCY — two near-simultaneous submits with the same expectedVersion
 *       resolve to exactly one 200 / one 409 VERSION_CONFLICT (optimistic lock,
 *       never a silent lost-update); a count PUT on the now-submitted doc also
 *       comes back 409 VERSION_CONFLICT instead of a silent stale write.
 *   (4) ROLLBACK — a forced failure inside the post transaction leaves stock and
 *       the document status completely unchanged (all-or-nothing), then a retry
 *       posts cleanly.
 *   (5) LEGACY UNTOUCHED — the legacy stocktakes/stocktake_items tables are not
 *       written by any of this.
 *
 * The g-inv.json capability seed is applied exactly as a deploy would, tracking
 * only the rows THIS run inserted so a production-seeded DB is left intact.
 *
 * Run: node tests/integration/stocktakePosCashier.api.test.js
 */
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const PORT = Number(process.env.STK_POS_PORT || 3238);
const BASE = { host: '127.0.0.1', port: PORT };
const S = '/api/inventory/v2/stocktakes';

const WH_A = 'ITEST-WH-STKA', WH_B = 'ITEST-WH-STKB';
const I_SHARED = 'ITEST-STK-SHARED';   // stocked in BOTH A and B (isolation proof)
const I_A2 = 'ITEST-STK-A2';           // WH-A only — rollback
const I_CC = 'ITEST-STK-CC';           // WH-A only — concurrency
const I_B1 = 'ITEST-STK-B1';           // WH-B only — in-flight B stocktake
const U_CASHIER = 'itest_stk_cashier';
const U_ADMIN = 'itest_stk_admin';
const PW = 'ItestStk#2026!';

let _p = 0, _f = 0; const fails = [];
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 240) : ''); }
}

function req(method, p, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path: p, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
const login = async (u) => (await req('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';

async function qty(wh, item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, item]); return r.length ? Number(r[0].qty) : null; }
async function legacyCounts() { const [a] = await db.query('SELECT COUNT(*) n FROM stocktakes'); const [b] = await db.query('SELECT COUNT(*) n FROM stocktake_items'); return { st: Number(a[0].n), sti: Number(b[0].n) }; }

// ── g-inv capability seed (apply as a deploy would; remove only OUR rows) ─────
const SEED_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', 'capability-seeds', 'g-inv.json');
const SEEDS = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const createdPerms = []; const createdGrants = [];
async function applySeeds() {
  for (const cap of SEEDS) {
    const [ex] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [cap.id]);
    if (!ex.length) {
      await db.query('INSERT INTO permissions_v3 (id, category, label_ar, label_en, is_sensitive) VALUES (?,?,?,?,?)',
        [cap.id, 'inventory', cap.label_ar, cap.label_en || '', cap.is_sensitive ? 1 : 0]);
      createdPerms.push(cap.id);
    }
    for (const role of cap.roles) {
      const [g] = await db.query('SELECT 1 FROM role_permissions WHERE role = ? AND permission_id = ?', [role, cap.id]);
      if (!g.length) { await db.query('INSERT INTO role_permissions (role, permission_id) VALUES (?,?)', [role, cap.id]); createdGrants.push([role, cap.id]); }
    }
  }
}
async function removeSeeds() {
  for (const [role, pid] of createdGrants) { try { await db.query('DELETE FROM role_permissions WHERE role = ? AND permission_id = ?', [role, pid]); } catch (_) {} }
  for (const pid of createdPerms) { try { await db.query('DELETE FROM permissions_v3 WHERE id = ?', [pid]); } catch (_) {} }
}

async function cleanup() {
  const WHS = [WH_A, WH_B];
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN inv_stocktakes d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", WHS],
    ["DELETE i FROM inv_stocktake_items i JOIN inv_stocktakes d ON d.id=i.stocktake_id WHERE d.warehouse_id IN (?,?)", WHS],
    ['DELETE FROM inv_stocktakes WHERE warehouse_id IN (?,?)', WHS],
    ["DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id IN (?,?)", WHS],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id IN (?,?)', WHS],
    ['DELETE FROM inv_adjustments WHERE warehouse_id IN (?,?)', WHS],
    ["DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)", WHS],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type LIKE 'inv\\_%' AND j.reference_id LIKE 'ADV-%'", []],
    ["DELETE FROM gl_journals WHERE reference_type LIKE 'inv\\_%' AND reference_id LIKE 'ADV-%'", []],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', WHS],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?)', [U_CASHIER, U_ADMIN]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?,?)', [I_SHARED, I_A2, I_CC, I_B1]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', WHS],
    ['DELETE FROM users WHERE username IN (?,?)', [U_CASHIER, U_ADMIN]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
  // safety: restore the rename-swap table if a prior crash left it renamed.
  try { const [t] = await db.query("SHOW TABLES LIKE 'inv_adjustment_items_bak'"); if (t.length) await db.query('RENAME TABLE inv_adjustment_items_bak TO inv_adjustment_items'); } catch (_) {}
}

async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH_A, 'ITSTKA', 'مستودع أ', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [WH_B, 'ITSTKB', 'مستودع ب', 'branch']);
  for (const it of [I_SHARED, I_A2, I_CC, I_B1]) {
    await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [it, 'صنف ' + it, 'خام', 'كجم', 5, 0]);
  }
  // stock rows: SHARED in BOTH warehouses at 100; the rest per-warehouse.
  const stock = [
    [WH_A, I_SHARED, 100], [WH_B, I_SHARED, 100],
    [WH_A, I_A2, 40], [WH_A, I_CC, 50], [WH_B, I_B1, 30],
  ];
  for (const [wh, it, q] of stock) {
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + wh + '-' + it, wh, it, q, 5]);
  }
  const hash = await bcrypt.hash(PW, 12);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_CASHIER, hash, 'cashier']);
  await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [U_ADMIN, hash, 'admin']);
  await applySeeds();
}

(async () => {
  console.log('\n═══ POS cashier → v2 stocktake (gate + isolation + concurrency + rollback) ═══\n');
  await seed();
  const legacyBefore = await legacyCounts();
  // ENFORCE=0 (isolate the CAPABILITY gate from warehouse-ACL); MAKER_CHECKER=0.
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0', STOCKTAKE_MAKER_CHECKER: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    const cashier = await login(U_CASHIER);
    const admin = await login(U_ADMIN);
    check('cashier + admin authenticate', !!cashier && !!admin);

    // ══ (1) CASHIER GATE — cashier CAN create/start/counts/submit ══════════════
    const c = await req('POST', S, cashier, { warehouseId: WH_A, scopeType: 'items', itemIds: [I_SHARED], includeZero: true, blindCount: true, reason: 'ITEST جرد كاشير' }, { 'Idempotency-Key': 'itest-stk-c1' });
    check('cashier CAN create v2 stocktake (was 403 under old BACKOFFICE gate)', c.status === 201 && c.body && c.body.status === 'draft', { status: c.status, body: c.body });
    const sid = c.body && c.body.id;
    const st = await req('POST', `${S}/${sid}/start`, cashier, { expectedVersion: 1 });
    check('cashier CAN start (draft → counting, 1 line frozen)', st.status === 200 && st.body.status === 'counting' && st.body.data && st.body.data.lines === 1, { status: st.status, body: st.body });
    const cnt = await req('PUT', `${S}/${sid}/counts`, cashier, { counts: [{ itemId: I_SHARED, countedQty: 90 }] });
    check('cashier CAN save counts (applied 1)', cnt.status === 200 && cnt.body && cnt.body.applied === 1, { status: cnt.status, body: cnt.body });
    const sub = await req('POST', `${S}/${sid}/submit`, cashier, { expectedVersion: 2 });
    check('cashier CAN submit (counting → submitted) — job ends here', sub.status === 200 && sub.body.status === 'submitted', { status: sub.status, body: sub.body });

    // ══ (1b) …but is DENIED every manager-only transition (separation of duties) ══
    const denyApprove = await req('POST', `${S}/${sid}/approve`, cashier, { expectedVersion: 3 });
    check('cashier DENIED approve → 403', denyApprove.status === 403, { status: denyApprove.status, body: denyApprove.body });
    const denyRecount = await req('POST', `${S}/${sid}/request-recount`, cashier, { reason: 'x', expectedVersion: 3 });
    check('cashier DENIED request-recount → 403', denyRecount.status === 403, { status: denyRecount.status });
    const denyPost = await req('POST', `${S}/${sid}/post`, cashier, {}, { 'Idempotency-Key': 'itest-stk-cashier-post' });
    check('cashier DENIED post → 403', denyPost.status === 403, { status: denyPost.status });
    const denyCancel = await req('POST', `${S}/${sid}/cancel`, cashier, { reason: 'x' });
    check('cashier DENIED cancel → 403', denyCancel.status === 403, { status: denyCancel.status });
    const denyDelete = await req('DELETE', `${S}/${sid}`, cashier);
    check('cashier DENIED delete → 403', denyDelete.status === 403, { status: denyDelete.status });
    const [afterDeny] = await db.query('SELECT status FROM inv_stocktakes WHERE id=?', [sid]);
    check('…and the document is STILL submitted (no cashier transition slipped through)', afterDeny.length === 1 && afterDeny[0].status === 'submitted', afterDeny[0]);

    // ══ (2) TWO-WAREHOUSE ISOLATION ════════════════════════════════════════════
    // an in-flight (counting) stocktake in WH-B that must stay untouched
    const cB = await req('POST', S, cashier, { warehouseId: WH_B, scopeType: 'items', itemIds: [I_B1], includeZero: true, blindCount: true, reason: 'ITEST جرد ب' }, { 'Idempotency-Key': 'itest-stk-b1' });
    const sidB = cB.body && cB.body.id;
    await req('POST', `${S}/${sidB}/start`, cashier, { expectedVersion: 1 });
    const [bLineBefore] = await db.query('SELECT snapshot_qty FROM inv_stocktake_items WHERE stocktake_id=?', [sidB]);
    const bSharedBefore = await qty(WH_B, I_SHARED);

    // admin approves + posts the WH-A count (variance -10 on the CURRENT balance).
    const ap = await req('POST', `${S}/${sid}/approve`, admin, { expectedVersion: 3 });
    check('admin approves the cashier count → approved', ap.status === 200 && ap.body.status === 'approved', { status: ap.status, body: ap.body });
    const po = await req('POST', `${S}/${sid}/post`, admin, { expectedVersion: 4 }, { 'Idempotency-Key': 'itest-stk-post-a' });
    check('admin posts → posted (variance applied)', po.status === 200 && po.body.status === 'posted' && !!po.body.data.adjustmentId, { status: po.status, body: po.body });
    check('ISOLATION: WH-A SHARED stock moved 100 → 90', (await qty(WH_A, I_SHARED)) === 90, { whA: await qty(WH_A, I_SHARED) });
    check('ISOLATION: WH-B SHARED stock UNCHANGED (100)', (await qty(WH_B, I_SHARED)) === bSharedBefore && bSharedBefore === 100, { whB: await qty(WH_B, I_SHARED), before: bSharedBefore });
    const [adjWh] = await db.query('SELECT warehouse_id FROM inv_adjustments WHERE id=?', [po.body.data.adjustmentId]);
    check('ISOLATION: the posted adjustment carries WH-A only', adjWh.length === 1 && adjWh[0].warehouse_id === WH_A, adjWh[0]);
    const [bAfter] = await db.query('SELECT status FROM inv_stocktakes WHERE id=?', [sidB]);
    const [bLineAfter] = await db.query('SELECT snapshot_qty FROM inv_stocktake_items WHERE stocktake_id=?', [sidB]);
    check('ISOLATION: the in-flight WH-B stocktake is untouched (still counting, snapshot intact)',
      bAfter[0].status === 'counting' && bLineBefore.length === 1 && bLineAfter.length === 1 && Number(bLineAfter[0].snapshot_qty) === Number(bLineBefore[0].snapshot_qty), { status: bAfter[0].status });

    // ══ (3) CONCURRENCY ════════════════════════════════════════════════════════
    const cc = await req('POST', S, cashier, { warehouseId: WH_A, scopeType: 'items', itemIds: [I_CC], includeZero: true, blindCount: true, reason: 'ITEST تزامن' }, { 'Idempotency-Key': 'itest-stk-cc' });
    const sidC = cc.body && cc.body.id;
    await req('POST', `${S}/${sidC}/start`, cashier, { expectedVersion: 1 });
    await req('PUT', `${S}/${sidC}/counts`, cashier, { counts: [{ itemId: I_CC, countedQty: 45 }] });
    const [s1, s2] = await Promise.all([
      req('POST', `${S}/${sidC}/submit`, cashier, { expectedVersion: 2 }),
      req('POST', `${S}/${sidC}/submit`, cashier, { expectedVersion: 2 }),
    ]);
    const wins = [s1, s2].filter((x) => x.status === 200).length;
    const conflicts = [s1, s2].filter((x) => x.status === 409 && x.body && x.body.code === 'VERSION_CONFLICT').length;
    check('CONCURRENCY: two simultaneous submits → exactly one 200 / one 409 VERSION_CONFLICT', wins === 1 && conflicts === 1, { s1: s1.status, s2: s2.status, c1: s1.body && s1.body.code, c2: s2.body && s2.body.code });
    // a count PUT on the now-submitted doc comes back as VERSION_CONFLICT, never a silent stale write
    const staleCount = await req('PUT', `${S}/${sidC}/counts`, cashier, { counts: [{ itemId: I_CC, countedQty: 5 }] });
    check('CONCURRENCY: counts on the submitted doc → 409 VERSION_CONFLICT (no silent lost-update)', staleCount.status === 409 && staleCount.body && staleCount.body.code === 'VERSION_CONFLICT', { status: staleCount.status, body: staleCount.body });
    const [ccLine] = await db.query('SELECT counted_qty FROM inv_stocktake_items WHERE stocktake_id=?', [sidC]);
    check('CONCURRENCY: the stale count did NOT overwrite the recorded quantity (still 45)', ccLine.length === 1 && Number(ccLine[0].counted_qty) === 45, ccLine[0]);

    // ══ (4) ROLLBACK on a forced failure inside the post transaction ═══════════
    const cr = await req('POST', S, cashier, { warehouseId: WH_A, scopeType: 'items', itemIds: [I_A2], includeZero: true, blindCount: true, reason: 'ITEST تراجع' }, { 'Idempotency-Key': 'itest-stk-rb' });
    const sidR = cr.body && cr.body.id;
    await req('POST', `${S}/${sidR}/start`, cashier, { expectedVersion: 1 });
    await req('PUT', `${S}/${sidR}/counts`, cashier, { counts: [{ itemId: I_A2, countedQty: 30 }] }); // snapshot 40 → variance -10
    await req('POST', `${S}/${sidR}/submit`, cashier, { expectedVersion: 2 });
    await req('POST', `${S}/${sidR}/approve`, admin, { expectedVersion: 3 });
    const rbBefore = await qty(WH_A, I_A2);
    await db.query('RENAME TABLE inv_adjustment_items TO inv_adjustment_items_bak'); // force the adjustment insert to fail
    const postFail = await req('POST', `${S}/${sidR}/post`, admin, {}, { 'Idempotency-Key': 'itest-stk-rb-fail' });
    await db.query('RENAME TABLE inv_adjustment_items_bak TO inv_adjustment_items');
    check('ROLLBACK: forced post failure → error + WH-A stock UNCHANGED (all-or-nothing)', postFail.status >= 400 && (await qty(WH_A, I_A2)) === rbBefore && rbBefore === 40, { status: postFail.status, before: rbBefore, after: await qty(WH_A, I_A2) });
    const [rbStatus] = await db.query('SELECT status FROM inv_stocktakes WHERE id=?', [sidR]);
    check('ROLLBACK: the document stayed APPROVED (no partial post)', rbStatus[0].status === 'approved', rbStatus[0]);
    const postOk = await req('POST', `${S}/${sidR}/post`, admin, {}, { 'Idempotency-Key': 'itest-stk-rb-ok' });
    check('ROLLBACK: a retry posts cleanly → WH-A stock 40 - 10 = 30', postOk.status === 200 && (await qty(WH_A, I_A2)) === 30, { status: postOk.status, after: await qty(WH_A, I_A2) });

    // ══ (5) LEGACY UNTOUCHED ═══════════════════════════════════════════════════
    const legacyAfter = await legacyCounts();
    check('LEGACY stocktakes/stocktake_items row counts UNCHANGED', legacyAfter.st === legacyBefore.st && legacyAfter.sti === legacyBefore.sti, { before: legacyBefore, after: legacyAfter });

  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e);
    try { await db.query('RENAME TABLE inv_adjustment_items_bak TO inv_adjustment_items'); } catch (_) {}
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    try { await removeSeeds(); } catch (_) {}
  }
  console.log(`\n  ${_p} passed, ${_f} failed`);
  if (fails.length) console.log('   failed:', fails.join(' | '));
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
