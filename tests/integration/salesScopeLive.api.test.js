'use strict';
/* Integration — BRANCH ISOLATION PROVEN OVER REAL HTTP, WITH TWO REAL USERS.
 *
 * The branch-scope work (95b2441 route layer, 01da3a6 service layer) is covered
 * by unit suites that call the functions and assert on the SQL they emit. That
 * proves the clause is built; it cannot prove the clause is REACHED — a router
 * that forgets to pass `scope`, a report that never threads it, an export that
 * takes a second path, all still emit a perfect predicate in the unit test and
 * still hand the caller another branch's money.
 *
 * So this suite boots the real server, provisions two branches with DIFFERENT
 * figures, creates two real users with different grants, and asks over HTTP:
 *
 *   1  the restricted user's invoice / payment / return LISTS carry branch A only
 *   2  pagination.total is branch A's OWN total — not the company-wide count
 *      (a short page under an inflated total was the shipped defect)
 *   3  a branch-B record BY ID answers 404 — never 403, which would confirm the
 *      id exists; the GLOBAL user reading the SAME id proves the row is there
 *   4  `?branchId=<B>` sent by hand yields NOTHING from B — the grant
 *      intersection wins over the request, and `?branchIds=A,B` yields A only
 *   5  the O2C REPORTS carry branch-A MONEY for the restricted user, and the
 *      global user's figure is the SUM of both branches. sales-summary returns a
 *      FIXED {metric,value} list, so its row count is identical whether it leaks
 *      everything or nothing — only the values move, and only values are asserted
 *   6  the CSV export equals what the screen returned for the SAME user and
 *      filters — the two responses are compared to EACH OTHER (the screen JSON is
 *      re-encoded with the server's own lib/order-to-cash/http.toCsv), never to a
 *      pasted constant
 *   7  a user with ZERO grants gets nothing anywhere — never everything
 *   8  /api/analytics/query honours the identical isolation
 *
 * Fixtures: tests/fixtures/salesHubSeed (prefix ITEST-SCL, window 2032-03) for
 * branches / invoices / returns / analytics facts, plus three customer_payments
 * rows this suite owns (the shared fixture seeds no collections at all).
 * Residue is CHECKED, not asserted in prose: table counts must return to the
 * baseline taken after the opening cleanup — the same contract as
 * tests/o2cServices.integration.test.js.
 *
 * Run: node tests/integration/salesScopeLive.api.test.js   (MySQL must be up)
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const seedMod = require('../fixtures/salesHubSeed');
// The server's OWN CSV encoder. Re-implementing it here would let the export and
// the test agree on a bug; driving the real function cannot.
const H = require('../../lib/order-to-cash/http');

const PORT = 3979;
const PREFIX = 'ITEST-SCL';
const E = seedMod.EXPECTED;
const R = E.RANGE;                       // 2032-03-01 .. 2032-03-31
const PW = 'ScopeLive#Test!2032';
const U_GLOBAL = 'itest_scl_global';     // admin  → every branch
const U_BRANCH = 'itest_scl_branch';     // manager → branch B1 only
const U_ZERO = 'itest_scl_zero';         // manager → no grants at all
const CUST_B2 = PREFIX + '-CUSTB2';      // trades in B2 ONLY
let I = null;

/* Collections: the shared fixture has none, so this suite seeds its own with
 * deliberately distinctive amounts — a leak of B's receipts into A's list moves
 * the money from 750 to 875, which a row count would never have shown. */
const PAYMENTS = [
  { id: PREFIX + '-PAYA1', branch: 'B1', amount: 400, date: '2032-03-10', unapplied: 400, allocated: 0 },
  { id: PREFIX + '-PAYA2', branch: 'B1', amount: 350, date: '2032-03-12', unapplied: 0, allocated: 350 },
  { id: PREFIX + '-PAYB1', branch: 'B2', amount: 125, date: '2032-03-11', unapplied: 125, allocated: 0 },
];
const PAY_A = 750, PAY_B = 125, PAY_ALL = 875;

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 320) : ''); }
}

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      const chunks = [];
      s.on('data', (c) => chunks.push(c));
      s.on('end', () => {
        // Bytes, not a decoded string mid-flight: the CSV comparison below is a
        // byte comparison and a per-chunk decode can split a UTF-8 sequence.
        const raw = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(raw); } catch (_) {}
        res({ status: s.statusCode, body: j, raw, type: s.headers['content-type'] || '' });
      });
    });
    r.on('error', () => res({ status: 0, body: null, raw: '', type: '' }));
    if (d) r.write(d);
    r.end();
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

const qs = (o) => Object.keys(o)
  .filter((k) => o[k] != null && o[k] !== '')
  .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

const O2C = '/api/order-to-cash';
// `q` pins every list to THIS fixture (document/payment/return numbers all carry
// the prefix), so pagination.total is a number with a knowable right answer
// instead of "whatever else lives in the database".
const listInv = (t, x) => call('GET', `${O2C}/invoices?` + qs(Object.assign({ q: PREFIX, from: R.from, to: R.to, pageSize: 200 }, x || {})), t);
const listPay = (t, x) => call('GET', `${O2C}/payments?` + qs(Object.assign({ q: PREFIX, pageSize: 200 }, x || {})), t);
const listRet = (t, x) => call('GET', `${O2C}/returns?` + qs(Object.assign({ q: PREFIX, pageSize: 200 }, x || {})), t);
const rpt = (t, type, x) => call('GET', `${O2C}/reports/${type}?` + qs(Object.assign({ from: R.from, to: R.to }, x || {})), t);
const csv = (t, type, x) => call('GET', `${O2C}/reports/${type}/export?` + qs(Object.assign({ from: R.from, to: R.to }, x || {})), t);
const AQ = (t, body) => call('POST', '/api/analytics/query', t, Object.assign({ noCache: true }, body));

const rowsOf = (r) => (r.body && Array.isArray(r.body.data) ? r.body.data : []);
const idsOf = (r) => rowsOf(r).map((x) => String(x.id)).sort();
const totalOf = (r) => Number(r.body && r.body.pagination && r.body.pagination.total);
const money = (r, key) => Math.round(rowsOf(r).reduce((s, x) => s + Number(x[key] || 0), 0) * 100) / 100;
const sameSet = (a, b) => a.length === b.length && a.slice().sort().join('|') === b.slice().sort().join('|');
const disjoint = (a, b) => !a.some((v) => b.indexOf(v) !== -1);
const sumTotals = (r) => Object.keys((r.body && r.body.totals) || {})
  .reduce((s, k) => s + Math.abs(Number(r.body.totals[k]) || 0), 0);

// Every table this suite writes. Counted before and after so "cleanup works" is
// a verified equality rather than a promise. Audit/session tables are absent on
// purpose: logging in and calling an audited router legitimately appends there.
const COUNTED_TABLES = [
  'brands', 'branches', 'warehouses', 'menu', 'shifts', 'sales',
  'ar_documents', 'ar_document_lines', 'sales_returns', 'sales_return_lines',
  'customer_payments', 'customers', 'users', 'user_warehouse_access',
  'analytics_order_facts', 'analytics_payment_facts', 'analytics_till_facts',
  'analytics_modifier_facts', 'analytics_rollup_dirty',
];
async function tableCounts() {
  const out = {};
  for (const t of COUNTED_TABLES) {
    try { const [r] = await db.query('SELECT COUNT(*) c FROM `' + t + '`'); out[t] = Number(r[0].c); }
    catch (e) { if (e && e.code === 'ER_NO_SUCH_TABLE') out[t] = null; else throw e; }
  }
  return out;
}
const drift = (a, b) => COUNTED_TABLES.filter((t) => a[t] !== b[t]).map((t) => `${t}: ${a[t]} → ${b[t]}`);

async function cleanupAll() {
  await seedMod.cleanup(db, PREFIX);
  for (const p of PAYMENTS) {
    try { await db.query('DELETE FROM customer_payments WHERE id = ?', [p.id]); } catch (_) {}
  }
  try { await db.query('DELETE FROM customers WHERE id = ?', [CUST_B2]); } catch (_) {}
  for (const u of [U_GLOBAL, U_BRANCH, U_ZERO]) {
    try {
      const [r] = await db.query('SELECT id FROM users WHERE username = ?', [u]);
      if (r.length) await db.query('DELETE FROM user_warehouse_access WHERE user_id = ?', [r[0].id]);
      await db.query('DELETE FROM users WHERE username = ?', [u]);
    } catch (_) {}
  }
}

async function main() {
  I = await seedMod.seed(db, PREFIX);

  // A customer that has traded in B2 and nowhere else — the customer-statement
  // guard (assertCustomerInScope) has to answer 404 for the restricted user.
  await db.query('INSERT INTO customers (id, name) VALUES (?, ?)', [CUST_B2, 'ITEST SCL Cairo customer']);
  await db.query('UPDATE ar_documents SET customer_id = ? WHERE id IN (?, ?)', [CUST_B2, I.D4, I.D8B]);
  for (const p of PAYMENTS) {
    await db.query(
      `INSERT INTO customer_payments (id, payment_number, customer_id, customer_name, brand_id, branch_id,
                                      payment_date, payment_method, destination_type, amount,
                                      allocated_amount, unapplied_amount, status, created_by, posted_by)
       VALUES (?,?,?,?,?,?,?,'cash','cash',?,?,?,'posted','itest','itest')`,
      [p.id, p.id, p.branch === 'B2' ? CUST_B2 : null, null, I.BRAND, I[p.branch],
       p.date, p.amount, p.allocated, p.unapplied]);
  }

  const hash = await bcrypt.hash(PW, 12);
  const mkUser = async (u, role) => {
    const [r] = await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [u, hash, role]);
    return r.insertId;
  };
  await mkUser(U_GLOBAL, 'admin');
  const branchUserId = await mkUser(U_BRANCH, 'manager');
  await mkUser(U_ZERO, 'manager');
  // The grant goes through the SAME table lib/analytics/scope.loadBranchScope
  // reads — user_warehouse_access → warehouses.branch_id — so this test cannot
  // pass by teaching the suite a scope semantic the product does not have.
  await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?,?,?)',
    [branchUserId, I.W1, 'itest']);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), ORDER_TO_CASH_ENABLE: '1' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }

    const G = await login(U_GLOBAL);      // global — every branch
    const M = await login(U_BRANCH);      // restricted — branch A (B1) only
    const Z = await login(U_ZERO);        // zero grants
    check('all three users authenticated over HTTP', !!G && !!M && !!Z, { G: !!G, M: !!M, Z: !!Z });

    const INV_A = [I.D1, I.D3, I.D5, I.D7A, I.D7B, I.D8A, I.D14];
    const INV_B = [I.D4, I.D8B];
    const RET_A = [I.R3, I.R14];
    const RET_B = [I.R4];
    const PAY_IDS_A = PAYMENTS.filter((p) => p.branch === 'B1').map((p) => p.id);
    const PAY_IDS_B = PAYMENTS.filter((p) => p.branch === 'B2').map((p) => p.id);

    // ── 0. the two branches really do differ ────────────────────────────────
    console.log('\n▶ 0 · provisioned figures (a leak has to be visible as a NUMBER)');
    const sumG = await rpt(G, 'sales-summary');
    check('global sales-summary answers 200', sumG.status === 200, sumG.status);
    check(`global net = ${E.TOTAL.net_ex_vat} — the 2032-03 window holds THIS fixture and nothing else`,
      Number(sumG.body?.totals?.net) === E.TOTAL.net_ex_vat, sumG.body?.totals);
    console.log(`     branch A (${I.B1}): net ${E.B1.net_ex_vat} · returns ${E.B1.refunds_out} · collections ${PAY_A}`);
    console.log(`     branch B (${I.B2}): net ${E.B2.net_ex_vat} · returns ${E.B2.refunds_out} · collections ${PAY_B}`);

    // ── 1 + 2. lists carry branch A only, and the total is branch A's own ────
    console.log('\n▶ 1·2 · lists and pagination.total');
    const iG = await listInv(G), iM = await listInv(M);
    const pG = await listPay(G), pM = await listPay(M);
    const rG = await listRet(G), rM = await listRet(M);
    check('all six list calls answer 200',
      [iG, iM, pG, pM, rG, rM].every((x) => x.status === 200), [iG, iM, pG, pM, rG, rM].map((x) => x.status));

    check('restricted INVOICES = exactly branch A\'s documents', sameSet(idsOf(iM), INV_A), idsOf(iM));
    check('  …and not one branch-B document is present', disjoint(idsOf(iM), INV_B), idsOf(iM).filter((x) => INV_B.indexOf(x) !== -1));
    check('  …every returned row carries branch A on its own row data',
      rowsOf(iM).every((x) => String(x.branch_id) === I.B1), rowsOf(iM).map((x) => x.branch_id));
    check('global INVOICES = both branches', sameSet(idsOf(iG), INV_A.concat(INV_B)), idsOf(iG));

    check('restricted PAYMENTS = branch A receipts only', sameSet(idsOf(pM), PAY_IDS_A), idsOf(pM));
    check('global PAYMENTS = both branches', sameSet(idsOf(pG), PAY_IDS_A.concat(PAY_IDS_B)), idsOf(pG));
    check('restricted RETURNS = branch A returns only', sameSet(idsOf(rM), RET_A), idsOf(rM));
    check('global RETURNS = both branches', sameSet(idsOf(rG), RET_A.concat(RET_B)), idsOf(rG));

    // The money partition — the sums must ADD UP across the two users, and the
    // restricted sum must NOT equal the global one (else nothing is scoped).
    const iB = await listInv(G, { branchId: I.B2 });
    const pB = await listPay(G, { branchId: I.B2 });
    const rB = await listRet(G, { branchId: I.B2 });
    check(`invoice money partitions: A ${money(iM, 'total_amount')} + B ${money(iB, 'total_amount')} = all ${money(iG, 'total_amount')}`,
      money(iM, 'total_amount') + money(iB, 'total_amount') === money(iG, 'total_amount')
      && money(iM, 'total_amount') !== money(iG, 'total_amount') && money(iB, 'total_amount') > 0,
      { A: money(iM, 'total_amount'), B: money(iB, 'total_amount'), all: money(iG, 'total_amount') });
    check(`collections money partitions: A ${money(pM, 'amount')} + B ${money(pB, 'amount')} = all ${money(pG, 'amount')}`,
      money(pM, 'amount') === PAY_A && money(pB, 'amount') === PAY_B && money(pG, 'amount') === PAY_ALL,
      { A: money(pM, 'amount'), B: money(pB, 'amount'), all: money(pG, 'amount') });
    check(`returns money partitions: A ${money(rM, 'total_amount')} + B ${money(rB, 'total_amount')} = all ${money(rG, 'total_amount')}`,
      money(rM, 'total_amount') === E.B1.refunds_out && money(rB, 'total_amount') === E.B2.refunds_out
      && money(rG, 'total_amount') === E.TOTAL.refunds_out,
      { A: money(rM, 'total_amount'), B: money(rB, 'total_amount'), all: money(rG, 'total_amount') });

    // THE SHIPPED DEFECT: a page short by the rows the router had to drop, under
    // a total counted company-wide. Both halves are asserted.
    check(`pagination.total for the restricted user = ${INV_A.length} (branch A) and NOT ${INV_A.length + INV_B.length} (company)`,
      totalOf(iM) === INV_A.length && totalOf(iG) === INV_A.length + INV_B.length,
      { restricted: totalOf(iM), global: totalOf(iG) });
    check('  …payments + returns totals are the caller\'s own too',
      totalOf(pM) === PAY_IDS_A.length && totalOf(pG) === PAYMENTS.length
      && totalOf(rM) === RET_A.length && totalOf(rG) === RET_A.length + RET_B.length,
      { payM: totalOf(pM), payG: totalOf(pG), retM: totalOf(rM), retG: totalOf(rG) });
    check('  …the page is FULL: rows returned = pagination.total (no silent drop)',
      rowsOf(iM).length === totalOf(iM) && rowsOf(pM).length === totalOf(pM) && rowsOf(rM).length === totalOf(rM));
    check('  …and pagination.scopeFiltered is ABSENT — the post-filter found nothing left to drop',
      !iM.body?.pagination?.scopeFiltered && !pM.body?.pagination?.scopeFiltered && !rM.body?.pagination?.scopeFiltered,
      iM.body?.pagination);
    // A one-row page still reports branch A's total, not the company's — this is
    // the assertion a page-size-200 request can never make.
    const iM1 = await listInv(M, { pageSize: 1 });
    check(`a 1-row page still reports total ${INV_A.length}, not ${INV_A.length + INV_B.length}`,
      iM1.status === 200 && rowsOf(iM1).length === 1 && totalOf(iM1) === INV_A.length,
      { rows: rowsOf(iM1).length, total: totalOf(iM1) });

    // ── 3. by-id reads answer 404, and the id demonstrably EXISTS ────────────
    console.log('\n▶ 3 · a branch-B record BY ID → 404 (never 403)');
    const pairs = [
      ['invoices', I.D4, I.D1],
      ['returns', I.R4, I.R3],
      ['payments', PAY_IDS_B[0], PAY_IDS_A[0]],
    ];
    for (const [seg, foreignId, ownId] of pairs) {
      const denied = await call('GET', `${O2C}/${seg}/${encodeURIComponent(foreignId)}`, M);
      const exists = await call('GET', `${O2C}/${seg}/${encodeURIComponent(foreignId)}`, G);
      const mine = await call('GET', `${O2C}/${seg}/${encodeURIComponent(ownId)}`, M);
      check(`${seg}/<branch B id> → 404 for the restricted user (403 would confirm it exists)`,
        denied.status === 404 && denied.status !== 403, { status: denied.status, body: denied.body });
      check(`  …yet the GLOBAL user reads the SAME id: 200 — the row is really there`,
        exists.status === 200 && String(exists.body?.data?.id) === String(foreignId), { status: exists.status });
      check(`  …and the restricted user's OWN ${seg} record still answers 200 (404 is scope, not a broken route)`,
        mine.status === 200 && String(mine.body?.data?.id) === String(ownId), { status: mine.status });
    }
    const tl = await call('GET', `${O2C}/payments/${encodeURIComponent(PAY_IDS_B[0])}/timeline`, M);
    check('payments/<branch B id>/timeline → 404 (the id-only read that never loaded a row)', tl.status === 404, tl.status);
    const stmtM = await rpt(M, 'customer-statement', { customerId: CUST_B2 });
    const stmtG = await rpt(G, 'customer-statement', { customerId: CUST_B2 });
    check('customer-statement for a customer who trades ONLY in B → 404 for the restricted user',
      stmtM.status === 404, { status: stmtM.status, body: stmtM.body });
    check('  …and 200 for the global user (the customer exists)', stmtG.status === 200, stmtG.status);

    // ── 4. a hand-supplied ?branchId= loses to the grant ─────────────────────
    console.log('\n▶ 4 · ?branchId=<branch B> sent by hand');
    const iForge = await listInv(M, { branchId: I.B2 });
    const pForge = await listPay(M, { branchId: I.B2 });
    const rForge = await listRet(M, { branchId: I.B2 });
    check('restricted + ?branchId=B → 200 with ZERO rows on all three lists',
      [iForge, pForge, rForge].every((x) => x.status === 200 && rowsOf(x).length === 0),
      [iForge, pForge, rForge].map((x) => ({ s: x.status, n: rowsOf(x).length })));
    check('  …and pagination.total is 0, not the company count',
      totalOf(iForge) === 0 && totalOf(pForge) === 0 && totalOf(rForge) === 0,
      { inv: totalOf(iForge), pay: totalOf(pForge), ret: totalOf(rForge) });
    check('  …while the SAME parameter serves branch B to the global user (the filter is not simply broken)',
      rowsOf(iB).length === INV_B.length && sameSet(idsOf(iB), INV_B), idsOf(iB));
    const iBoth = await listInv(M, { branchIds: I.B1 + ',' + I.B2 });
    check('?branchIds=A,B → the INTERSECTION: branch A only', sameSet(idsOf(iBoth), INV_A), idsOf(iBoth));
    const sumForge = await rpt(M, 'sales-summary', { branchId: I.B2 });
    check('reports + ?branchId=B → every figure zero (aggregates cannot be filtered after the fact)',
      sumForge.status === 200 && sumTotals(sumForge) === 0, sumForge.body?.totals);

    // ── 5. reports: assert the MONEY ────────────────────────────────────────
    console.log('\n▶ 5 · O2C reports — the money, not the row count');
    const sumM = await rpt(M, 'sales-summary');
    const sumB = await rpt(G, 'sales-summary', { branchId: I.B2 });
    check(`sales-summary net: restricted ${sumM.body?.totals?.net} = branch A ${E.B1.net_ex_vat}`,
      Number(sumM.body?.totals?.net) === E.B1.net_ex_vat, sumM.body?.totals);
    check(`  …global ${sumG.body?.totals?.net} = A ${E.B1.net_ex_vat} + B ${E.B2.net_ex_vat}`,
      Number(sumG.body?.totals?.net) === Number(sumM.body?.totals?.net) + Number(sumB.body?.totals?.net),
      { all: sumG.body?.totals?.net, A: sumM.body?.totals?.net, B: sumB.body?.totals?.net });
    // Returns are the half whose omission would NET another branch's refunds off
    // this branch's sales — scoping only the invoice side is a silent money bug.
    check(`  …returns line scoped too: restricted ${sumM.body?.totals?.returns} = ${E.B1.refunds_out}, global ${sumG.body?.totals?.returns} = ${E.TOTAL.refunds_out}`,
      Number(sumM.body?.totals?.returns) === E.B1.refunds_out
      && Number(sumG.body?.totals?.returns) === E.TOTAL.refunds_out, {
        A: sumM.body?.totals?.returns, all: sumG.body?.totals?.returns });
    check('  …netAfterReturns is consistent with the two scoped halves',
      Number(sumM.body?.totals?.netAfterReturns) === Math.round((E.B1.net_ex_vat - E.B1.refunds_out) * 100) / 100,
      sumM.body?.totals);
    // The documented trap, asserted so nobody re-introduces a row-count check.
    check('  …row COUNT is identical for both users — proof a row-count assertion would prove nothing',
      rowsOf(sumM).length === rowsOf(sumG).length && rowsOf(sumM).length > 0,
      { restricted: rowsOf(sumM).length, global: rowsOf(sumG).length });

    const colM = await rpt(M, 'collections'), colG = await rpt(G, 'collections'), colB = await rpt(G, 'collections', { branchId: I.B2 });
    check(`collections total: restricted ${colM.body?.totals?.total} = ${PAY_A}, global ${colG.body?.totals?.total} = ${PAY_ALL}`,
      Number(colM.body?.totals?.total) === PAY_A && Number(colG.body?.totals?.total) === PAY_ALL
      && Number(colB.body?.totals?.total) === PAY_B, {
        A: colM.body?.totals?.total, B: colB.body?.totals?.total, all: colG.body?.totals?.total });

    const retM = await rpt(M, 'returns'), retG = await rpt(G, 'returns');
    check(`returns report total: restricted ${retM.body?.totals?.total} = ${E.B1.refunds_out}, global ${retG.body?.totals?.total} = ${E.TOTAL.refunds_out}`,
      Number(retM.body?.totals?.total) === E.B1.refunds_out && Number(retG.body?.totals?.total) === E.TOTAL.refunds_out,
      { A: retM.body?.totals?.total, all: retG.body?.totals?.total });
    check('  …and no branch-B return number appears in the restricted report',
      disjoint(rowsOf(retM).map((x) => String(x.return_number)), RET_B), rowsOf(retM).map((x) => x.return_number));
    // Two product surfaces over the SAME rows, same user, same filters: whatever
    // the right number is, they must agree on it. Asserting them against each
    // other (rather than against a constant) means a disagreement cannot be this
    // suite's arithmetic — it is the product contradicting itself.
    check('sales-summary\'s returns line agrees with the returns REPORT for the same user and filters',
      Number(sumM.body?.totals?.returns) === Number(retM.body?.totals?.total)
      && Number(sumG.body?.totals?.returns) === Number(retG.body?.totals?.total), {
        restricted: { summary: sumM.body?.totals?.returns, report: retM.body?.totals?.total },
        global: { summary: sumG.body?.totals?.returns, report: retG.body?.totals?.total },
      });

    // A report whose predicate has to live INSIDE a derived table — outside it,
    // every branch has already been summed into the cashier's row.
    const cashM = await rpt(M, 'sales-by-cashier'), cashG = await rpt(G, 'sales-by-cashier');
    const cashB = await rpt(G, 'sales-by-cashier', { branchId: I.B2 });
    check(`sales-by-cashier partitions: A ${cashM.body?.totals?.total} + B ${cashB.body?.totals?.total} = all ${cashG.body?.totals?.total}`,
      Number(cashM.body?.totals?.total) + Number(cashB.body?.totals?.total) === Number(cashG.body?.totals?.total)
      && Number(cashM.body?.totals?.total) !== Number(cashG.body?.totals?.total),
      { A: cashM.body?.totals?.total, B: cashB.body?.totals?.total, all: cashG.body?.totals?.total });
    const prodM = await rpt(M, 'sales-by-product'), prodG = await rpt(G, 'sales-by-product');
    const prodB = await rpt(G, 'sales-by-product', { branchId: I.B2 });
    check(`sales-by-product partitions: A ${prodM.body?.totals?.net} + B ${prodB.body?.totals?.net} = all ${prodG.body?.totals?.net}`,
      Number(prodM.body?.totals?.net) + Number(prodB.body?.totals?.net) === Number(prodG.body?.totals?.net)
      && Number(prodM.body?.totals?.net) !== Number(prodG.body?.totals?.net),
      { A: prodM.body?.totals?.net, B: prodB.body?.totals?.net, all: prodG.body?.totals?.net });

    // ── 6. the export path must equal the screen path ───────────────────────
    console.log('\n▶ 6 · CSV export vs the screen, compared to EACH OTHER');
    for (const [type, screen] of [['sales-summary', sumM], ['returns', retM], ['collections', colM]]) {
      const file = await csv(M, type);
      check(`${type}/export answers 200 text/csv`, file.status === 200 && /text\/csv/.test(file.type), { status: file.status, type: file.type });
      // Re-encode the JSON the SCREEN returned with the server's own encoder and
      // demand the bytes match. Nothing here is a constant: if the export took a
      // different scope the two payloads diverge, and if the screen leaked the
      // export leaks identically and BOTH are caught by §5 above.
      check(`  …${type} CSV is byte-identical to the screen payload re-encoded by the real toCsv`,
        file.raw === H.toCsv(screen.body.data, screen.body.columns),
        { csvLen: file.raw.length, rebuiltLen: H.toCsv(screen.body.data, screen.body.columns).length });
    }
    const retCsvM = await csv(M, 'returns'), retCsvG = await csv(G, 'returns');
    check('the restricted export differs from the global export (an export that ignored scope would be identical)',
      retCsvM.raw !== retCsvG.raw && retCsvM.raw.length < retCsvG.raw.length,
      { restricted: retCsvM.raw.length, global: retCsvG.raw.length });
    check('  …the global CSV names the branch-B return; the restricted CSV does not',
      retCsvG.raw.indexOf(RET_B[0]) !== -1 && retCsvM.raw.indexOf(RET_B[0]) === -1);
    // Same question asked of the forged filter: an export is the easiest place
    // to go around whatever the screen enforces, so it is asked there too.
    const colCsvForge = await csv(M, 'collections', { branchId: I.B2 });
    check(`the restricted collections export, even asking for branch B, carries neither ${PAY_IDS_B[0]} nor its ${PAY_B}`,
      colCsvForge.status === 200 && colCsvForge.raw.indexOf(PAY_IDS_B[0]) === -1
      && colCsvForge.raw.indexOf(String(PAY_B)) === -1, colCsvForge.raw.slice(0, 200));

    // ── 7. zero grants → nothing, never everything ──────────────────────────
    console.log('\n▶ 7 · a user with ZERO grants (fail-closed)');
    const zi = await listInv(Z), zp = await listPay(Z), zr = await listRet(Z);
    check('zero-grant lists answer 200 with zero rows and total 0 — never an error, never everything',
      [zi, zp, zr].every((x) => x.status === 200 && rowsOf(x).length === 0 && totalOf(x) === 0),
      [zi, zp, zr].map((x) => ({ s: x.status, n: rowsOf(x).length, t: totalOf(x) })));
    for (const type of ['sales-summary', 'collections', 'returns', 'sales-by-cashier', 'sales-by-product']) {
      const zrep = await rpt(Z, type);
      check(`  …${type} answers 200 with every figure zero`, zrep.status === 200 && sumTotals(zrep) === 0, zrep.body?.totals);
    }
    const zById = await call('GET', `${O2C}/invoices/${encodeURIComponent(I.D1)}`, Z);
    check('  …and even a branch-A id is 404 for a user with no grants', zById.status === 404, zById.status);
    const zCsv = await csv(Z, 'returns');
    check('  …the export is empty too (a header row and nothing else)',
      zCsv.status === 200 && zCsv.raw === H.toCsv([], (await rpt(Z, 'returns')).body.columns), zCsv.raw);

    // ── 8. the analytics engine holds the same line ─────────────────────────
    console.log('\n▶ 8 · /api/analytics/query');
    const ABASE = () => ({
      metrics: ['net_ex_vat', 'orders'], dimensions: ['branch'], range: R,
      filters: [{ dimension: 'branch', op: 'in', values: [I.B1, I.B2] }],
    });
    const aG = await AQ(G, ABASE()), aM = await AQ(M, ABASE()), aZ = await AQ(Z, ABASE());
    check('analytics answers 200 for all three users', [aG, aM, aZ].every((x) => x.status === 200), [aG, aM, aZ].map((x) => x.status));
    check(`analytics global net = ${E.TOTAL.net_ex_vat} over both branches`,
      (aG.body?.data?.rows || []).length === 2 && aG.body?.data?.totals?.values?.net_ex_vat === E.TOTAL.net_ex_vat,
      aG.body?.data?.totals);
    check(`analytics restricted net = ${E.B1.net_ex_vat} over branch A only`,
      (aM.body?.data?.rows || []).length === 1
      && String(aM.body.data.rows[0].keys.branch) === I.B1
      && aM.body?.data?.totals?.values?.net_ex_vat === E.B1.net_ex_vat, aM.body?.data?.totals);
    check('analytics figures partition the same way the O2C reports do',
      aG.body.data.totals.values.net_ex_vat === aM.body.data.totals.values.net_ex_vat + E.B2.net_ex_vat);
    const aForge = await AQ(M, Object.assign(ABASE(), { filters: [{ dimension: 'branch', op: 'eq', value: I.B2 }] }));
    check('analytics + a hand-forced branch-B filter → empty rows, zero totals',
      aForge.status === 200 && (aForge.body?.data?.rows || []).length === 0
      && aForge.body?.data?.totals?.values?.net_ex_vat === 0, aForge.body?.data?.totals);
    check('analytics zero-grant → empty rows, zero totals (never everything)',
      (aZ.body?.data?.rows || []).length === 0 && aZ.body?.data?.totals?.values?.net_ex_vat === 0, aZ.body?.data);
  } finally {
    server.kill();
  }
}

(async () => {
  let crashed = null;
  // Before anything: a run killed mid-way must not fail this one on a UNIQUE id.
  await cleanupAll();
  // Baseline AFTER the opening cleanup, so it measures THIS run only.
  const baseline = await tableCounts();
  try {
    await main();
  } catch (e) {
    crashed = e;
    console.error('INTEGRATION ERROR:', (e && e.stack) || e);
  } finally {
    try {
      await cleanupAll();
      const d = drift(baseline, await tableCounts());
      if (d.length) { fail++; console.error('  ❌ RESIDUE after cleanup:', d.join(' | ')); }
      else { pass++; console.log('  ✅ zero residue: all', COUNTED_TABLES.length, 'table counts identical to baseline'); }
    } catch (e) {
      fail++;
      console.error('  ❌ CLEANUP FAILED (not swallowed):', (e && e.message) || e);
    }
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 && !crashed ? '✅' : '❌'} salesScopeLive: ${pass} passed, ${fail} failed`);
  if (fails.length) console.log('   failed:', fails.join(' | '));
  process.exit(fail || crashed ? 1 : 0);
})();
