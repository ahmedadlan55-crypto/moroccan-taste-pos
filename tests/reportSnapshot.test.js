#!/usr/bin/env node
'use strict';
/**
 * A printed report is the whole report, or it is refused.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 * The Orders report reads the operational invoice list, which is capped at 200
 * rows per page. Printing it printed THAT PAGE — under a totals row computed
 * over every matching invoice. The person holding the paper sees a total of
 * 4,812 orders above a table of 200 and has no way to tell, because a report
 * that believes it is complete prints no "page 1 of 25".
 *
 * ─── WHAT IS PINNED HERE ────────────────────────────────────────────────────
 *   1. `?snapshot=1` returns the WHOLE filtered set, not a page.
 *   2. Beyond the limit it answers **413** — never a short set with a 200.
 *   3. The refusal states the REAL total, not just "too large". A user cannot
 *      act on "narrow the filters" without knowing by how much.
 *   4. Overflow is DETECTED with a probe row, not inferred from a full page —
 *      "exactly full" and "there is more" are otherwise indistinguishable, and
 *      guessing wrong labels a truncated set complete.
 */

const path = require('path');
const SNAP = require('../lib/reportSnapshot');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }

// ── The primitives ─────────────────────────────────────────────────────────
{
  eq('?snapshot=1 is a snapshot', SNAP.wantsSnapshot({ snapshot: '1' }), true);
  eq('?snapshot=true is a snapshot', SNAP.wantsSnapshot({ snapshot: 'true' }), true);
  eq('absent is not a snapshot', SNAP.wantsSnapshot({}), false);
  eq('?snapshot=0 is not a snapshot', SNAP.wantsSnapshot({ snapshot: '0' }), false);
  // A query string carries strings; `false` must not read as truthy.
  eq('?snapshot=false is not a snapshot', SNAP.wantsSnapshot({ snapshot: 'false' }), false);

  // The probe fetches limit+1 so overflow is proven, not guessed.
  eq('the probe asks for one row more than the limit', SNAP.probeSize(5000), 5001);
  eq('exactly at the limit is NOT overflow', SNAP.overflowed(new Array(5000), 5000), false);
  eq('one past the limit IS overflow', SNAP.overflowed(new Array(5001), 5000), true);
}

// ── The service, driven for real ───────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
function stub(rel, exports) {
  const resolved = require.resolve(path.join(ROOT, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Rows come back in whatever quantity the LIMIT asked for, so the service's own
// paging arithmetic is what is under test.
let lastLimit = null;
let available = 0;
stub('db/connection.js', {
  query: async (sql, args) => {
    if (/COUNT\(\*\) AS total/.test(sql)) {
      return [[{ total: available, net_ex_vat: 0, invoice_total: 0, avg_ticket: null }]];
    }
    lastLimit = args[args.length - 2];
    const n = Math.min(available, lastLimit);
    return [Array.from({ length: n }, (_, i) => ({ id: 'INV-' + i }))];
  },
});
stub('lib/salesScope.js', {
  effectiveScope: async () => ({ all: true, branchIds: [] }),
  branchClause: () => ({ sql: '', params: [] }),
  filterPage: async (_db, _scope, _table, rows) => ({ rows, dropped: 0 }),
});

const InvoiceService = require(path.join(ROOT, 'services', 'order-to-cash', 'InvoiceService.js'));

(async () => {
  try {
    // 1. Ordinary paging is untouched.
    available = 4000;
    let out = await InvoiceService.list({ page: 1, pageSize: 25 });
    eq('a normal request pages at the requested size', out.data.length, 25);
    eq('a normal request keeps its pagination', out.pagination.pageSize, 25);
    check('a normal request is not marked a snapshot', !out.pagination.snapshot);

    // 2. Snapshot returns the WHOLE set, not a page.
    out = await InvoiceService.list({ snapshot: '1' });
    eq('a snapshot returns every matching row', out.data.length, 4000);
    eq('a snapshot probes one past the limit', lastLimit, SNAP.REPORT_SNAPSHOT_LIMIT + 1);
    eq('a snapshot declares itself', out.pagination.snapshot, true);
    eq('a snapshot asserts completeness', out.pagination.complete, true);
    eq('a snapshot reports its row count', out.pagination.rowCount, 4000);
    // A complete document has no pages; a pager rendered over it is a lie.
    eq('a snapshot is a single page', out.pagination.totalPages, 1);

    // 3. The boundary. Exactly at the limit must still succeed — an off-by-one
    //    here refuses a report that fits.
    available = SNAP.REPORT_SNAPSHOT_LIMIT;
    out = await InvoiceService.list({ snapshot: '1' });
    check('exactly at the limit is delivered, not refused', !out.tooLarge, out.tooLarge);
    eq('exactly at the limit delivers every row', out.data.length, SNAP.REPORT_SNAPSHOT_LIMIT);

    // 4. One past it is refused, with the real number.
    available = SNAP.REPORT_SNAPSHOT_LIMIT + 1;
    out = await InvoiceService.list({ snapshot: '1' });
    eq('one past the limit is refused', out.tooLarge, true);
    eq('the refusal states the true total', out.total, SNAP.REPORT_SNAPSHOT_LIMIT + 1);
    eq('the refusal states the limit', out.limit, SNAP.REPORT_SNAPSHOT_LIMIT);
    eq('the refusal carries no rows', out.data.length, 0);

    // 5. The 413 body a route sends.
    const sent = {};
    const res = { status(c) { sent.status = c; return this; }, json(b) { sent.json = b; return this; } };
    SNAP.tooLarge(res, 5001, SNAP.REPORT_SNAPSHOT_LIMIT);
    eq('overflow is 413, not 200', sent.status, 413);
    eq('413 names a machine code', sent.json.code, 'REPORT_TOO_LARGE');
    eq('413 carries the total so the user can narrow by a known amount', sent.json.total, 5001);
    eq('413 carries the limit', sent.json.limit, SNAP.REPORT_SNAPSHOT_LIMIT);
  } catch (error) {
    failures.push('threw: ' + ((error && error.stack) || error));
    console.error(error);
  }

  if (failures.length) {
    console.error('\n' + failures.length + ' failure(s):');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('  ✅ snapshot: the whole report or a 413 that says how much too big');
  console.log(pass + '/' + pass + ' passed');
})();
