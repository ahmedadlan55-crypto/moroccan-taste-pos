#!/usr/bin/env node
'use strict';
/**
 * tests/o2cReportScope.test.js — a branch user must not read another branch's
 * Order-to-Cash AGGREGATES. Run: node tests/o2cReportScope.test.js
 *
 * WHAT THIS COVERS THAT tests/salesScopeIsolation.test.js COULD NOT
 *   That file closed and pinned the ROW leak the routers own: detail reads
 *   answer 404, list pages are re-checked against branch_id before they reach
 *   the client. It says plainly what it could not reach — the thirteen report
 *   queries in services/order-to-cash/O2CReportingService.js and the three
 *   list() statements, which live in service files it did not own. An aggregate
 *   cannot be filtered after the fact: by the time the router sees a report
 *   there are no rows left to drop, only sums, so a report "filtered afterwards"
 *   is a report that was never filtered at all. Every number a scoped caller saw
 *   — every total, every ageing bucket, every CSV export — was company-wide.
 *
 * HOW IT PROVES IT
 *   db/connection is replaced in require.cache BEFORE anything requires it, so
 *   the reporting service, the three list services, lib/salesScope's own scope
 *   lookup and the reports ROUTER all talk to one fake that records the exact
 *   SQL and the exact bound params. Every assertion below is about the statement
 *   that would have reached MySQL — not about a mock's return value.
 *
 * THE EXPORT IS ASSERTED AGAINST THE SCREEN, NOT AGAINST A CONSTANT
 *   Section 5 runs the real `GET /reports/:type` and `GET /reports/:type/export`
 *   handlers with the SAME request and compares the two SQL transcripts to each
 *   other. A test that compared the export to a hard-coded predicate would go on
 *   passing after a change that scoped only one of the two paths — and a CSV
 *   that takes a different path from the screen is the obvious way around
 *   whatever the screen enforces.
 *
 * FAIL-CLOSED IS THE POINT, NOT A SIDE EFFECT
 *   Zero grants emit `1=0`. A missing scope emits `1=0`. A forged `?branchId=`
 *   is intersected away and emits `1=0`. None of those is an error, and none of
 *   them is an unscoped query.
 */

const fs = require('fs');
const path = require('path');

// ── the fake db, installed before ANY module can require the real one ────────
const DB_PATH = require.resolve('../db/connection');

/** One generic row that satisfies every consumer in the reporting service. */
const GENERIC_ROW = Object.freeze({
  n: 0, invoices: 0, net: 0, vat: 0, total: 0, collected: 0, outstanding: 0,
  returns: 0, total_amount: 0, balance_amount: 0, paid_amount: 0, subtotal: 0,
  vat_amount: 0, unapplied_amount: 0, allocated_amount: 0, credit_limit: 0,
  exposure: 0, qty: 0, customer_id: 'CUST-1', customer_name: 'x', name: 'x',
  id: 'X-1', document_number: 'INV-1', payment_number: 'CR-1', return_number: 'SR-1',
  zatca_status: 'accepted', cashier: 'u', channel_id: 'CH-1', branch_id: 'BR-A',
  issue_date: '2026-01-01', due_date: '2026-01-01', payment_date: '2026-01-01',
  return_date: '2026-01-01', item_id: 'I-1', menu_id: 'M-1', description: 'd',
  brand_id: 'BRAND-1',
});

const calls = [];
const fakeDb = {
  calls,
  reset() { calls.length = 0; },
  sqls() { return calls.map((c) => c.sql); },
  async query(sql, params) {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: (params || []).slice() });
    return [[Object.assign({}, GENERIC_ROW)], []];
  },
  async withTransaction(fn) { return fn(fakeDb); },
  async getConnection() { return fakeDb; },
};
require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDb };

const SalesScope = require('../lib/salesScope');
const Reporting = require('../services/order-to-cash/O2CReportingService');
const InvoiceService = require('../services/order-to-cash/InvoiceService');
const PaymentService = require('../services/order-to-cash/CustomerPaymentService');
const ReturnService = require('../services/order-to-cash/SalesReturnService');

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
  if (actual !== expected) throw new Error(`${msg || ''} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const BR_A = 'BR-A';
const BR_B = 'BR-B';
const SCOPE_A = { all: false, branchIds: [BR_A] };
const SCOPE_NONE = { all: false, branchIds: [] };
const SCOPE_GLOBAL = { all: true, branchIds: [] };
const RANGE = { from: '2026-01-01', to: '2026-12-31', customerId: 'CUST-1' };

/** The thirteen aggregate reports (customer-statement is delegated — see run()). */
const REPORT_TYPES = Reporting.REPORTS.filter((t) => t !== 'customer-statement');

/** A statement is branch-scoped when it names a branch column or fails closed. */
const SCOPED_RE = /branch_id IN \(\?/;
const CLOSED_RE = /\b1=0\b/;
function isScoped(sql) { return SCOPED_RE.test(sql) || CLOSED_RE.test(sql); }

/** Run one report against the fake and hand back every statement it emitted. */
async function emit(type, params) {
  fakeDb.reset();
  await Reporting.run(type, params);
  return calls.slice();
}

async function main() {
  eq(REPORT_TYPES.length, 13, 'the report registry no longer has thirteen aggregate reports — this file must cover the new one too');

  // ── 1. every report puts the predicate INSIDE its own SQL ─────────────────
  console.log('\n1. all 13 reports — the branch predicate reaches MySQL');

  for (const type of REPORT_TYPES) {
    await test(`${type} — every statement names only branch A`, async () => {
      const stmts = await emit(type, Object.assign({ scope: SCOPE_A }, RANGE));
      ok(stmts.length > 0, 'the report emitted no SQL at all');
      stmts.forEach((c) => {
        ok(isScoped(c.sql), `unscoped statement — a scoped caller reads every branch here:\n      ${c.sql}`);
        ok(c.params.indexOf(BR_B) === -1, `branch B was bound:\n      ${c.sql}`);
      });
      // At least one statement must bind the caller's OWN branch: a report whose
      // every statement said `1=0` would pass the loop above while returning
      // nothing to anyone, which is a broken report, not an isolated one.
      ok(stmts.some((c) => c.params.indexOf(BR_A) !== -1),
        'no statement bound branch A — the report is empty for everyone, not scoped');
    });
  }

  await test('sales-summary scopes its RETURNS half too, not just the invoices half', async () => {
    const stmts = await emit('sales-summary', Object.assign({ scope: SCOPE_A }, RANGE));
    const ret = stmts.filter((c) => /FROM sales_returns/.test(c.sql));
    eq(ret.length, 1, 'expected exactly one sales_returns statement');
    ok(SCOPED_RE.test(ret[0].sql),
      'another branch\'s returns would be netted off this branch\'s sales: ' + ret[0].sql);
  });

  await test('data-quality scopes all five of its counts', async () => {
    const stmts = await emit('data-quality', Object.assign({ scope: SCOPE_A }, RANGE));
    eq(stmts.length, 5, 'expected five independent counts');
    stmts.forEach((c) => ok(isScoped(c.sql), 'unscoped count: ' + c.sql));
  });

  await test('the two customer-keyed reports reach a branch through ar_documents', async () => {
    // `customers` carries no branch_id, so the only honest question is "has this
    // customer traded in a branch you may see?" — an EXISTS over ar_documents.
    for (const type of ['credit-exposure', 'data-quality']) {
      const stmts = await emit(type, Object.assign({ scope: SCOPE_A }, RANGE));
      const cust = stmts.filter((c) => /FROM customers/.test(c.sql));
      ok(cust.length > 0, `${type} did not query customers`);
      cust.forEach((c) => {
        ok(/EXISTS \(SELECT 1 FROM ar_documents bx/.test(c.sql),
          `${type} reads customers with no branch reachability probe: ${c.sql}`);
        ok(SCOPED_RE.test(c.sql), `${type} EXISTS probe is not branch-bound: ${c.sql}`);
      });
    }
  });

  await test('the line-level report reaches a branch through its document', async () => {
    const stmts = await emit('sales-by-product', Object.assign({ scope: SCOPE_A }, RANGE));
    ok(/ar_document_lines l JOIN ar_documents d/.test(stmts[0].sql), 'join shape changed');
    ok(/d\.branch_id IN \(\?/.test(stmts[0].sql),
      'ar_document_lines has no branch of its own — the predicate must ride the document: ' + stmts[0].sql);
  });

  // ── 2. zero grants ─────────────────────────────────────────────────────────
  console.log('\n2. zero grants — 1=0, never "no clause"');

  for (const type of REPORT_TYPES) {
    await test(`${type} — a zero-grant caller emits the fail-closed clause`, async () => {
      const stmts = await emit(type, Object.assign({ scope: SCOPE_NONE }, RANGE));
      stmts.forEach((c) => {
        ok(CLOSED_RE.test(c.sql), `zero grants produced a statement that is not fail-closed:\n      ${c.sql}`);
        eq(c.params.filter((p) => p === BR_A || p === BR_B).length, 0, 'no branch may be bound');
      });
    });
  }

  await test('a MISSING scope fails closed exactly like zero grants', async () => {
    // An internal caller that forgets params.scope must get nothing, not
    // everything. lib/salesScope._norm already says a missing scope never widens.
    for (const type of REPORT_TYPES) {
      const stmts = await emit(type, Object.assign({}, RANGE));
      stmts.forEach((c) => ok(CLOSED_RE.test(c.sql),
        `${type} runs UNSCOPED when params.scope is absent:\n      ${c.sql}`));
    }
  });

  // ── 3. the global caller is untouched ─────────────────────────────────────
  console.log('\n3. a global admin sees exactly what they saw before');

  for (const type of REPORT_TYPES) {
    await test(`${type} — a global caller emits no branch clause`, async () => {
      const stmts = await emit(type, Object.assign({ scope: SCOPE_GLOBAL }, RANGE));
      stmts.forEach((c) => {
        ok(!SCOPED_RE.test(c.sql), 'a global admin must not be narrowed: ' + c.sql);
        ok(!CLOSED_RE.test(c.sql), 'a global admin must not be fail-closed: ' + c.sql);
      });
    });
  }

  await test('a global caller pays for no extra query', async () => {
    for (const type of REPORT_TYPES) {
      const g = await emit(type, Object.assign({ scope: SCOPE_GLOBAL }, RANGE));
      const s = await emit(type, Object.assign({ scope: SCOPE_A }, RANGE));
      eq(g.length, s.length, `${type} — scoping changed the STATEMENT COUNT; the predicate belongs in the existing queries, not in extra ones`);
    }
  });

  // ── 4. a hand-sent ?branchId= is intersected, never trusted ───────────────
  console.log('\n4. a forged ?branchId= is intersected away');

  await test('branch-A caller asking for branch B gets 1=0 in every report', async () => {
    // Exactly what routes/order-to-cash/reports.js `_scopedParams` computes.
    const eff = SalesScope.assertBranchAllowed(SCOPE_A, SalesScope.requestedBranchIds({ branchId: BR_B }));
    eq(eff.branchIds.length, 0, 'the intersection must be empty');
    for (const type of REPORT_TYPES) {
      const stmts = await emit(type, Object.assign({ scope: eff }, RANGE));
      stmts.forEach((c) => {
        ok(CLOSED_RE.test(c.sql), `${type} honoured a forged branch id:\n      ${c.sql}`);
        ok(c.params.indexOf(BR_B) === -1, `${type} BOUND the forged branch id:\n      ${c.sql}`);
      });
    }
  });

  await test('branch-A caller asking for branch A still gets branch A', async () => {
    const eff = SalesScope.assertBranchAllowed(SCOPE_A, SalesScope.requestedBranchIds({ branchId: BR_A }));
    const stmts = await emit('sales-summary', Object.assign({ scope: eff }, RANGE));
    ok(stmts.every((c) => SCOPED_RE.test(c.sql)), 'an in-scope filter must survive');
    ok(stmts.some((c) => c.params.indexOf(BR_A) !== -1), 'branch A must be bound');
  });

  await test('a caller holding two branches gets both, and only both', async () => {
    const stmts = await emit('sales-by-channel', Object.assign({ scope: { all: false, branchIds: [BR_A, 'BR-C'] } }, RANGE));
    ok(/branch_id IN \(\?,\?\)/.test(stmts[0].sql), 'one placeholder per grant: ' + stmts[0].sql);
    ok(stmts[0].params.indexOf(BR_B) === -1, 'an ungranted branch must never be bound');
  });

  // ── 5. the export path vs the screen path — compared to EACH OTHER ────────
  console.log('\n5. CSV export emits the identical SQL as the screen');

  /** Drive one real route handler and return its SQL transcript. */
  async function driveRoute(routePath, query, user) {
    const router = require('../routes/order-to-cash/reports');
    const layer = router.stack.find((l) => l.route && l.route.path === routePath);
    if (!layer) throw new Error('route not found: ' + routePath);
    // The LAST handler on the route is the body; the ones before it are the
    // capability guards, which are not what this test is about.
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { params: Object.assign({}, query.__params), query: Object.assign({}, query), user, headers: {} };
    delete req.query.__params;
    let sent = null;
    const res = {
      status() { return res; },
      json(b) { sent = b; return res; },
      send(b) { sent = b; return res; },
      setHeader() { return res; },
    };
    fakeDb.reset();
    await handler(req, res, () => {});
    ok(sent !== null, 'the handler never answered — ' + routePath);
    ok(!(sent && sent.success === false), 'the handler errored: ' + JSON.stringify(sent).slice(0, 300));
    return calls.slice();
  }

  // A non-global user whose single warehouse grant resolves to branch A. The
  // fake answers the user_warehouse_access lookup with the generic row, whose
  // branch_id is BR-A.
  const BRANCH_USER = { id: 7, username: 'br-user', role: 'manager' };

  for (const type of REPORT_TYPES) {
    await test(`${type} — export and screen emit byte-identical scoped SQL`, async () => {
      const q = { __params: { type }, from: RANGE.from, to: RANGE.to, customerId: 'CUST-1' };
      const screen = await driveRoute('/:type', q, BRANCH_USER);
      const exported = await driveRoute('/:type/export', q, BRANCH_USER);
      eq(JSON.stringify(exported.map((c) => [c.sql, c.params])),
        JSON.stringify(screen.map((c) => [c.sql, c.params])),
        `${type} — the CSV export took a different path from the screen; that difference IS the way around the screen's scope`);
      // …and that shared path is actually scoped, not merely identical.
      screen.slice(1).forEach((c) => ok(isScoped(c.sql), `${type} — screen statement unscoped: ${c.sql}`));
    });
  }

  await test('a forged ?branchId= is intersected on the EXPORT too', async () => {
    const q = { __params: { type: 'sales-summary' }, from: RANGE.from, to: RANGE.to, branchId: BR_B };
    const exported = await driveRoute('/:type/export', q, BRANCH_USER);
    exported.slice(1).forEach((c) => {
      ok(CLOSED_RE.test(c.sql), 'the export honoured a forged branch id: ' + c.sql);
      ok(c.params.indexOf(BR_B) === -1, 'the export BOUND the forged branch id: ' + c.sql);
    });
  });

  // ── 6. list() — the total must be the caller's total ──────────────────────
  console.log('\n6. list() — pagination.total counted through the same predicate');

  const LISTS = [
    ['InvoiceService.list', (p) => InvoiceService.list(p), 'ar_documents'],
    ['CustomerPaymentService.list', (p) => PaymentService.list(p), 'customer_payments'],
    ['SalesReturnService.list', (p) => ReturnService.list(p), 'sales_returns'],
  ];

  for (const [name, run, table] of LISTS) {
    await test(`${name} — BOTH the page query and the COUNT carry the predicate`, async () => {
      fakeDb.reset();
      await run({ scope: SCOPE_A });
      eq(calls.length, 2, 'expected a page query and a count query');
      const count = calls.filter((c) => /COUNT\(\*\) AS total/.test(c.sql));
      eq(count.length, 1, 'expected exactly one COUNT');
      calls.forEach((c) => {
        ok(SCOPED_RE.test(c.sql), `${name} — unscoped statement over ${table}:\n      ${c.sql}`);
        ok(c.params.indexOf(BR_A) !== -1, 'branch A must be bound: ' + c.sql);
        ok(c.params.indexOf(BR_B) === -1, 'branch B must never be bound: ' + c.sql);
      });
    });

    await test(`${name} — zero grants count zero, not the company's total`, async () => {
      fakeDb.reset();
      await run({ scope: SCOPE_NONE });
      calls.forEach((c) => ok(CLOSED_RE.test(c.sql), `${name} — not fail-closed:\n      ${c.sql}`));
    });

    await test(`${name} — a global caller's SQL is unchanged`, async () => {
      fakeDb.reset();
      await run({ scope: SCOPE_GLOBAL });
      calls.forEach((c) => {
        ok(!SCOPED_RE.test(c.sql), 'a global admin must not be narrowed: ' + c.sql);
        ok(!CLOSED_RE.test(c.sql), 'a global admin must not be fail-closed: ' + c.sql);
      });
    });
  }

  // ── 7. the Orders page's filters actually reach SQL, on the hub's basis ───
  console.log('\n7. InvoiceService.list — period / channel / order type, business-day basis');

  await test('from/to filter on business_day, NOT on the raw issue date', async () => {
    // The hub keys every rollup by business_day; ar_documents.issue_date is the
    // CALENDAR day (linkPosSale writes calc.ymd(sale.order_date)). For a 04:00
    // branch close the two disagree on the 00:00–03:59 trade, so a list filtered
    // on issue_date shows the KPI row above it a different population — the same
    // divergence the journal-date fix (d4b34e8) was about.
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_GLOBAL, from: '2026-03-01', to: '2026-03-31' });
    calls.forEach((c) => {
      ok(/COALESCE\(f\.business_day, d\.issue_date\) >= \?/.test(c.sql),
        'the list filters on the wrong date basis: ' + c.sql);
      ok(/LEFT JOIN analytics_order_facts f ON f\.document_id = d\.id/.test(c.sql),
        'business_day is read from the hub\'s own fact row: ' + c.sql);
      ok(c.params.indexOf('2026-03-01') !== -1 && c.params.indexOf('2026-03-31') !== -1, 'both bounds bound');
    });
  });

  await test('the calendar-day toggle switches the basis rather than dropping the filter', async () => {
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_GLOBAL, from: '2026-03-01', to: '2026-03-31', businessDay: 'false' });
    calls.forEach((c) => {
      ok(/d\.issue_date >= \?/.test(c.sql), 'calendar basis not honoured: ' + c.sql);
      ok(!/COALESCE\(f\.business_day/.test(c.sql), 'still on the business-day basis: ' + c.sql);
    });
  });

  await test('analytics calendar-day uses the fact local date, not the document issue date', async () => {
    fakeDb.reset();
    await InvoiceService.list({
      scope: SCOPE_A, analyticsPopulation: true, businessDay: 'false',
      from: '2026-03-01', to: '2026-03-31',
    });
    calls.forEach((c) => {
      ok(/DATE\(f\.occurred_at_local\) >= \?/.test(c.sql), 'analytics calendar basis drifted: ' + c.sql);
      ok(!/d\.issue_date >= \?/.test(c.sql), 'document issue date widened the analytics population: ' + c.sql);
    });
  });

  await test('channels and orderTypes reach SQL and bind one placeholder each', async () => {
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_GLOBAL, channels: 'CH-A,CH-B', orderTypes: ['dine_in'] });
    calls.forEach((c) => {
      ok(/COALESCE\(f\.channel_id, d\.channel_id\) IN \(\?,\?\)/.test(c.sql), 'channel filter missing: ' + c.sql);
      ok(/f\.order_type IN \(\?\)/.test(c.sql), 'orderType filter missing: ' + c.sql);
      ok(c.params.indexOf('CH-A') !== -1 && c.params.indexOf('CH-B') !== -1, 'channels bound');
      ok(c.params.indexOf('dine_in') !== -1, 'order type bound');
    });
  });

  await test('the singular hub param names are accepted too (channel / orderType)', async () => {
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_GLOBAL, channel: 'CH-A', orderType: 'takeaway' });
    ok(/f\.order_type IN \(\?\)/.test(calls[0].sql), 'singular orderType ignored: ' + calls[0].sql);
    ok(calls[0].params.indexOf('CH-A') !== -1, 'singular channel ignored');
  });

  await test('unknown / empty filters are ignored, never rejected', async () => {
    // The live Orders page already sends from/to plus its own junk; a 422 on an
    // unrecognised parameter would break it the moment this deploys.
    fakeDb.reset();
    const out = await InvoiceService.list({ scope: SCOPE_GLOBAL, channels: '', orderTypes: ',', somethingNew: 'x' });
    ok(out && out.pagination, 'the list must answer, not throw');
    ok(!/channel_id IN/.test(calls[0].sql), 'an empty channel list must not become a filter: ' + calls[0].sql);
    ok(!/order_type IN/.test(calls[0].sql), 'a comma-only order-type list must not become a filter');
  });

  await test('a date that is not a date is dropped, not bound', async () => {
    // calc.ymd('abc') returns 'abc'; binding that to a DATE comparison makes the
    // result depend on MySQL's warning mode rather than on the requested filter.
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_GLOBAL, from: 'abc', to: '2026-13-45' });
    calls.forEach((c) => {
      ok(!/business_day, d\.issue_date\) >= \?/.test(c.sql), 'junk was bound as a lower bound: ' + c.sql);
      ok(c.params.indexOf('abc') === -1, 'junk reached MySQL as a parameter');
    });
  });

  await test('the page query and the COUNT filter on the SAME predicate set', async () => {
    // A total counted over a wider population than the page is the pagination
    // half of this bug: an inflated total and a short page.
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_A, from: '2026-03-01', to: '2026-03-31', channels: 'CH-A' });
    const [pageQ, countQ] = calls;
    const whereOf = (s) => s.slice(s.indexOf('WHERE'), s.indexOf('ORDER BY') === -1 ? undefined : s.indexOf('ORDER BY')).trim();
    eq(whereOf(countQ.sql), whereOf(pageQ.sql), 'the COUNT filters differently from the page it counts');
    eq(JSON.stringify(countQ.params), JSON.stringify(pageQ.params.slice(0, countQ.params.length)), 'different bound values');
  });

  await test('analytics channel filtering and display use the fact column only', async () => {
    fakeDb.reset();
    await InvoiceService.list({
      scope: SCOPE_A, analyticsPopulation: true, channels: ['CH-A'],
    });
    calls.forEach((c) => {
      ok(/f\.channel_id IN \(\?\)/.test(c.sql), 'analytics channel did not use its fact: ' + c.sql);
      ok(!/COALESCE\(f\.channel_id, d\.channel_id\) IN/.test(c.sql),
        'document fallback widened the analytics population: ' + c.sql);
    });
    const page = calls.find((c) => /ORDER BY/.test(c.sql));
    ok(page && /f\.channel_id AS channel/.test(page.sql),
      'the displayed channel differs from the channel the KPI groups: ' + (page && page.sql));
  });

  await test('negative POS line/component costs are rejected before the first write', async () => {
    let queries = 0;
    const noWrite = { async query() { queries++; return [[]]; } };
    let lineErr = null;
    try {
      await InvoiceService._ensurePosLines(noWrite, 'DOC-X', [{
        sourceLineId: 'L1', enteredQty: 1, baseQty: 1, unitPrice: 1,
        discountAmount: 0, vatCategory: 'S', vatRate: 15,
        netAmount: 1, vatAmount: 0.15, grossAmount: 1.15,
        costSnapshot: -0.01, projectionVersion: 1,
      }], []);
    } catch (e) { lineErr = e; }
    ok(lineErr && lineErr.code === 'VALIDATION_ERROR', 'negative line cost was accepted');
    eq(queries, 0, 'line validation happened after a database write');

    let manualErr = null;
    try {
      await InvoiceService._computeDoc({ async query() { return [[{ setting_value: '15' }]]; } }, {
        lines: [{ enteredQty: 1, factor: 1, unitPrice: 1, costSnapshot: -0.01 }],
      });
    } catch (e) { manualErr = e; }
    ok(manualErr && manualErr.code === 'VALIDATION_ERROR',
      'manual/contract invoice source accepted a negative cost snapshot');

    let componentErr = null;
    try {
      await InvoiceService._ensurePosLines(noWrite, 'DOC-X', [{
        sourceLineId: 'L1', enteredQty: 1, baseQty: 1, unitPrice: 1,
        discountAmount: 0, vatCategory: 'S', vatRate: 15,
        netAmount: 1, vatAmount: 0.15, grossAmount: 1.15,
        costSnapshot: 0.01, projectionVersion: 1,
      }], [{
        sourceLineId: 'L1', invItemId: 'I1', deductedBaseQty: 1,
        unitCostSnapshot: 0.01, totalCost: -0.01, projectionVersion: 1,
      }]);
    } catch (e) { componentErr = e; }
    ok(componentErr && componentErr.code === 'VALIDATION_ERROR', 'negative component cost was accepted');
    eq(queries, 0, 'component validation happened after a database write');

    let unitErr = null;
    try {
      await InvoiceService._ensurePosLines(noWrite, 'DOC-X', [{
        sourceLineId: 'L1', enteredQty: 1, baseQty: 1, unitPrice: 1,
        discountAmount: 0, vatCategory: 'S', vatRate: 15,
        netAmount: 1, vatAmount: 0.15, grossAmount: 1.15,
        costSnapshot: 0.01, projectionVersion: 1,
      }], [{
        sourceLineId: 'L1', invItemId: 'I1', deductedBaseQty: 1,
        unitCostSnapshot: -0.01, totalCost: 0.01, projectionVersion: 1,
      }]);
    } catch (e) { unitErr = e; }
    ok(unitErr && unitErr.code === 'VALIDATION_ERROR', 'negative component unit cost was accepted');
    eq(queries, 0, 'unit-cost validation happened after a database write');
  });

  await test('restore refuses a historical negative component before moving stock', async () => {
    let queries = 0;
    const conn = {
      async query(sql) {
        queries++;
        if (/FROM sales_return_line_components/.test(sql)) return [[{
          return_line_id: 'RL1', component_seq: 1, inv_item_id: 'I1',
          warehouse_id: 'W1', restored_base_qty: 1, total_cost: -0.01,
        }]];
        throw new Error('stock mutation was reached');
      },
    };
    let caught = null;
    try {
      await ReturnService._restore(conn, { id: 'R1', return_number: 'RET-1' },
        [{ id: 'RL1', restock: 1, description: 'x' }], 'manager');
    } catch (e) { caught = e; }
    ok(caught && caught.code === 'VALIDATION_ERROR', 'negative restored cost reached stock/GL');
    eq(queries, 1, 'a stock query ran after the negative snapshot was detected');
  });

  await test('historical COGS backfill requires a matching ledger journal', async () => {
    const schema = require('../db/migrations/order-to-cash/schema');
    let sql = '';
    const changed = await schema.backfillReversedCogs({
      async query(q) { sql = String(q).replace(/\s+/g, ' ').trim(); return [{ affectedRows: 2 }]; },
    });
    eq(changed, 2, 'affected row count');
    ok(/JOIN gl_journals gj/.test(sql), 'snapshot-only backfill would fabricate old COGS');
    ok(/gj\.id = sr\.cogs_journal_id/.test(sql), 'return does not prove which journal carried COGS');
    ok(/gj\.reference_type = 'SalesReturnCOGS'/.test(sql) && /gj\.reference_id = sr\.id/.test(sql),
      'an unrelated journal could prove the backfill');
    ok(/rl\.cogs_reversed_amount IS NULL/.test(sql), 'rerun could overwrite a frozen posting value');
  });

  await test('the Sales Decision Center list uses the exact analytics order population', async () => {
    fakeDb.reset();
    await InvoiceService.list({ scope: SCOPE_A, analyticsPopulation: 'true' });
    calls.forEach((c) => {
      ok(/f\.document_id IS NOT NULL/.test(c.sql), 'unprojected documents widened the list: ' + c.sql);
      ok(/f\.status IS NULL OR f\.status <> 'voided'/.test(c.sql), 'voided facts were not excluded: ' + c.sql);
      ok(/f\.source IS NULL OR f\.source NOT IN \('sales_return','credit_note'\)/.test(c.sql),
        'credit-note facts were not excluded: ' + c.sql);
      ok(/f\.branch_id IN \(\?\)/.test(c.sql), 'analytics scope must use the same fact branch as the KPI: ' + c.sql);
    });
    const page = calls.find((c) => /ORDER BY/.test(c.sql));
    ok(page && /f\.branch_id AS branch_id/.test(page.sql),
      'the returned branch must be the same fact branch counted by pagination: ' + (page && page.sql));
    ok(page && /br\.name AS branch_name/.test(page.sql) && /br\.name_en AS branch_name_en/.test(page.sql),
      'the decision table is missing bilingual branch labels: ' + (page && page.sql));
    ok(page && /AS cashier_name/.test(page.sql),
      'the decision table is missing the cashier display name: ' + (page && page.sql));
  });

  // ── 8. the dashboard's own SQL ────────────────────────────────────────────
  console.log('\n8. the AR dashboard aggregates only the caller\'s branches');

  await test('every dashboard figure carries the predicate', async () => {
    const router = require('../routes/order-to-cash/dashboard');
    const layer = router.stack.find((l) => l.route && l.route.path === '/dashboard');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { params: {}, query: {}, user: { id: 7, username: 'br-user', role: 'manager' }, headers: {} };
    let sent = null;
    const res = { status() { return res; }, json(b) { sent = b; return res; }, setHeader() { return res; } };
    fakeDb.reset();
    await handler(req, res, () => {});
    ok(sent && sent.success !== false, 'dashboard errored: ' + JSON.stringify(sent).slice(0, 200));
    // calls[0] is the scope lookup itself (user_warehouse_access).
    ok(/user_warehouse_access/.test(calls[0].sql), 'expected the scope lookup first');
    const figures = calls.slice(1);
    eq(figures.length, 6, 'expected six figure queries');
    figures.forEach((c) => ok(isScoped(c.sql), 'unscoped dashboard figure:\n      ' + c.sql));
    const exposure = figures.find((c) => /v_customer_ar_balance/.test(c.sql));
    ok(/EXISTS \(SELECT 1 FROM ar_documents x/.test(exposure.sql),
      'top-exposure names customers with no branch reachability probe: ' + exposure.sql);
  });

  // ── 9. a report added later cannot ship unscoped ──────────────────────────
  console.log('\n9. the next report cannot forget the predicate');

  await test('every function in the REPORTS registry reads params.scope', () => {
    // The loops above only cover the thirteen that exist today. This reads the
    // source so a fourteenth added next month fails here rather than shipping
    // company-wide totals and waiting to be noticed.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services/order-to-cash/O2CReportingService.js'), 'utf8');
    const registry = src.slice(src.indexOf('const REPORTS = {'), src.indexOf('async function run('));
    const names = (registry.match(/[A-Za-z_$][\w$]*(?=,|\s*$)/gm) || []);
    const bodies = src.split(/\nasync function /).slice(1);
    let checked = 0;
    bodies.forEach((b) => {
      const fname = b.slice(0, b.indexOf('('));
      if (fname === 'run' || !names.includes(fname)) return;
      const body = b.slice(0, b.indexOf('\n}\n') === -1 ? undefined : b.indexOf('\n}\n'));
      ok(/_branch\(params,|_customerBranchExists\(params,/.test(body),
        `report function ${fname} builds no branch predicate — it aggregates every branch`);
      checked++;
    });
    ok(checked >= 13, `expected at least 13 report functions, inspected ${checked}`);
  });

  await test('the three list services still take their scope from params', () => {
    [
      'services/order-to-cash/InvoiceService.js',
      'services/order-to-cash/CustomerPaymentService.js',
      'services/order-to-cash/SalesReturnService.js',
    ].forEach((rel) => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      ok(/SalesScope\.branchClause\(params\.scope,/.test(src),
        `${rel} — list() no longer builds a branch predicate from params.scope`);
    });
  });

  console.log(`\nO2C report scope: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
}

main();
