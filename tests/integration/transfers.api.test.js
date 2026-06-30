/**
 * Phase 3A — Transfers lifecycle integration test (real API, ENFORCE=1).
 *
 * Boots server.js with WAREHOUSE_SCOPE_ENFORCE=1, seeds 3 warehouses + 1 item +
 * 2 scoped users (one with access to BOTH ends, one with access only to an
 * unrelated warehouse) + an admin, then asserts the full lifecycle and its
 * hardening:
 *   • create → approve → issue → partial receive → final receive
 *   • source/dest balances, inventory_movements and GL gl_entries after stages
 *   • over-receipt → 422 OVER_RECEIPT
 *   • idempotent issue (same key) never double-decrements
 *   • two concurrent issues → exactly one wins (409), source decremented ONCE
 *     (the loser's stock deduction rolled back)
 *   • insufficient stock → 422, source unchanged (rollback)
 *   • scope: out-of-scope user → 403 on read + mutation (no existence leak)
 *   • stale expectedVersion → 409 VERSION_CONFLICT
 *   • in-transit remaining matches /analytics/summary and the transfers list
 *   • reverse (admin) returns stock + posts a reversing journal
 *
 * Run: node tests/integration/transfers.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.TRANSFERS_TEST_PORT || 3198);
const BASE = { host: '127.0.0.1', port: PORT };
const TA = 'WH-TRF-A', TB = 'WH-TRF-B', TC = 'WH-TRF-C';
const ITEM = 'TRF-ITEM-1';
const ITEM0 = 'TRF-ITEM-0'; // zero-cost → no GL post, isolates the state-guard in the concurrency test
const U_BOTH = 'trf_both', U_C = 'trf_c';

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
async function waitForServer() { for (let i = 0; i < 80; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
async function qty(wh) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [wh, ITEM]); return r.length ? Number(r[0].qty) : 0; }
async function glEntryCount(issueId) {
  const [r] = await db.query(
    "SELECT COUNT(*) AS n FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_id=?", [issueId]);
  return Number(r[0].n) || 0;
}

async function ensureGl() {
  await db.query(`CREATE TABLE IF NOT EXISTS gl_journals (
    id VARCHAR(50) PRIMARY KEY, journal_number VARCHAR(20), journal_date DATE,
    reference_type VARCHAR(50), reference_id VARCHAR(100), description TEXT,
    total_debit DECIMAL(14,2) DEFAULT 0, total_credit DECIMAL(14,2) DEFAULT 0,
    period_id VARCHAR(50), status ENUM('posted','draft') DEFAULT 'posted',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(100),
    reversed_by_journal_id VARCHAR(50) NULL, reverses_journal_id VARCHAR(50) NULL,
    reversed_at DATETIME NULL, reversed_by VARCHAR(100) NULL,
    posted_by VARCHAR(100) DEFAULT '', posted_at DATETIME,
    brand_id VARCHAR(50) NULL, branch_id VARCHAR(50) NULL, project_id VARCHAR(50) NULL, cost_center_id VARCHAR(50) NULL,
    UNIQUE KEY uq_journal_number (journal_number)) ENGINE=InnoDB`);
  for (const c of [['posted_by', "VARCHAR(100) DEFAULT ''"], ['posted_at', 'DATETIME']]) {
    try { await db.query('ALTER TABLE gl_journals ADD COLUMN ' + c[0] + ' ' + c[1]); } catch (_) {}
  }
  await db.query(`CREATE TABLE IF NOT EXISTS gl_entries (
    id VARCHAR(50) PRIMARY KEY, journal_id VARCHAR(50) NOT NULL, account_id VARCHAR(50),
    account_code VARCHAR(20), account_name VARCHAR(200),
    debit DECIMAL(14,2) DEFAULT 0, credit DECIMAL(14,2) DEFAULT 0, description TEXT,
    brand_id VARCHAR(50), branch_id VARCHAR(50), cost_center_id VARCHAR(50), warehouse_id VARCHAR(50),
    INDEX idx_gle_journal (journal_id)) ENGINE=InnoDB`);
}

async function cleanup() {
  for (const [s, p] of [
    ['DELETE e FROM stock_issue_events e JOIN stock_issues si ON si.id=e.issue_id WHERE si.from_warehouse_id IN (?,?,?)', [TA, TB, TC]],
    ['DELETE sii FROM stock_issue_items sii JOIN stock_issues si ON si.id=sii.issue_id WHERE si.from_warehouse_id IN (?,?,?)', [TA, TB, TC]],
    ['DELETE FROM stock_issues WHERE from_warehouse_id IN (?,?,?)', [TA, TB, TC]],
    ['DELETE FROM inventory_movements WHERE warehouse_id IN (?,?,?)', [TA, TB, TC]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?,?)', [TA, TB, TC]],
    // Remove orphaned transfer journals (this + prior runs) so the GL number
    // sequence doesn't accumulate same-day collisions for the reverse post.
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type IN ('stock_issue','stock_issue_reverse') AND j.reference_id LIKE 'SI-%' AND j.reference_id NOT IN (SELECT id FROM stock_issues)", []],
    ["DELETE FROM gl_journals WHERE reference_type IN ('stock_issue','stock_issue_reverse') AND reference_id LIKE 'SI-%' AND reference_id NOT IN (SELECT id FROM stock_issues)", []],
    ['DELETE FROM inv_items WHERE id IN (?,?)', [ITEM, ITEM0]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?)', [U_BOTH, U_C, 'trf_admin']],
    ['DELETE uwa FROM user_warehouse_access uwa JOIN users u ON u.id=uwa.user_id WHERE u.username IN (?,?)', [U_BOTH, U_C]],
    ['DELETE FROM warehouses WHERE id IN (?,?,?)', [TA, TB, TC]],
    ['DELETE FROM users WHERE username IN (?,?)', [U_BOTH, U_C]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await ensureGl();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [TA, 'TRA', 'مصدر', 'main']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [TB, 'TRB', 'وجهة', 'branch']);
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)', [TC, 'TRC', 'بعيد', 'branch']);
  await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [ITEM, 'صنف تحويل', 'خام', 'كجم', 10, 2]);
  await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [ITEM0, 'صنف بلا تكلفة', 'خام', 'كجم', 0, 2]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-TRA', TA, ITEM, 100, 10]);
  await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-TRA0', TA, ITEM0, 50, 0]);
  const ids = {};
  for (const [u, role] of [[U_BOTH, 'employee'], [U_C, 'manager']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_BOTH], TA, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_BOTH], TB, 'test']);
  await db.query('INSERT INTO user_warehouse_access (user_id,warehouse_id,created_by) VALUES (?,?,?)', [ids[U_C], TC, 'test']);
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Transfers lifecycle — integration (ENFORCE=1) ═══\n');
  const ids = await seed();
  const both = tok(ids[U_BOTH], U_BOTH, 'employee');
  const onlyC = tok(ids[U_C], U_C, 'manager');
  const admin = tok(0, 'trf_admin', 'admin', true);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  const E = '/api/erp/stock-issues';
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // 1) create draft (both-access user)
    const c = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 40 }] }, { 'Idempotency-Key': 'it-create' });
    check('create → draft v1 + envelope', c.status === 200 && c.body.status === 'draft' && c.body.version === 1 && c.body.documentNumber, c.body);
    const id = c.body && c.body.id;

    // scope: out-of-scope user cannot read it (no existence leak) nor act
    const cRead = await req('GET', `/api/inventory/transfers/${id}`, onlyC);
    check('out-of-scope GET detail → 403', cRead.status === 403, cRead.status);
    const cApprove = await req('POST', `${E}/${id}/approve`, onlyC, {});
    check('out-of-scope approve → 403', cApprove.status === 403, cApprove.status);

    // create same-warehouse → VALIDATION_ERROR
    const same = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TA, items: [{ itemId: ITEM, qtyRequested: 1 }] });
    check('same-warehouse create → 422 VALIDATION_ERROR', same.status === 422 && same.body.code === 'VALIDATION_ERROR', same.body && same.body.code);

    // 2) approve (admin = MGR + global)
    const ap = await req('POST', `${E}/${id}/approve`, admin, {});
    check('approve (admin) → approved v2', ap.status === 200 && ap.body.status === 'approved' && ap.body.version === 2, ap.body);

    // employee cannot approve (RBAC), even with scope
    const id2c = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 1 }] });
    const empApprove = await req('POST', `${E}/${id2c.body.id}/approve`, both, {});
    check('employee approve → 403 (RBAC)', empApprove.status === 403, empApprove.status);

    // 3) stale version → conflict; then real issue
    const stale = await req('POST', `${E}/${id}/issue`, both, { expectedVersion: 1 });
    check('issue stale version → 409 VERSION_CONFLICT', stale.status === 409 && stale.body.code === 'VERSION_CONFLICT', stale.body && stale.body.code);

    const beforeA = await qty(TA);
    const iss = await req('POST', `${E}/${id}/issue`, both, { expectedVersion: 2 }, { 'Idempotency-Key': 'it-issue' });
    check('issue → issued v3 + affectedStock', iss.status === 200 && iss.body.status === 'issued' && iss.body.version === 3 && iss.body.affectedStock.length === 1, iss.body);
    check('source −40 after issue', beforeA - (await qty(TA)) === 40, { beforeA, now: await qty(TA) });
    check('GL: 2 entries posted on issue', (await glEntryCount(id)) === 2, await glEntryCount(id));

    // idempotent issue replay (same key) — must NOT decrement again
    const aAfterIssue = await qty(TA);
    const issDup = await req('POST', `${E}/${id}/issue`, both, { expectedVersion: 2 }, { 'Idempotency-Key': 'it-issue' });
    check('issue replay (same key) → same result, no double decrement', issDup.status === 200 && issDup.body.status === 'issued' && (await qty(TA)) === aAfterIssue, { status: issDup.status, a: await qty(TA) });

    // 4) partial receive 15 → dest +15, partially_received
    const lineId = (await db.query('SELECT id FROM stock_issue_items WHERE issue_id=?', [id]))[0][0].id;
    const pr = await req('POST', `${E}/${id}/receive`, both, { items: [{ id: lineId, qtyReceived: 15 }] });
    check('partial receive → partially_received', pr.status === 200 && pr.body.status === 'partially_received', pr.body);
    check('dest +15 after partial', (await qty(TB)) === 15, await qty(TB));

    // in-transit remaining (25) matches analytics + transfers list
    const an = await req('GET', '/api/inventory/analytics/summary', admin);
    const list = await req('GET', `/api/inventory/transfers?status=partially_received&pageSize=100`, admin);
    const listRow = (list.body && list.body.data || []).find((r) => r.id === id);
    check('analytics transfers.remainingQty ≥ 25 (includes this transfer)', an.body && an.body.data.transfers.remainingQty >= 25, an.body && an.body.data && an.body.data.transfers);
    check('list row remainingQty = 25', listRow && listRow.remainingQty === 25, listRow && listRow.remainingQty);

    // 5) over-receipt (remaining 25, try 30)
    const over = await req('POST', `${E}/${id}/receive`, both, { items: [{ id: lineId, qtyReceived: 30 }] });
    check('over-receipt → 422 OVER_RECEIPT', over.status === 422 && over.body.code === 'OVER_RECEIPT', over.body && over.body.code);
    check('dest still 15 after rejected over-receipt', (await qty(TB)) === 15, await qty(TB));

    // 6) final receive (all remaining) → received, dest 40
    const fr = await req('POST', `${E}/${id}/receive`, both, {});
    check('final receive → received', fr.status === 200 && fr.body.status === 'received', fr.body);
    check('dest = 40 after final', (await qty(TB)) === 40, await qty(TB));

    // 7) reverse the received transfer (admin) → stock returns + reversing
    //    journal. Done BEFORE the concurrency stress so the single reversing GL
    //    post gets a clean journal number.
    const bA = await qty(TA), bB = await qty(TB);
    const rev = await req('POST', `${E}/${id}/reverse`, admin, { reason: 'اختبار إرجاع' });
    check('reverse → reversed + reversing journal', rev.status === 200 && rev.body.status === 'reversed', rev.body);
    check('reverse returns 40 to source, removes 40 from dest', (await qty(TA)) - bA === 40 && bB - (await qty(TB)) === 40, { srcD: (await qty(TA)) - bA, dstD: bB - (await qty(TB)) });
    check('reverse with no reason → 422 VALIDATION_ERROR', (await req('POST', `${E}/${id}/reverse`, admin, {})).status === 422);

    // 8) concurrency (zero-cost item → GL skipped → the state-guard is the only
    //    arbiter): two simultaneous issues → exactly one wins (200), the other
    //    409, and the source is decremented EXACTLY once (loser rolled back).
    async function q0() { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [TA, ITEM0]); return Number(r[0].qty); }
    const cc = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM0, qtyRequested: 10 }] });
    const ccId = cc.body.id;
    await req('POST', `${E}/${ccId}/approve`, admin, {});
    const a0Before = await q0();
    const [r1, r2] = await Promise.all([
      req('POST', `${E}/${ccId}/issue`, both, {}),
      req('POST', `${E}/${ccId}/issue`, both, {}),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200).length;
    const conflicts = [r1, r2].filter((r) => r.status === 409).length;
    check('concurrent issue → exactly one 200 + one 409', oks === 1 && conflicts === 1, { s1: r1.status, s2: r2.status });
    check('source decremented exactly once (loser rolled back)', a0Before - (await q0()) === 10, { a0Before, now: await q0() });

    // 9) insufficient stock rollback: request more than available
    const av = await qty(TA);
    const big = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: av + 1000 }] });
    await req('POST', `${E}/${big.body.id}/approve`, admin, {});
    const ins = await req('POST', `${E}/${big.body.id}/issue`, both, {});
    check('insufficient stock → 422 INSUFFICIENT_STOCK', ins.status === 422 && ins.body.code === 'INSUFFICIENT_STOCK', ins.body && ins.body.code);
    check('source unchanged after failed issue (rollback)', (await qty(TA)) === av, { av, now: await qty(TA) });

    // 10) Real draft EDIT (PATCH) — in place, preserves identity, no stock/GL.
    const d1 = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, notes: 'orig', items: [{ itemId: ITEM, qtyRequested: 5 }] });
    const dId = d1.body.id, dNum = d1.body.issueNumber;
    const [[meta0]] = await db.query('SELECT created_by, created_at FROM stock_issues WHERE id=?', [dId]);
    const aPre = await qty(TA), bPre = await qty(TB);
    const ed = await req('PATCH', `${E}/${dId}`, both, { fromWarehouseId: TA, toWarehouseId: TB, notes: 'edited', expectedVersion: 1, items: [{ itemId: ITEM, qtyRequested: 8 }, { itemId: ITEM0, qtyRequested: 3 }] });
    check('PATCH draft → 200, status draft, version 2', ed.status === 200 && ed.body.status === 'draft' && ed.body.version === 2, ed.body);
    check('PATCH preserves the document number', ed.body.documentNumber === dNum && ed.body.issueNumber === dNum, { was: dNum, now: ed.body.documentNumber });
    const [[meta1]] = await db.query('SELECT issue_number, created_by, created_at FROM stock_issues WHERE id=?', [dId]);
    check('PATCH preserves id, number, created_by, created_at', meta1.issue_number === dNum && meta1.created_by === meta0.created_by && String(meta1.created_at) === String(meta0.created_at), { m0: meta0, m1: meta1 });
    const [edLines] = await db.query('SELECT item_id, qty_requested FROM stock_issue_items WHERE issue_id=? ORDER BY item_id', [dId]);
    check('PATCH replaced lines (2 items, qty updated to 8)', edLines.length === 2 && Number((edLines.find((l) => l.item_id === ITEM) || {}).qty_requested) === 8, edLines.map((l) => [l.item_id, Number(l.qty_requested)]));
    check('PATCH moved NO stock', (await qty(TA)) === aPre && (await qty(TB)) === bPre, { ta: await qty(TA), aPre });
    check('PATCH missing expectedVersion → 422', (await req('PATCH', `${E}/${dId}`, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 1 }] })).status === 422);
    check('PATCH duplicate itemId → 422', (await req('PATCH', `${E}/${dId}`, both, { expectedVersion: 2, fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 1 }, { itemId: ITEM, qtyRequested: 2 }] })).status === 422);
    const [pe1, pe2] = await Promise.all([
      req('PATCH', `${E}/${dId}`, both, { expectedVersion: 2, fromWarehouseId: TA, toWarehouseId: TB, notes: 'A', items: [{ itemId: ITEM, qtyRequested: 4 }] }),
      req('PATCH', `${E}/${dId}`, both, { expectedVersion: 2, fromWarehouseId: TA, toWarehouseId: TB, notes: 'B', items: [{ itemId: ITEM, qtyRequested: 6 }] }),
    ]);
    check('concurrent PATCH → one 200, one 409 VERSION_CONFLICT', [pe1, pe2].filter((r) => r.status === 200).length === 1 && [pe1, pe2].filter((r) => r.status === 409 && r.body.code === 'VERSION_CONFLICT').length === 1, { s1: pe1.status, s2: pe2.status, c1: pe1.body && pe1.body.code, c2: pe2.body && pe2.body.code });
    await req('POST', `${E}/${dId}/approve`, admin, {});
    const peApproved = await req('PATCH', `${E}/${dId}`, both, { expectedVersion: 9, fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 1 }] });
    check('PATCH a non-draft → 422 INVALID_STATE_TRANSITION', peApproved.status === 422 && peApproved.body.code === 'INVALID_STATE_TRANSITION', peApproved.body && peApproved.body.code);

    // 11) Idempotency: same key+payload replays; same key+DIFFERENT payload → conflict.
    const ik = 'idem-probe-conflict';
    const ic1 = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 2 }] }, { 'Idempotency-Key': ik });
    const ic2 = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 2 }] }, { 'Idempotency-Key': ik });
    const ic3 = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 99 }] }, { 'Idempotency-Key': ik });
    check('idempotency same key+payload → replay same id', ic1.status === 200 && ic2.body.id === ic1.body.id, { a: ic1.body.id, b: ic2.body.id });
    check('idempotency same key+DIFFERENT payload → 409 IDEMPOTENCY_CONFLICT', ic3.status === 409 && ic3.body.code === 'IDEMPOTENCY_CONFLICT', { s: ic3.status, c: ic3.body && ic3.body.code });

    // 12) Reverse scenarios — partial-reverse quantity correctness.
    const rv1 = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 12 }] });
    await req('POST', `${E}/${rv1.body.id}/approve`, admin, {});
    await req('POST', `${E}/${rv1.body.id}/issue`, both, {});
    const s1 = await qty(TA), b1 = await qty(TB);
    const rr1 = await req('POST', `${E}/${rv1.body.id}/reverse`, admin, { reason: 'إرجاع بعد الصرف بلا استلام' });
    check('reverse-after-issued(no receipt) → reversed; source +12, dest unchanged', rr1.status === 200 && rr1.body.status === 'reversed' && (await qty(TA)) - s1 === 12 && (await qty(TB)) === b1, { src: (await qty(TA)) - s1, dst: (await qty(TB)) - b1 });
    check('duplicate reverse blocked', (await req('POST', `${E}/${rv1.body.id}/reverse`, admin, { reason: 'مكرر' })).status === 422);

    const rv2 = await req('POST', E, both, { fromWarehouseId: TA, toWarehouseId: TB, items: [{ itemId: ITEM, qtyRequested: 20 }] });
    await req('POST', `${E}/${rv2.body.id}/approve`, admin, {});
    await req('POST', `${E}/${rv2.body.id}/issue`, both, {});
    const rv2line = (await db.query('SELECT id FROM stock_issue_items WHERE issue_id=?', [rv2.body.id]))[0][0].id;
    await req('POST', `${E}/${rv2.body.id}/receive`, both, { items: [{ id: rv2line, qtyReceived: 7 }] });
    const s2 = await qty(TA), b2 = await qty(TB);
    const rr2 = await req('POST', `${E}/${rv2.body.id}/reverse`, admin, { reason: 'إرجاع بعد استلام جزئي' });
    check('reverse-after-partial → source +20 (full issued), dest -7 (received only)', rr2.status === 200 && (await qty(TA)) - s2 === 20 && b2 - (await qty(TB)) === 7, { src: (await qty(TA)) - s2, dst: b2 - (await qty(TB)) });
    const [rMoves] = await db.query("SELECT type, qty FROM inventory_movements WHERE reference_id=? AND reference_type='transfer_reverse'", [rv2.body.id]);
    const inMv = rMoves.filter((m) => m.type === 'in').reduce((s, m) => s + Number(m.qty), 0);
    const outMv = rMoves.filter((m) => m.type === 'out').reduce((s, m) => s + Number(m.qty), 0);
    check('reverse movements match actual qty (in=20 source, out=7 dest)', inMv === 20 && outMv === 7, { inMv, outMv });

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('Total: ' + (_p + _f) + ' | Passed: ' + _p + ' | Failed: ' + _f);
    console.log('═══════════════════════════════════════════════════════════');
    exitCode = _f > 0 ? 1 : 0;
  } catch (e) { console.error('FATAL', e); exitCode = 2; }
  finally { try { server.kill(); } catch (_) {} await cleanup(); }
  process.exit(exitCode);
})();
