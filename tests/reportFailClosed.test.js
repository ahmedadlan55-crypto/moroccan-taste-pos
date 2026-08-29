#!/usr/bin/env node
'use strict';
/**
 * A financial report that cannot be produced must FAIL, not report zero.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * Every statement in this system used to answer a database fault with
 * `res.json({ …all zeros…, degraded: true })`. `res.json` without `res.status`
 * is **HTTP 200**, so a broken query did not fail — it reported that the
 * company earned nothing, owned nothing and was owed nothing. The browser saw
 * 200, react-query cached it as data, the page rendered, and the figures
 * printed onto paper somebody signs.
 *
 * The `degraded` flag did not save it: a flag only works if every reader checks
 * it, and no reader was obliged to. An all-zero balance sheet lived undetected
 * on main for exactly this reason — the endpoint never failed.
 *
 * ─── WHY THESE ASSERTIONS ARE SHAPED THIS WAY ───────────────────────────────
 * Asserting `status === 500` alone is not enough. The regression that matters
 * is the BODY: a handler could answer 500 and still ship a zero-filled
 * statement, and a client that reads `data.netIncome` before checking the
 * status would carry on. So each case asserts three separable things:
 *   1. the status is a failure,
 *   2. no financial field is present at all — not "present and zero",
 *   3. the driver's own message never reaches the client.
 *
 * (3) is a real leak, not hygiene: `e.message` from mysql2 carries table names,
 * column names and fragments of the failing SQL, and `cash-flow` used to return
 * it verbatim to the browser.
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

// The exact text the fake driver throws. It must never appear in a response.
const SECRET = "Unknown column 'gl_entries.super_secret_column' in 'field list'";

function stub(relative, exports) {
  const resolved = require.resolve(path.join(ROOT, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Every query fails. This is the whole point: the handler must have no path
// that turns a dead database into a statement.
stub('db/connection.js', {
  query: async () => { throw new Error(SECRET); },
  execute: async () => { throw new Error(SECRET); },
  getConnection: async () => { throw new Error(SECRET); },
});
stub('middleware/requireCapability.js', Object.assign(
  () => (_req, _res, next) => next(),
  { hasCapability: async () => true },
));

const express = require(path.join(ROOT, 'node_modules', 'express'));

const app = express();
app.use((req, _res, next) => {
  req.user = { username: 'test', role: 'admin' };
  // The real server sets this and echoes it on X-Request-Id; the contract is
  // that the id the user sees is the id in the log.
  req.requestId = 'req-fixed-for-test';
  next();
});
app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'income.js')));
app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'balance-sheet.js')));
app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'cash-flow.js')));
app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'ar-aging.js')));

function get(server, url) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: url }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: body }));
    }).on('error', reject);
  });
}

// Any of these appearing in a failure body means a statement was fabricated.
const MONEY_FIELDS = [
  'netIncome', 'totalRevenue', 'grossProfit', 'operatingIncome', 'totalCOGS',
  'totalAssets', 'totalLiabilities', 'totEq', 'totCA', 'isBalanced',
  'netChange', 'cashOpening', 'cashClosing', 'grandTotal',
];

const CASES = [
  ['income statement', '/api/erp/reports/income?startDate=2026-01-01&endDate=2026-01-31'],
  ['balance sheet', '/api/erp/reports/balance-sheet-ifrs?asOfDate=2026-01-31'],
  ['cash flow', '/api/erp/reports/cash-flow-ias7?from=2026-01-01&to=2026-01-31'],
  ['A/R ageing', '/api/erp/reports/ar-aging?asOfDate=2026-01-31'],
];

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    for (const [label, url] of CASES) {
      const res = await get(server, url);

      // 1. It must fail. A 200 here is the entire defect.
      check(label + ': answers a failure status, not 200', res.status >= 500,
        { status: res.status, body: res.raw.slice(0, 160) });

      let body = {};
      try { body = JSON.parse(res.raw); } catch (_) { /* asserted below */ }

      // 2. No fabricated statement. Note this checks ABSENCE, not zero-ness:
      //    `netIncome: 0` and no `netIncome` at all are different answers, and
      //    only the second one is honest about a dead source.
      const fabricated = MONEY_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
      check(label + ': ships no financial field at all', fabricated.length === 0, fabricated);

      // The old shape's tell-tale. If this ever returns, the zeros came back.
      check(label + ': no `degraded` flag standing in for a status code',
        !Object.prototype.hasOwnProperty.call(body, 'degraded'), body.degraded);

      // 3. The driver's message must not cross the wire.
      check(label + ': does not leak the database error text',
        res.raw.indexOf('super_secret_column') === -1, res.raw.slice(0, 200));
      check(label + ': does not leak any part of the driver message',
        res.raw.indexOf(SECRET) === -1);

      // 4. The user gets something to quote, and it is the request id the
      //    server logged under — not a second, unrelated identifier.
      eq(label + ': carries the request id as the support reference',
        body.correlationId, 'req-fixed-for-test');
      eq(label + ': is explicitly unsuccessful', body.success, false);
      eq(label + ': carries a stable machine code', body.code, 'REPORT_FAILED');
    }

    // ── Validation is a 4xx, not a statement of zero ─────────────────────────
    {
      const res = await get(server, '/api/erp/reports/cash-flow-ias7');
      check('missing date range is a client error, not 200', res.status === 422,
        { status: res.status, body: res.raw.slice(0, 160) });
      const body = JSON.parse(res.raw);
      eq('missing range names its cause', body.code, 'RANGE_REQUIRED');
      // The old code answered 200 with `{error:'from + to required'}`, so every
      // caller rendered "you forgot the dates" as a cash-flow statement.
      check('missing range ships no statement', !Object.prototype.hasOwnProperty.call(body, 'operating'));
    }
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
  console.log('  ✅ a dead source fails loudly: no zeros, no leak, one quotable reference');
  console.log(pass + '/' + pass + ' passed');
})();
