'use strict';
/* Integration — GET /api/analytics/reconciliation (three-way, real server + DB).
 *
 *   · balanced seeded day (B1 03-10): salesVsPayments = 0, orders/invoice
 *     exact, D1 in the sales drill and voided D5 NOT, cash delta null (no
 *     close_count that day — honest "not measured");
 *   · seeded mismatch (own fixture DX, completed order fact with NO payment
 *     facts): salesVsPayments = exact invoice total AND the document appears
 *     in the orders-without-payment drill;
 *   · till mismatch day: open 100 + cash_sale 50 − (pay_out 30 + deposit 20)
 *     = expected 100 vs close_count 90 → cashExpectedVsCounted = 10 (this
 *     also PROVES the deposit-as-outflow merge-owner ruling);
 *   · orphan payment fact (document_id NULL) → paymentsWithoutOrder drill +
 *     salesVsPayments = −amount;
 *   · CN day (B1 03-12): sales side empty, refund leg in B → delta +115
 *     (the report SHOWS the CN asymmetry, documented service semantics);
 *   · scope clamp: accountant with W1→B1 sees ONLY B1 rows; asking for B2
 *     explicitly → empty rows (fail-closed, success:true);
 *   · manager (analytics.view but NOT reconciliation.view) → 403;
 *   · missing from/to → 422.
 *
 * Fixtures: ITEST-SHRC-* (salesHubSeed 2032-03 + own rows). PORT 3991.
 * Run: node tests/integration/analyticsReconciliation.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');

const PORT = 3991;
const PREFIX = 'ITEST-SHRC';
const ADMIN = 'itest_shrc_admin';
const ACCT = 'itest_shrc_acct';   // accountant — reconciliation.view via role, W1 → B1
const MGR = 'itest_shrc_mgr';     // manager — analytics.view but NOT reconciliation.view
const PW = 'Shrc#Test!2032';
let I = null;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); }
}

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end();
  });
}
const login = async (u) => (await call('POST', '/api/auth/login', null, { username: u, password: PW })).body?.token || '';
async function waitUp() {
  for (let i = 0; i < 180; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 1000));
  }
  return false;
}
const REC = (token, qs) => call('GET', '/api/analytics/reconciliation' + (qs ? '?' + qs : ''), token);
const rowOf = (resp, day, branch) => (resp.body?.data?.rows || [])
  .find((r) => r.business_day === day && String(r.branch_id) === String(branch));

async function cleanupUsers() {
  for (const u of [ADMIN, ACCT, MGR]) {
    try {
      const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
      if (r.length) await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r[0].id]);
      await db.query('DELETE FROM users WHERE username = ?', [u]);
    } catch (_) {}
  }
}

/** Own fixture rows on top of salesHubSeed: the mismatch days. */
async function seedOwn(I) {
  const DX = `${PREFIX}-DX`;
  // ── 03-22: completed order with NO payment facts (orders-without-payment) ──
  await db.query(
    `INSERT INTO ar_documents (id, document_number, document_type, source_type, source_id,
                               brand_id, branch_id, issue_date, subtotal, discount_amount,
                               vat_amount, total_amount, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [DX, DX, 'invoice', 'pos', null, I.BRAND, I.B1, '2032-03-22', 100, 0, 0, 100, 'paid', 'itest']);
  await db.query(
    `INSERT INTO analytics_order_facts
       (document_id, branch_id, brand_id, order_type, source, status, created_by,
        occurred_at_local, business_day, tz_snapshot, discount_total, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [DX, I.B1, I.BRAND, 'dine_in', 'pos', 'completed', 'itest',
     '2032-03-22 13:00:00', '2032-03-22', 'Asia/Riyadh', 0, 'live']);
  // till mismatch: expected 100+50−(30+20)=100 vs counted 90 → delta 10
  const till = (type, amount, srcId) => db.query(
    `INSERT INTO analytics_till_facts
       (branch_id, movement_type, amount, occurred_at, occurred_at_local, business_day,
        performed_by, source_type, source_id, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,'live')`,
    [I.B1, type, amount, '2032-03-22 12:00:00', '2032-03-22 12:00:00', '2032-03-22',
     'itest', 'itest', srcId]);
  await till('open_float', 100, `${PREFIX}-TX1`);
  await till('cash_sale', 50, `${PREFIX}-TX2`);
  await till('pay_out', 30, `${PREFIX}-TX3`);
  await till('deposit', 20, `${PREFIX}-TX4`);
  await till('close_count', 90, `${PREFIX}-TX5`);

  // ── 03-23: orphan payment fact (document_id NULL) ──
  await db.query(
    `INSERT INTO analytics_payment_facts
       (source_type, source_id, line_no, document_id, branch_id, brand_id,
        method_raw, method_norm, direction, amount, status,
        occurred_at, occurred_at_local, business_day, performed_by, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['ar_receipt', `${PREFIX}-ORPH`, 0, null, I.B1, I.BRAND, 'Cash', 'cash', 'in', 40,
     'captured', '2032-03-23 10:00:00', '2032-03-23 10:00:00', '2032-03-23', 'itest', 'live']);
}

(async () => {
  await seedMod.cleanup(db, PREFIX);
  await cleanupUsers();
  I = await seedMod.seed(db, PREFIX);
  await seedOwn(I);

  const hash = await bcrypt.hash(PW, 12);
  const mkUser = async (u, role) => {
    const [r] = await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [u, hash, role]);
    return r.insertId;
  };
  await mkUser(ADMIN, 'admin');
  const acctId = await mkUser(ACCT, 'accountant');
  await mkUser(MGR, 'manager');
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)',
    [acctId, I.W1, 'itest']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT), ANALYTICS_DISABLE_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }
    const admin = await login(ADMIN);
    const acct = await login(ACCT);
    const mgr = await login(MGR);
    check('all three users got JWTs', !!admin && !!acct && !!mgr);

    const W = `from=2032-03-01&to=2032-03-31&branchIds=${I.B1},${I.B2}`;
    const ra = await REC(admin, W);
    check('admin answers 200 success', ra.status === 200 && ra.body?.success === true, ra.status);

    // ── balanced day: B1 03-10 ─────────────────────────────────────────────
    console.log('\n▶ balanced day (B1 03-10)');
    const r10 = rowOf(ra, '2032-03-10', I.B1);
    check('row exists with orders 1, invoice 204 (voided D5 excluded)',
      !!r10 && r10.sales.orders === 1 && r10.sales.invoice_total === 204, r10 && r10.sales);
    check('payments in 204 / out 0 / net 204', !!r10 &&
      r10.payments.in === 204 && r10.payments.out === 0 && r10.payments.net === 204, r10 && r10.payments);
    check('salesVsPayments delta is ZERO', !!r10 && r10.deltas.salesVsPayments === 0, r10 && r10.deltas);
    check('sales drill contains D1 and NOT voided D5', !!r10 &&
      r10.sales.documentIds.includes(I.D1) && !r10.sales.documentIds.includes(I.D5) &&
      r10.sales.documentIdsTotal === 1, r10 && r10.sales.documentIds);
    check('cash delta NULL when no close_count (not measured, never 0)',
      !!r10 && r10.deltas.cashExpectedVsCounted === null && r10.till.counted === null, r10 && r10.till);
    check('no exceptions on the balanced day', !!r10 &&
      r10.exceptions.paymentsWithoutOrder.count === 0 &&
      r10.exceptions.ordersWithoutPayment.count === 0, r10 && r10.exceptions);

    // ── CN day: B1 03-12 (documented asymmetry) ────────────────────────────
    console.log('\n▶ CN day (B1 03-12)');
    const r12 = rowOf(ra, '2032-03-12', I.B1);
    check('CN day: sales side empty, payments out 115, delta +115', !!r12 &&
      r12.sales.orders === 0 && r12.payments.out === 115 &&
      r12.deltas.salesVsPayments === 115, r12 && { sales: r12.sales, deltas: r12.deltas });

    // ── seeded mismatch: B1 03-22 ──────────────────────────────────────────
    console.log('\n▶ mismatch day (B1 03-22): missing payment + till variance');
    const r22 = rowOf(ra, '2032-03-22', I.B1);
    check('salesVsPayments = 100 (invoice with no payment facts)', !!r22 &&
      r22.sales.invoice_total === 100 && r22.payments.net === 0 &&
      r22.deltas.salesVsPayments === 100, r22 && r22.deltas);
    check('DX listed in orders-without-payment drill (count 1)', !!r22 &&
      r22.exceptions.ordersWithoutPayment.count === 1 &&
      r22.exceptions.ordersWithoutPayment.documentIds.includes(`${PREFIX}-DX`),
      r22 && r22.exceptions.ordersWithoutPayment);
    check('till expected 100 (deposit counted as OUTFLOW) vs counted 90', !!r22 &&
      r22.till.expected_cash === 100 && r22.till.counted === 90 &&
      r22.till.deposit === 20 && r22.till.pay_out === 30, r22 && r22.till);
    check('cashExpectedVsCounted = 10', !!r22 && r22.deltas.cashExpectedVsCounted === 10, r22 && r22.deltas);

    // ── orphan payment: B1 03-23 ───────────────────────────────────────────
    console.log('\n▶ orphan payment (B1 03-23)');
    const r23 = rowOf(ra, '2032-03-23', I.B1);
    check('paymentsWithoutOrder count 1 with a fact id', !!r23 &&
      r23.exceptions.paymentsWithoutOrder.count === 1 &&
      r23.exceptions.paymentsWithoutOrder.factIds.length === 1, r23 && r23.exceptions);
    check('salesVsPayments = −40 on the orphan day', !!r23 &&
      r23.deltas.salesVsPayments === -40, r23 && r23.deltas);

    // exception totals across the B1 window
    const rb1 = await REC(admin, `from=2032-03-01&to=2032-03-31&branchIds=${I.B1}`);
    check('B1 totals: 1 orphan payment + 1 unpaid order across the window',
      rb1.status === 200 && rb1.body?.data?.totals?.paymentsWithoutOrder === 1 &&
      rb1.body?.data?.totals?.ordersWithoutPayment === 1, rb1.body?.data?.totals);

    // ── scope clamp ────────────────────────────────────────────────────────
    console.log('\n▶ scope clamp (accountant W1 → B1 only)');
    const rs = await REC(acct, 'from=2032-03-01&to=2032-03-31');
    check('accountant answers 200 with ONLY B1 rows', rs.status === 200 &&
      (rs.body?.data?.rows || []).length > 0 &&
      (rs.body?.data?.rows || []).every((r) => String(r.branch_id) === I.B1),
      (rs.body?.data?.rows || []).map((r) => r.branch_id));
    const rs2 = await REC(acct, `from=2032-03-01&to=2032-03-31&branchIds=${I.B2}`);
    check('asking for the OTHER branch → empty rows, success:true (fail-closed)',
      rs2.status === 200 && rs2.body?.success === true &&
      (rs2.body?.data?.rows || []).length === 0, rs2.body?.data);

    // ── cap-less + validation ──────────────────────────────────────────────
    console.log('\n▶ authz + validation');
    const rm = await REC(mgr, W);
    check('manager (no reconciliation.view) → 403 PERMISSION_DENIED',
      rm.status === 403 && rm.body?.code === 'PERMISSION_DENIED', rm);
    const rv = await REC(admin, '');
    check('missing from/to → 422 VALIDATION_ERROR',
      rv.status === 422 && rv.body?.code === 'VALIDATION_ERROR', rv);

    console.log(`\n${fail === 0 ? '✅' : '❌'} analyticsReconciliation: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await seedMod.cleanup(db, PREFIX);
    await cleanupUsers();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
