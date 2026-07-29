/**
 * A derived metric whose inputs live on DIFFERENT facts — end to end through
 * the real engine. Run: node tests/analyticsTwoFactDerived.test.js
 *
 * WHY THIS EXISTS
 *   Every frontend test in this sprint mocks the API boundary: it hands the
 *   page a canned `net_vat` and checks the page renders it. Not one of them
 *   proves the SERVER can produce that number. And `net_vat` is the first
 *   metric that genuinely spans two facts:
 *
 *     vat_amount   → the `line` fact
 *     returns_vat  → the `return` fact
 *
 *   The planner emits ONE statement per fact and QueryService merges them on
 *   the dimension key. So a (category, rate) that had sales but no returns is
 *   present in the line statement and ABSENT from the return statement, and
 *   vice versa.
 *
 * WHAT THIS ACTUALLY GUARDS — established by mutation, not by assumption
 *   The obvious worry is arithmetic: netVat(1500, undefined) going NaN. It
 *   cannot. `toMinor` maps every non-finite value to 0 (equations.js:34), and
 *   QueryService zero-fills merged rows on top of that. Removing the zero-fill
 *   entirely leaves this file at 6/6 — so an assertion sold as "guards the NaN"
 *   would be guarding nothing, and saying so would mislead the next reader.
 *
 *   What DOES break is the MERGE. Making it augment only keys the first fact
 *   already produced — the "sales LEFT JOIN returns" mistake written in code —
 *   fails two of these tests. That is the real defect class: whole rows
 *   silently missing from a tax report. A returns-only bucket (a refund of
 *   something not sold this period) disappears, and the credit is never filed.
 *   No mocked-API test can see it, because the mock IS the merged result.
 *
 * HOW IT RUNS WITHOUT A DATABASE
 *   `QueryService.run(db, …)` takes its db as an argument, so a FAKE db that
 *   answers `query(sql, params)` with canned column rows drives the REAL
 *   planner, the REAL cross-fact merge, the REAL zero-fill and the REAL
 *   derived-metric computation. Only the SQL execution is stubbed; every line
 *   of engine logic under test is the shipping one.
 *
 *   The fake answers on the shape the planner actually asked for: it reads the
 *   emitted SQL to decide which fact's statement it is, so a change to the
 *   planner's aliasing shows up here as a failure rather than a silent pass.
 */
'use strict';

const QueryService = require('../services/analytics/QueryService');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  return Promise.resolve()
    .then(fn)
    .then(() => { _passed++; console.log('  ✅', name); })
    .catch((e) => { _failed++; console.log('  ❌', name); console.log('     ', e.message); });
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${expected}, got ${actual}`);
}

const SCOPE = { caps: new Set(['analytics.view']), branchIds: null, brandIds: null };

/**
 * Canned fact rows, in the engine's own column contract:
 *   d0, d1, …  the dimension values, in request order
 *   m_<id>     one column per metric the statement computes
 *
 * The two facts deliberately do NOT cover the same keys:
 *   ('standard','15') — sales AND returns
 *   ('standard','5')  — returns ONLY  (a refund of something not sold this period)
 *   ('zero','0')      — sales ONLY    (the ordinary case: no refunds this month)
 */
const LINE_ROWS = [
  { d0: 'standard', d1: '15', m_vat_amount: 1500, m_net_ex_vat: 10000 },
  { d0: 'zero', d1: '0', m_vat_amount: 0, m_net_ex_vat: 2000 },
];
const RETURN_ROWS = [
  { d0: 'standard', d1: '15', m_returns_vat: 200, m_returns_net: 1333.33 },
  { d0: 'standard', d1: '5', m_returns_vat: 20, m_returns_net: 400 },
];

function sumOf(rows, col) {
  return rows.reduce((a, r) => a + (Number(r[col]) || 0), 0);
}

/** ROLLUP answer: the detail rows plus subtotal/grand rows with GROUPING flags. */
function rollupRows(rows, metricCols) {
  const out = rows.map((r) => ({ ...r, g0: 0, g1: 0 }));
  const grand = { d0: null, d1: null, g0: 1, g1: 1 };
  for (const c of metricCols) grand['m_' + c] = sumOf(rows, 'm_' + c);
  out.push(grand);
  return out;
}

function makeDb() {
  const seen = [];
  const answer = (sql) => {
    seen.push(sql);
    // The planner names the fact table in the FROM clause; that is what
    // distinguishes the two statements, and reading it here means a change to
    // the planner's table aliasing fails this test instead of passing quietly.
    // The real tables are NOT the "analytics_*_facts" pair one would guess:
    //   line   → ar_document_lines d JOIN ar_documents JOIN analytics_order_facts
    //   return → sales_return_lines rl JOIN sales_returns r
    // (registry/facts.js). Guessing wrong made this fake answer LINE rows to
    // BOTH statements, and the test then "found" a merge bug that was its own.
    // Hence the assertion below that both statements really executed.
    if (/analytics_rollup_state|analytics_meal_periods/.test(sql)) return [[]];
    const isReturn = /sales_return_lines/.test(sql);
    const isLine = /ar_document_lines/.test(sql);
    if (!isReturn && !isLine) return [[]];
    const isRollup = /WITH ROLLUP/i.test(sql);
    const rows = isReturn ? RETURN_ROWS : LINE_ROWS;
    const cols = isReturn ? ['returns_vat', 'returns_net'] : ['vat_amount', 'net_ex_vat'];
    return [isRollup ? rollupRows(rows, cols) : rows];
  };
  const conn = {
    connection: { threadId: 1 },
    query: async (sql, params) => answer(String(sql), params),
    release: () => {},
  };
  return {
    DB_TIME_ZONE: '+03:00',
    query: async (sql, params) => answer(String(sql), params),
    getConnection: async () => conn,
    _seen: seen,
  };
}

const REQUEST = {
  metrics: ['vat_amount', 'returns_vat', 'net_vat'],
  dimensions: ['vat_category', 'vat_rate'],
  range: { from: '2026-07-01', to: '2026-07-31' },
  limit: 200,
  noCache: true,
};

/**
 * rows keyed "category|rate" for readable assertions.
 *
 * NOTE the SERVER contract, which is not the page-facing one: run() returns an
 * ENVELOPE { success, data: { rows, totals: { values } } }, each row carries
 * its `keys` as an OBJECT keyed by dimension id (not a positional array), and
 * the totals sit one level down under `.values`. The page-facing array/flat
 * shape is produced by the wire adapter in frontend/erp .../lib/api.ts.
 * Asserting on the real thing is the point — a test written against the
 * adapter shape would be testing the adapter, which every other test in this
 * sprint already mocks.
 */
function byKey(result) {
  const out = {};
  for (const r of result.data.rows) out[`${r.keys.vat_category}|${r.keys.vat_rate}`] = r.values;
  return out;
}

(async () => {
  const db = makeDb();
  const result = await QueryService.run(db, REQUEST, SCOPE);
  const rows = byKey(result);
  const totals = result.data.totals.values;

  await test('the planner really did emit TWO statements — one per fact', () => {
    const line = db._seen.filter((s) => /ar_document_lines/.test(s)).length;
    const ret = db._seen.filter((s) => /sales_return_lines/.test(s)).length;
    ok(line > 0, 'no line-fact statement was executed');
    ok(ret > 0, 'no return-fact statement was executed — the returns side never ran');
  });

  await test('a key with BOTH sides nets correctly: 1500 − 200 = 1300', () => {
    const v = rows['standard|15'];
    ok(v, 'the standard/15 row is missing entirely');
    eq(v.vat_amount, 1500, 'VAT on sales');
    eq(v.returns_vat, 200, 'VAT on returns');
    eq(v.net_vat, 1300, 'net VAT');
  });

  await test('a key with SALES ONLY survives the merge and reads zero on the returns side', () => {
    // The ordinary case: a rate bucket with no refunds this month. It exists in
    // the line statement and NOT in the return statement, so a merge that only
    // augments already-seen keys keeps it — but the mirror case below is the
    // one that vanishes. Both are asserted so the merge is pinned in both
    // directions regardless of which fact the planner happens to run first.
    const v = rows['zero|0'];
    ok(v, 'the zero/0 row is missing — a sales-only key was dropped by the merge');
    eq(v.returns_vat, 0, 'returns_vat must be zero-filled, not absent');
    eq(v.net_vat, 0, 'net VAT');
    ok(!Number.isNaN(v.net_vat), 'net_vat is NaN');  // cheap, and free to keep
  });

  await test('a key with RETURNS ONLY survives the merge and reports a credit', () => {
    // A refund of something not sold in this period. Any "sales LEFT JOIN
    // returns" shape drops this row and the filing understates the credit.
    const v = rows['standard|5'];
    ok(v, 'the returns-only key was dropped — the credit would never be filed');
    eq(v.vat_amount, 0, 'no sales side, zero-filled');
    eq(v.returns_vat, 20, 'the credit');
    eq(v.net_vat, -20, 'net VAT goes negative for a returns-only bucket');
  });

  await test('the period total is the ROLLUP grand, and it nets both facts', () => {
    // 1500 sales VAT − (200 + 20) returns VAT = 1280.
    eq(totals.vat_amount, 1500, 'grand VAT on sales');
    eq(totals.returns_vat, 220, 'grand VAT on returns');
    eq(totals.net_vat, 1280, 'grand net VAT');
  });

  await test('no requested metric comes back undefined', () => {
    for (const [key, v] of Object.entries(rows)) {
      for (const id of REQUEST.metrics) {
        ok(v[id] !== undefined, `row ${key} has undefined ${id}`);
        ok(!Number.isNaN(v[id]), `row ${key} has NaN ${id}`);
      }
    }
  });

  console.log(`\nAnalytics two-fact derived: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
})();
