/**
 * The cash-chain period totals.
 * Run: node tests/analyticsCashChain.test.js
 *
 * WHAT A SUMMARY CAN DO THAT A TABLE CANNOT
 *   The reconciliation grid already carried every figure in the chain; the
 *   chain just reads them down instead of across. That makes it strictly more
 *   dangerous, because a summary is believed without being checked. Two ways
 *   it could lie, both guarded here:
 *
 *   1. NOT ADDING UP. The chain prints its operands and then an "expected
 *      cash" line beneath them. If the operand list omits one — `pay_in` was
 *      missing from the first draft — the reader sees a column that visibly
 *      fails to sum. So the operand set is checked against the SAME equation
 *      the service uses (equations.expectedCash), not against a copy of it.
 *
 *   2. COUNTING AN UNCOUNTED DRAWER AS EMPTY. `counted` is null on a day
 *      nobody counted the till, and the per-row contract has always been
 *      careful about that. A period sum that folds null into 0 would report a
 *      whole month of uncounted drawers as "counted: 0.00" and produce a
 *      variance equal to the entire expected cash — an alarming number with no
 *      cause. The totals keep null meaning "never measured".
 *
 * Driven through the REAL service with a fake db, so the accumulation under
 * test is the shipping one.
 */
'use strict';

const ReconciliationService = require('../services/analytics/ReconciliationService');
const equations = require('../lib/analytics/equations');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve().then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} — expected ${b}, got ${a}`); }

const SCOPE = { caps: new Set(['analytics.reconciliation.view']), all: true, branchIds: [] };

/**
 * Two days on one branch.
 *   D1 — drawer counted, everything present.
 *   D2 — drawer NEVER counted (no close_count row).
 */
const SALES = [
  { d: '2026-07-01', b: 'BR1', orders: 10, invoice_total: 1000 },
  { d: '2026-07-02', b: 'BR1', orders: 8, invoice_total: 800 },
];
const PAYMENTS = [
  { d: '2026-07-01', b: 'BR1', pin: 900, pout: 50 },
  { d: '2026-07-02', b: 'BR1', pin: 800, pout: 0 },
];
const TILL = [
  { d: '2026-07-01', b: 'BR1', open_float: 200, cash_sale: 600, cash_refund: 40, pay_in: 30, pay_out: 25, deposit: 500, close_amt: 265, close_rows: 1 },
  { d: '2026-07-02', b: 'BR1', open_float: 265, cash_sale: 400, cash_refund: 0, pay_in: 0, pay_out: 10, deposit: 300, close_amt: 0, close_rows: 0 },
];

function makeDb() {
  const answer = (sql) => {
    if (/analytics_order_facts f\b[\s\S]*JOIN ar_documents/.test(sql) && /COUNT\(\*\) AS orders/.test(sql)) {
      return [SALES.map((r) => ({ d: r.d, b: r.b, orders: r.orders, invoice_total: r.invoice_total }))];
    }
    if (/analytics_payment_facts p/.test(sql) && /GROUP BY/.test(sql) && !/document_id IS NULL/.test(sql)) {
      return [PAYMENTS.map((r) => ({ d: r.d, b: r.b, pin: r.pin, pout: r.pout, in: r.pin, out: r.pout }))];
    }
    if (/analytics_till_facts t/.test(sql)) {
      return [TILL.map((r) => ({ ...r }))];
    }
    return [[]]; // drill id lists + exception probes
  };
  return { DB_TIME_ZONE: '+03:00', query: async (sql) => answer(String(sql)) };
}

(async () => {
  const res = await ReconciliationService.threeWay(makeDb(), {
    scope: SCOPE, from: '2026-07-01', to: '2026-07-02',
  });
  const T = res.totals;

  await test('the chain movements are summed over the period', () => {
    eq(T.open_float, 465, 'opening float');
    eq(T.cash_sale, 1000, 'cash sales');
    eq(T.cash_refund, 40, 'cash refunds');
    eq(T.pay_in, 30, 'pay-ins');
    eq(T.pay_out, 35, 'pay-outs');
    eq(T.deposit, 800, 'deposits');
  });

  await test('the printed operands really do produce the printed expected cash', () => {
    // NOT a re-implementation: the SAME equation the service uses, fed the
    // SAME lines the chain renders. `pay_in` was missing from the first draft
    // of the chain, which would have shown a column that does not add up.
    const fromChain = equations.expectedCash(
      T.open_float, T.cash_sale, T.cash_refund, T.pay_in, T.pay_out + T.deposit,
    );
    eq(T.expected_cash, fromChain,
      'the expected-cash total is not what the chain lines above it sum to');
  });

  await test('an UNCOUNTED drawer never becomes a counted-and-empty one', () => {
    // D1 counted 265, D2 never counted. The total must be 265 — the sum of
    // what WAS measured — and never 265 + 0 dressed up as a full period count.
    eq(T.counted, 265, 'counted total');
  });

  await test('a period with NO count at all reports null, not zero', async () => {
    // Folding null into 0 here would print a variance equal to the entire
    // expected cash: a large, alarming, causeless number.
    const noCount = TILL.map((r) => ({ ...r, close_rows: 0, close_amt: 0 }));
    const db = { DB_TIME_ZONE: '+03:00', query: async (sql) => {
      const s = String(sql);
      if (/analytics_till_facts t/.test(s)) return [noCount];
      return makeDb().query(s);
    } };
    const r2 = await ReconciliationService.threeWay(db, {
      scope: SCOPE, from: '2026-07-01', to: '2026-07-02',
    });
    eq(r2.totals.counted, null, 'counted with no close_count anywhere');
    ok(r2.totals.expected_cash !== null, 'expected cash is still computable');
  });

  await test('the chain agrees with the row detail beneath it', () => {
    // The one failure a summary must not have: disagreeing with the table it
    // sits above. Sum the rows independently and compare.
    const sum = (pick) => res.rows.reduce((a, r) => a + (pick(r) || 0), 0);
    eq(T.invoice_total, sum((r) => r.sales.invoice_total), 'invoiced');
    eq(T.payments_in, sum((r) => r.payments.in), 'received');
    eq(T.payments_out, sum((r) => r.payments.out), 'refunded');
    eq(T.deposit, sum((r) => r.till.deposit), 'deposits');
  });

  console.log(`\nAnalytics cash chain: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
})();
