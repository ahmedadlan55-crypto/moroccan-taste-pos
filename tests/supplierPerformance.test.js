#!/usr/bin/env node
'use strict';
/**
 * Supplier OTIF scorecard.
 *
 * ─── WHY IT EXISTS NOW ──────────────────────────────────────────────────────
 * Declared unbuildable "because the source data does not exist". Wrong:
 * `purchase_orders.expected_date` and `po_lines.received_qty` have always been
 * there, which is On-Time and In-Full — i.e. OTIF.
 *
 * ─── THE ARITHMETIC TRAP THIS PINS ──────────────────────────────────────────
 * OTIF is measured per LINE and must be counted per line. It is NOT
 * on_time% × in_full%. A supplier that is late on half its lines and short on
 * the OTHER half scores 50% × 50% = 25% that way, when the truth is 0% — not
 * one line was both on time and in full. The two answers differ by the
 * correlation between the failures, which a product of margins throws away.
 *
 * ─── AND THE DENOMINATOR TRAP ───────────────────────────────────────────────
 * `expected_date` is nullable. A line with no promised date cannot be late, so
 * it leaves the on-time denominator. Counting it as on-time flatters every
 * supplier the buyer forgot to give a date to; counting it as late punishes
 * them for the buyer's omission.
 */

const path = require('path');
const http = require('http');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }

const ROOT = path.join(__dirname, '..');
function stub(rel, exports) {
  const resolved = require.resolve(path.join(ROOT, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// SUP-A — the correlation case, and the whole reason this test exists.
//   4 lines: 2 on-time-but-short, 2 in-full-but-late.
//   on_time = 2/4 = 50%   in_full = 2/4 = 50%   OTIF = 0/4 = 0%
//   The product of the margins would say 25%. The truth is 0%.
// SUP-B — 2 lines, both perfect, plus 1 line with NO promised date.
//   on_time = 2/2 = 100% (the promise-less line is out of the denominator)
//   in_full = 3/3 = 100%   OTIF = 2/3
const ROWS = [
  {
    supplier_id: 'SUP-A', supplier_name: 'مورد أ',
    lines_total: 4, lines_with_promise: 4, lines_without_promise: 0,
    lines_in_full: 2, lines_on_time: 2, lines_otif: 0,
    orders: 2, ordered_qty: 100, received_qty: 60, avg_delay_days: 3.5,
  },
  {
    supplier_id: 'SUP-B', supplier_name: 'مورد ب',
    lines_total: 3, lines_with_promise: 2, lines_without_promise: 1,
    lines_in_full: 3, lines_on_time: 2, lines_otif: 2,
    orders: 1, ordered_qty: 30, received_qty: 30, avg_delay_days: -1,
  },
];

const seen = [];
stub('db/connection.js', {
  query: async (sql) => {
    seen.push(String(sql));
    return /FROM purchase_orders/.test(String(sql)) ? [ROWS] : [[]];
  },
});
stub('middleware/requireCapability.js', Object.assign(
  () => (_req, _res, next) => next(),
  { hasCapability: async () => true },
));

const express = require(path.join(ROOT, 'node_modules', 'express'));
const app = express();
app.use((req, _res, next) => {
  req.user = { username: 't' };
  req.warehouseScope = { all: true, warehouseIds: [] };
  req.requestId = 'test';
  next();
});
app.use('/r', require(path.join(ROOT, 'routes', 'procurement', 'reports.js')));

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ port: server.address().port, path: '/r/supplier-performance?from=2026-01-01&to=2026-01-31' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(b) }));
      }).on('error', reject);
    });
    eq('answers 200', res.status, 200);
    const a = res.json.data.find((r) => r.supplier_id === 'SUP-A');
    const b = res.json.data.find((r) => r.supplier_id === 'SUP-B');

    // ── The correlation case ───────────────────────────────────────────────
    eq('SUP-A on-time is 50%', a.on_time_pct, 50);
    eq('SUP-A in-full is 50%', a.in_full_pct, 50);
    eq('SUP-A OTIF is ZERO — no line was both', a.otif_pct, 0);
    const product = Math.round((a.on_time_pct / 100) * (a.in_full_pct / 100) * 10000) / 100;
    check('OTIF is not the product of the two margins', a.otif_pct !== product,
      { otif: a.otif_pct, productOfMargins: product });

    // ── The denominator case ───────────────────────────────────────────────
    // 2 on-time out of the 2 lines that CARRIED a promise — not out of 3.
    eq('on-time excludes lines with no promised date', b.on_time_pct, 100);
    eq('in-full counts every line', b.in_full_pct, 100);
    eq('OTIF counts every line', b.otif_pct, 66.67);
    eq('lines without a promise are reported, not hidden', b.lines_without_promise, 1);
    // An early delivery keeps its negative delay; dropping the sign would
    // report a supplier who is consistently early as if it were on the day.
    eq('an early supplier shows a negative delay', b.avg_delay_days, -1);

    // ── Totals are recomputed from counts, not averaged from percentages ───
    const t = res.json.totals;
    eq('lines roll up', t.lines_total, 7);
    // 2/7 lines were OTIF = 28.57%. The mean of the two supplier percentages
    // would be (0 + 66.67)/2 = 33.34% — which weights a 3-line supplier the
    // same as a 4-line one.
    eq('total OTIF is line-weighted', t.otif_pct, 28.57);
    const meanOfSuppliers = Math.round(((a.otif_pct + b.otif_pct) / 2) * 100) / 100;
    check('total OTIF is not the mean of supplier percentages', t.otif_pct !== meanOfSuppliers,
      { weighted: t.otif_pct, mean: meanOfSuppliers });
    // 4 on-time over the 6 promised lines, not over 7.
    eq('total on-time uses the promised-line denominator', t.on_time_pct, 66.67);

    // Quality (accepted vs rejected) has no columns anywhere. Declared absent
    // rather than approximated from returns, which measure something else.
    eq('supplier quality rate is declared unavailable', t.qualityRateAvailable, false);

    // ── The status filter, read off the EXECUTED statement ────────────────
    // The fake pool ignores SQL, so no fixture can exercise a WHERE clause.
    // This reads the statement the handler actually issued.
    //
    // The first version of this report allow-listed
    // ('approved','sent','partially_received') — copied from the open-orders
    // report — and so omitted `fully_received`, which on the live database is
    // the state of every COMPLETED order. A delivery scorecard that excludes
    // completed deliveries silently returns nothing, and an empty scorecard
    // reads as "no problems".
    const sql = seen.find((q) => /FROM purchase_orders/.test(q)) || '';
    check('the query EXCLUDES what was never a promise, rather than allow-listing states',
      /status\s+NOT\s+IN\s*\(\s*'draft'\s*,\s*'cancelled'\s*\)/i.test(sql), sql.slice(0, 240));
    check('it does not allow-list statuses (which would drop fully_received)',
      !/po\.status\s+IN\s*\(/i.test(sql), sql.slice(0, 240));
  } catch (error) {
    failures.push('threw: ' + ((error && error.stack) || error));
    console.error(error);
  } finally {
    server.close();
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ OTIF counted per line, promise-less lines out of the on-time denominator');
  console.log(pass + '/' + pass + ' passed');
})();
