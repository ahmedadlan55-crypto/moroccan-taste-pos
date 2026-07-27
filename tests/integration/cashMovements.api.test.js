'use strict';
/**
 * Shift till cash movements (حركات نقدية على الدرج) — integration (REAL server + DB).
 *
 * THE GAP THIS PROVES CLOSED: a cashier could not record cash in or out during
 * a shift from any client (/api/cash is admin/manager-only) and neither
 * cash_receipts nor cash_payments carried a shift reference — so a drop to the
 * safe, a float top-up or petty cash was invisible to the till and the
 * expected-cash figure at close was wrong by exactly those amounts.
 *
 * Asserted end to end, with the actual numbers:
 *   · POST /api/shifts/:id/movements is reachable by a CASHIER token
 *     (posPortalScope allow-list, GET + POST) while /api/cash stays denied;
 *   · manager approval is REQUIRED and verified server-side — missing creds,
 *     a wrong password, and a valid-but-uncapable approver each refuse, with
 *     the capability refusal distinguishable from the credential refusal;
 *   · an approved movement writes a POSTED voucher carrying shift_id, a GL
 *     journal, the approver's name, and an audit_logs row;
 *   · analytics_till_facts gains a pay_in / pay_out row WITH shift_id;
 *   · GET closing-data-v3 and the close itself both move by exactly the net
 *     movement (200 float + 150 in − 90 out = 260 expected on a zero-sales
 *     shift) — counting 260 closes at variance 0, and the pre-fix behaviour
 *     (counting the float only, 200) would now read −60;
 *   · ReconciliationService.threeWay's expected_cash includes them;
 *   · the X/Z full-report lists the movements and their totals;
 *   · a closed shift, another cashier's shift, and invalid input all refuse.
 *
 * Fixtures: ITEST-CMV-* / itest_cmv_*. PORT 4014.
 * Run: node tests/integration/cashMovements.api.test.js
 */
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const equations = require('../../lib/analytics/equations');
const Reconciliation = require('../../services/analytics/ReconciliationService');

const PORT = Number(process.env.CASHMV_TEST_PORT || 4014);
const BASE = { host: '127.0.0.1', port: PORT };

const BRAND = 'ITEST-CMV-BRAND';
const BRANCH = 'ITEST-CMV-BRANCH';
const U_CASH = 'itest_cmv_cashier';
const U_CASH2 = 'itest_cmv_cashier2';
const U_MGR = 'itest_cmv_manager';
const PW = 'Cmv#Test!2032';
const CAP = 'pos.cash_movement.approve';

let _p = 0, _f = 0; const _fails = [];
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; _fails.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 500) : ''); }
}

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(20000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 180; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); }
  return false;
}
const tok = (id, username, role) => jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));

/** The projection is fire-and-forget post-commit — poll rather than guess. */
async function waitForTillFact(shiftId, movementType, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const [r] = await db.query(
      'SELECT * FROM analytics_till_facts WHERE shift_id = ? AND movement_type = ?', [shiftId, movementType]);
    if (r.length) return r[0];
    await sleep(250);
  }
  return null;
}

async function cleanup() {
  const users = [U_CASH, U_CASH2, U_MGR];
  const sqls = [
    ["DELETE FROM analytics_till_facts WHERE shift_id LIKE 'SH-%' AND branch_id = ?", [BRANCH]],
    ['DELETE FROM analytics_till_facts WHERE branch_id = ?', [BRANCH]],
    ['DELETE FROM analytics_dirty_days WHERE branch_id = ?', [BRANCH]],
    ["DELETE FROM audit_logs WHERE entity_type = 'shift_cash_movement' AND user_username IN (?,?,?)", users],
    ['DELETE FROM cash_receipts WHERE created_by IN (?,?,?)', users],
    ['DELETE FROM cash_payments WHERE created_by IN (?,?,?)', users],
    ['DELETE FROM shift_close_denominations WHERE shift_id IN (SELECT id FROM shifts WHERE username IN (?,?,?))', users],
    ['DELETE FROM shifts WHERE username IN (?,?,?)', users],
    ['DELETE FROM cash_boxes WHERE branch_id = ?', [BRANCH]],
    ['DELETE FROM users WHERE username IN (?,?,?)', users],
    ['DELETE FROM branches WHERE id = ?', [BRANCH]],
    ['DELETE FROM brands WHERE id = ?', [BRAND]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  const hash = bcrypt.hashSync(PW, 10);
  await db.query('INSERT INTO brands (id, name) VALUES (?,?)', [BRAND, 'ITEST CMV Brand']);
  await db.query('INSERT INTO branches (id, name, brand_id) VALUES (?,?,?)', [BRANCH, 'ITEST CMV Branch', BRAND]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_CASH, hash, 'cashier', BRANCH]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_CASH2, hash, 'cashier', BRANCH]);
  await db.query('INSERT INTO users (username,password,role,branch_id) VALUES (?,?,?,?)', [U_MGR, hash, 'manager', BRANCH]);
  const ids = {};
  for (const u of [U_CASH, U_CASH2, U_MGR]) {
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ shift till cash movements — integration ═══\n');
  const ids = await seed();
  const cashT = tok(ids[U_CASH], U_CASH, 'cashier');
  const cash2T = tok(ids[U_CASH2], U_CASH2, 'cashier');
  const mgrT = tok(ids[U_MGR], U_MGR, 'manager');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), NAME_EN_BACKFILL_DISABLE_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let shiftId = null;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── 0) migration + capability seed actually ran ─────────────────────────
    console.log('▸ migration + capability seed');
    for (const table of ['cash_receipts', 'cash_payments']) {
      const [c] = await db.query(
        "SELECT COLUMN_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
        "AND TABLE_NAME = ? AND COLUMN_NAME = 'shift_id'", [table]);
      check(`${table}.shift_id exists and is NULLABLE`, c.length === 1 && c[0].IS_NULLABLE === 'YES', c);
      const [i] = await db.query(
        'SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ' +
        'AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, 'shift_id']);
      check(`${table}.shift_id is indexed`, i.length >= 1, i);
    }
    const [permRow] = await db.query('SELECT id FROM permissions_v3 WHERE id = ?', [CAP]);
    check('capability pos.cash_movement.approve is seeded', permRow.length === 1, permRow);
    const [mgrGrant] = await db.query('SELECT role FROM role_permissions WHERE permission_id = ? AND role = ?', [CAP, 'manager']);
    check('manager holds the approval capability', mgrGrant.length === 1, mgrGrant);
    const [cashGrant] = await db.query('SELECT role FROM role_permissions WHERE permission_id = ? AND role = ?', [CAP, 'cashier']);
    check('cashier does NOT hold the approval capability', cashGrant.length === 0, cashGrant);

    // ── 1) open a shift with a 200 float ────────────────────────────────────
    console.log('▸ open shift (float 200)');
    let r = await req('POST', '/api/shifts/open', cashT, { openingFloat: 200, device: { ua: 'cmv-test' } });
    shiftId = r.body && r.body.shiftId;
    check('cashier opened a shift with a 200 float', r.status === 200 && !!shiftId && r.body.openingFloat === 200, r.body);

    // ── 2) the cashier portal boundary ──────────────────────────────────────
    console.log('▸ portal scope');
    r = await req('POST', '/api/cash/receipts', cashT, { amount: 10, destinationType: 'cash', destinationId: 'x' });
    check('cashier is STILL denied /api/cash (the ERP voucher module)',
      r.status === 403 && r.body && r.body.reason === 'PORTAL_FORBIDDEN', { s: r.status, b: r.body });
    r = await req('GET', `/api/shifts/${shiftId}/movements`, cashT);
    check('cashier CAN reach GET /shifts/:id/movements (empty so far)',
      r.status === 200 && r.body.success === true && r.body.movements.length === 0 && r.body.totals.net === 0, { s: r.status, b: r.body });

    // ── 3) the approval gate ────────────────────────────────────────────────
    console.log('▸ manager approval gate');
    const mvBody = (extra) => Object.assign({ kind: 'pay_in', amount: 150, reason: 'تعزيز عهدة الدرج' }, extra || {});
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, mvBody());
    check('no approver credentials → 403 approval_required',
      r.status === 403 && r.body && r.body.code === 'approval_required', { s: r.status, b: r.body });
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, mvBody({ approverUsername: U_MGR, approverPassword: 'wrong-password' }));
    check('wrong approver password → 403 approval_invalid',
      r.status === 403 && r.body && r.body.code === 'approval_invalid', { s: r.status, b: r.body });
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, mvBody({ approverUsername: 'itest_cmv_ghost', approverPassword: PW }));
    check('unknown approver → the SAME generic approval_invalid (no user enumeration)',
      r.status === 403 && r.body && r.body.code === 'approval_invalid', { s: r.status, b: r.body });
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, mvBody({ approverUsername: U_CASH2, approverPassword: PW }));
    check('valid credentials WITHOUT the capability → 403 approval_forbidden',
      r.status === 403 && r.body && r.body.code === 'approval_forbidden', { s: r.status, b: r.body });
    const [noRows] = await db.query('SELECT id FROM cash_receipts WHERE shift_id = ?', [shiftId]);
    check('a refused approval wrote NOTHING — not even a draft', noRows.length === 0, noRows);

    // ── 4) input validation ─────────────────────────────────────────────────
    console.log('▸ input validation');
    const approved = { approverUsername: U_MGR, approverPassword: PW };
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, Object.assign({ kind: 'transfer', amount: 10, reason: 'x y' }, approved));
    check('invalid kind → 400 invalid_kind', r.status === 400 && r.body.code === 'invalid_kind', { s: r.status, b: r.body });
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, Object.assign({ kind: 'pay_in', amount: -5, reason: 'x y' }, approved));
    check('negative amount → 400 invalid_amount', r.status === 400 && r.body.code === 'invalid_amount', { s: r.status, b: r.body });
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, Object.assign({ kind: 'pay_in', amount: 999999, reason: 'x y' }, approved));
    check('amount above the cap → 400 amount_too_large', r.status === 400 && r.body.code === 'amount_too_large', { s: r.status, b: r.body });
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, Object.assign({ kind: 'pay_in', amount: 10, reason: '' }, approved));
    check('missing reason → 400 reason_required', r.status === 400 && r.body.code === 'reason_required', { s: r.status, b: r.body });

    // ── 5) the happy path — pay_in 150 ──────────────────────────────────────
    console.log('▸ approved pay_in 150');
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT,
      Object.assign({ kind: 'pay_in', amount: 150, reason: 'تعزيز عهدة الدرج', note: 'من الخزنة' }, approved));
    const payInId = r.body && r.body.movement && r.body.movement.id;
    check('pay_in accepted', r.status === 200 && r.body.success === true && !!payInId, { s: r.status, b: r.body });
    check('response records the APPROVER, not the actor',
      r.body && r.body.movement && r.body.movement.approvedBy === U_MGR && r.body.movement.createdBy === U_CASH, r.body && r.body.movement);
    check('response totals: payIn 150 / payOut 0 / net 150',
      r.body && r.body.totals && r.body.totals.payIn === 150 && r.body.totals.payOut === 0 && r.body.totals.net === 150, r.body && r.body.totals);

    const [rec] = await db.query('SELECT * FROM cash_receipts WHERE id = ?', [payInId]);
    check('a cash_receipt row exists', rec.length === 1, rec.length);
    if (rec.length) {
      check('  · status = posted (a movement is only counted once approved)', rec[0].status === 'posted', rec[0].status);
      check('  · shift_id links it to the shift', rec[0].shift_id === shiftId, rec[0].shift_id);
      check('  · branch_id carries the shift branch', rec[0].branch_id === BRANCH, rec[0].branch_id);
      check('  · approved_by = the manager, created_by = the cashier',
        rec[0].approved_by === U_MGR && rec[0].created_by === U_CASH, { a: rec[0].approved_by, c: rec[0].created_by });
      check('  · a GL journal was posted', !!rec[0].journal_id, rec[0].journal_id);
      check('  · destination is a CASH box (what makes it a TILL movement)',
        rec[0].destination_type === 'cash' && !!rec[0].destination_id, rec[0]);
      check('  · amount 150, reason stored', Number(rec[0].amount) === 150 && String(rec[0].description).length > 0, rec[0].amount);
      const [jrn] = await db.query('SELECT id FROM gl_entries WHERE journal_id = ?', [rec[0].journal_id]);
      check('  · the journal has entries (balanced Dr/Cr, 2 lines)', jrn.length === 2, jrn.length);
    }
    const [aud] = await db.query(
      "SELECT * FROM audit_logs WHERE entity_type = 'shift_cash_movement' AND entity_id = ?", [payInId]);
    check('an audit_logs row names the approver', aud.length === 1 && /"approvedBy":"itest_cmv_manager"/.test(String(aud[0] && aud[0].details)), aud[0]);

    // ── 6) pay_out 90 ───────────────────────────────────────────────────────
    console.log('▸ approved pay_out 90');
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT,
      Object.assign({ kind: 'pay_out', amount: 90, reason: 'إيداع في الخزنة' }, approved));
    const payOutId = r.body && r.body.movement && r.body.movement.id;
    check('pay_out accepted', r.status === 200 && r.body.success === true && !!payOutId, { s: r.status, b: r.body });
    check('response totals: payIn 150 / payOut 90 / net 60',
      r.body && r.body.totals.payIn === 150 && r.body.totals.payOut === 90 && r.body.totals.net === 60, r.body && r.body.totals);
    const [pay] = await db.query('SELECT * FROM cash_payments WHERE id = ?', [payOutId]);
    check('a posted cash_payment row carries shift_id + a journal',
      pay.length === 1 && pay[0].status === 'posted' && pay[0].shift_id === shiftId && !!pay[0].journal_id, pay[0]);

    r = await req('GET', `/api/shifts/${shiftId}/movements`, cashT);
    check('GET movements lists both, newest-last, with reasons',
      r.status === 200 && r.body.movements.length === 2 &&
      r.body.movements[0].kind === 'pay_in' && r.body.movements[1].kind === 'pay_out' &&
      r.body.movements[0].reason === 'تعزيز عهدة الدرج', r.body && r.body.movements);

    // ── 7) analytics_till_facts carry the shift ─────────────────────────────
    console.log('▸ analytics_till_facts linkage');
    const inFact = await waitForTillFact(shiftId, 'pay_in');
    const outFact = await waitForTillFact(shiftId, 'pay_out');
    check('a pay_in till fact exists WITH shift_id (the linkage that was missing)',
      !!inFact && inFact.shift_id === shiftId && Number(inFact.amount) === 150 && inFact.branch_id === BRANCH, inFact);
    check('a pay_out till fact exists WITH shift_id',
      !!outFact && outFact.shift_id === shiftId && Number(outFact.amount) === 90 && outFact.branch_id === BRANCH, outFact);
    check('the till facts name the approver', !!inFact && inFact.approved_by === U_MGR, inFact && inFact.approved_by);
    const openFact = await waitForTillFact(shiftId, 'open_float');
    check('the open_float fact is 200', !!openFact && Number(openFact.amount) === 200, openFact && openFact.amount);

    // ── 8) EXPECTED CASH — the number that used to be wrong ─────────────────
    console.log('▸ expected cash (200 float + 150 in − 90 out = 260)');
    r = await req('GET', `/api/shifts/closing-data-v3/${shiftId}`, cashT);
    const cdMethods = (r.body && r.body.methods) || [];
    const cdCash = cdMethods.find((m) => String(m.groupType || '').toLowerCase() === 'cash');
    check('closing-data-v3 cash expected = 260 (was 200 — the float only)',
      !!cdCash && Number(cdCash.expectedAmount) === 260, { cash: cdCash, total: r.body && r.body.expectedTotal });
    check('closing-data-v3 expectedTotal = 260', r.body && Number(r.body.expectedTotal) === 260, r.body && r.body.expectedTotal);
    check('closing-data-v3 surfaces the movements + totals',
      r.body && r.body.movementTotals && r.body.movementTotals.payIn === 150 &&
      r.body.movementTotals.payOut === 90 && r.body.movementTotals.net === 60 &&
      Array.isArray(r.body.movements) && r.body.movements.length === 2, r.body && r.body.movementTotals);
    check('the openingFloat term is unchanged at 200 (movements are ADDITIVE, not a rewrite)',
      r.body && Number(r.body.openingFloat) === 200, r.body && r.body.openingFloat);
    check('equations.expectedCash(200,0,0,150,90) agrees with the endpoint',
      equations.expectedCash(200, 0, 0, 150, 90) === 260, equations.expectedCash(200, 0, 0, 150, 90));

    // X report (open shift) lists them
    r = await req('GET', `/api/shifts/${shiftId}/full-report`, cashT);
    check('X report lists both movements',
      r.status === 200 && Array.isArray(r.body.movements) && r.body.movements.length === 2, { s: r.status, m: r.body && r.body.movements });
    check('X report financials carry payIn 150 / payOut 90',
      r.body && r.body.financials && r.body.financials.payIn === 150 && r.body.financials.payOut === 90, r.body && r.body.financials);
    check('X report expectedTotal = 260', r.body && Number(r.body.financials.expectedTotal) === 260, r.body && r.body.financials);

    // ── 9) a foreign shift and bad state ────────────────────────────────────
    console.log('▸ ownership + shift state');
    r = await req('POST', `/api/shifts/${shiftId}/movements`, cash2T, Object.assign({ kind: 'pay_in', amount: 10, reason: 'محاولة' }, approved));
    check("another cashier cannot record on someone else's drawer → 403",
      r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED', { s: r.status, b: r.body });
    r = await req('POST', '/api/shifts/SH-DOES-NOT-EXIST/movements', cashT, Object.assign({ kind: 'pay_in', amount: 10, reason: 'محاولة' }, approved));
    check('unknown shift → 404 shift_not_found', r.status === 404 && r.body.code === 'shift_not_found', { s: r.status, b: r.body });

    // ── 10) CLOSE — the expected figure the cashier reconciles against ──────
    console.log('▸ close at counted 260 → variance 0');
    r = await req('POST', '/api/shifts/close-v3', cashT, {
      shiftId,
      openingFloat: 200,
      denominations: [{ value: 100, count: 2, kind: 'note' }, { value: 50, count: 1, kind: 'note' }, { value: 10, count: 1, kind: 'note' }],
      paymentTotals: {},
      notes: 'اختبار حركات الدرج',
    });
    check('close-v3 succeeded', r.status === 200 && r.body.success === true, { s: r.status, b: r.body });
    check('  · expectedTotal at close = 260 (float + movements)', r.body && Number(r.body.expectedTotal) === 260, r.body && r.body.expectedTotal);
    check('  · counted 260 → variance 0 (the drawer now balances)',
      r.body && Number(r.body.actualTotal) === 260 && Number(r.body.variance) === 0, { a: r.body && r.body.actualTotal, v: r.body && r.body.variance });
    const [closed] = await db.query('SELECT expected_total, actual_total, variance_total, theoretical_cash, diff_cash FROM shifts WHERE id = ?', [shiftId]);
    check('  · the shift row persisted expected 260 / variance 0',
      closed.length === 1 && Number(closed[0].expected_total) === 260 && Number(closed[0].variance_total) === 0, closed[0]);
    check('  · the PRE-FIX figure (float only, 200) would now read a −60 shortage',
      Number(closed[0].expected_total) - 200 === 60, closed[0]);

    r = await req('POST', `/api/shifts/${shiftId}/movements`, cashT, Object.assign({ kind: 'pay_in', amount: 10, reason: 'بعد الإقفال' }, approved));
    check('a CLOSED shift refuses new movements → 400 shift_not_open',
      r.status === 400 && r.body && r.body.code === 'shift_not_open', { s: r.status, b: r.body });

    // Z report
    r = await req('GET', `/api/shifts/${shiftId}/full-report`, cashT);
    check('Z report still lists the movements after close',
      r.status === 200 && r.body.movements.length === 2 && r.body.movementTotals.net === 60, r.body && r.body.movementTotals);
    // The server-rendered thermal page is the ADMIN shifts-list print button —
    // it is deliberately NOT on the cashier portal allow-list (the POS prints
    // its own HTML from /full-report), so this is read with a manager token.
    r = await req('GET', `/api/shifts/${shiftId}/full-report-print`, mgrT);
    check('the printed (thermal HTML) Z report renders the movements section',
      r.status === 200 && /TILL MOVEMENTS/.test(r.raw) && /تعزيز عهدة الدرج/.test(r.raw) && /صافي الحركات/.test(r.raw),
      { s: r.status, len: (r.raw || '').length });

    // ── 11) three-way reconciliation includes them ──────────────────────────
    console.log('▸ ReconciliationService.threeWay');
    const closeFact = await waitForTillFact(shiftId, 'close_count');
    check('a close_count till fact was projected', !!closeFact, closeFact);
    const day = (inFact && inFact.business_day)
      ? (inFact.business_day instanceof Date
          ? new Date(inFact.business_day.getTime() + 180 * 60000).toISOString().slice(0, 10)
          : String(inFact.business_day).slice(0, 10))
      : new Date().toISOString().slice(0, 10);
    const rec3 = await Reconciliation.threeWay(db, {
      scope: { all: true, caps: new Set(['analytics.reconciliation.view']) },
      from: day, to: day, branchIds: [BRANCH],
    });
    const cell = (rec3.rows || []).find((x) => String(x.branch_id) === BRANCH);
    check('a reconciliation row exists for the branch', !!cell, rec3.rows);
    if (cell) {
      check('  · till.pay_in = 150', Number(cell.till.pay_in) === 150, cell.till);
      check('  · till.pay_out = 90', Number(cell.till.pay_out) === 90, cell.till);
      check('  · till.open_float = 200', Number(cell.till.open_float) === 200, cell.till);
      check('  · expected_cash = 260 — the movements are IN the three-way now',
        Number(cell.till.expected_cash) === 260, cell.till);
      check('  · counted = 260 and cashExpectedVsCounted = 0',
        Number(cell.till.counted) === 260 && Number(cell.deltas.cashExpectedVsCounted) === 0, { t: cell.till, d: cell.deltas });
    }
  } catch (e) {
    _f++; _fails.push('FATAL: ' + e.message);
    console.error('FATAL', e);
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }

  console.log(`\n${_f === 0 ? '✅' : '❌'} cashMovements.api: ${_p} passed, ${_f} failed`);
  if (_f) console.log('   failed:', _fails.join(' | '));
  console.log('');
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
