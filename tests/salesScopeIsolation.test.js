#!/usr/bin/env node
'use strict';
/**
 * tests/salesScopeIsolation.test.js — a branch user must not read another
 * branch's Order-to-Cash data. Run: node tests/salesScopeIsolation.test.js
 *
 * WHAT WAS BROKEN
 *   routes/order-to-cash/{invoices,reports,payments,returns}.js carried
 *   capability guards and nothing else — zero references to branch_id, zero use
 *   of any scope helper. `invoices.view` answers WHETHER you may read invoices,
 *   never WHOSE, so any authenticated holder of the ordinary read capabilities
 *   could list, open and export every branch's invoices, receipts, credit notes
 *   and AR reports. The analytics engine had closed the same hole long ago
 *   (lib/analytics/planner.js appends `scopeColumn IN (…)`, or `1=0` on zero
 *   grants); these four routers were the door left open.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT
 *   It drives the REAL lib/salesScope.js against a fake db that records the SQL
 *   it is asked to run, so the assertions are about the predicate that actually
 *   reaches MySQL — not about a mock's return value. It covers the row-level
 *   enforcement the routers own today: page filtering, detail/timeline/customer
 *   guards, and the intersection rule for a caller-supplied `?branchId=`.
 *
 *   It does NOT prove the list statements' own WHERE clauses are scoped, because
 *   they are not: the list SQL lives in services/order-to-cash/*.js and the
 *   report SQL in O2CReportingService.js, both owned elsewhere. Section 6 pins
 *   the plumbing (`scope` is passed into every one of those calls) so the wiring
 *   cannot be quietly removed before the WHERE clauses land, and says plainly
 *   that pagination totals and report aggregates are still company-wide.
 *
 * FAIL-CLOSED, AND WHY NOT 403
 *   An out-of-scope id answers 404 with the same message a never-issued id gets.
 *   A 403 would confirm the row exists, and an attacker who can enumerate ids
 *   learns another branch's document numbering and volume without reading a row.
 *   Section 3 asserts the two answers are indistinguishable.
 */

const fs = require('fs');
const path = require('path');
const SalesScope = require('../lib/salesScope');
const E = require('../lib/order-to-cash/errors');

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

/** A db that answers on the SQL it is handed and records every statement. */
function fakeDb(answer) {
  const calls = [];
  return {
    calls,
    last() { return calls[calls.length - 1]; },
    async query(sql, params) {
      calls.push({ sql: String(sql), params: params || [] });
      const rows = typeof answer === 'function' ? answer(String(sql), params || []) : (answer || []);
      return [rows, []];
    },
  };
}

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ROUTE_FILES = [
  'routes/order-to-cash/invoices.js',
  'routes/order-to-cash/payments.js',
  'routes/order-to-cash/returns.js',
  'routes/order-to-cash/reports.js',
];

async function main() {
  // ── 1. the predicate itself ───────────────────────────────────────────────
  console.log('\n1. branchClause — the predicate that reaches MySQL');

  await test('a branch-A user gets a clause naming ONLY branch A', () => {
    const c = SalesScope.branchClause(SCOPE_A, 'branch_id');
    eq(c.sql, 'branch_id IN (?)', 'clause shape');
    eq(c.params.join(','), BR_A, 'bound branch ids');
    ok(c.params.indexOf(BR_B) === -1, 'branch B leaked into a branch-A clause');
  });

  await test('a zero-grant user gets 1=0, never an unscoped query', () => {
    const c = SalesScope.branchClause(SCOPE_NONE, 'branch_id');
    eq(c.sql, '1=0', 'zero grants must fail closed');
    eq(c.params.length, 0, 'no params');
  });

  await test('a missing/null scope also fails closed (it must never widen)', () => {
    eq(SalesScope.branchClause(null, 'branch_id').sql, '1=0', 'null scope');
    eq(SalesScope.branchClause(undefined, 'branch_id').sql, '1=0', 'undefined scope');
  });

  await test('a global user gets NO branch clause at all', () => {
    const c = SalesScope.branchClause(SCOPE_GLOBAL, 'branch_id');
    eq(c.sql, '', 'a global admin must see exactly what they saw before');
    eq(c.params.length, 0, 'no params');
  });

  await test('multiple grants bind one placeholder each', () => {
    const c = SalesScope.branchClause({ all: false, branchIds: [BR_A, BR_B] }, 'd.branch_id');
    eq(c.sql, 'd.branch_id IN (?,?)', 'clause shape');
    eq(c.params.length, 2, 'params');
  });

  // ── 2. the intersection rule for a hand-sent branch filter ────────────────
  console.log('\n2. assertBranchAllowed — a hand-sent ?branchId= is intersected');

  await test('branch-A user asking for branch B gets NOTHING, not branch B', () => {
    const eff = SalesScope.assertBranchAllowed(SCOPE_A, [BR_B]);
    eq(eff.branchIds.length, 0, 'the intersection must be empty');
    const c = SalesScope.branchClause(eff, 'branch_id');
    eq(c.sql, '1=0', 'an out-of-scope request must yield the fail-closed clause');
    ok(c.params.indexOf(BR_B) === -1, 'branch B must never be bound');
  });

  await test('branch-A user asking for branch A still gets branch A', () => {
    const eff = SalesScope.assertBranchAllowed(SCOPE_A, [BR_A]);
    eq(SalesScope.branchClause(eff, 'branch_id').sql, 'branch_id IN (?)', 'in-scope filter survives');
  });

  await test('a mixed request keeps only the granted half', () => {
    const eff = SalesScope.assertBranchAllowed({ all: false, branchIds: [BR_A, 'BR-C'] }, [BR_A, BR_B]);
    eq(eff.branchIds.join(','), BR_A, 'only the granted branch survives');
  });

  await test('no filter at all leaves the scope untouched', () => {
    eq(SalesScope.assertBranchAllowed(SCOPE_A, []).branchIds.join(','), BR_A, 'branch user');
    eq(SalesScope.assertBranchAllowed(SCOPE_GLOBAL, []).all, true, 'global user stays global');
  });

  await test('a global user filtering by a branch gets a filter, not an escalation', () => {
    const eff = SalesScope.assertBranchAllowed(SCOPE_GLOBAL, [BR_B]);
    eq(eff.all, false, 'the filter narrows');
    eq(eff.branchIds.join(','), BR_B, 'to exactly what was asked for');
  });

  await test('?branchId= is read from repeated and comma-separated forms alike', () => {
    eq(SalesScope.requestedBranchIds({ branchId: 'BR-A,BR-B' }).join('|'), 'BR-A|BR-B', 'comma form');
    eq(SalesScope.requestedBranchIds({ branchIds: ['BR-A', 'BR-B'] }).join('|'), 'BR-A|BR-B', 'repeated form');
    eq(SalesScope.requestedBranchIds({}).length, 0, 'absent');
  });

  // ── 3. detail reads: 404, and indistinguishable from "never existed" ──────
  console.log('\n3. detail reads — out of scope answers 404, not 403');

  await test("an out-of-scope row raises NOT_FOUND and maps to HTTP 404", () => {
    let caught = null;
    try { SalesScope.assertRowInScope(SCOPE_A, { id: 'AR-1', branch_id: BR_B }, 'الفاتورة غير موجودة'); }
    catch (e) { caught = e; }
    ok(caught, 'reading another branch\'s invoice must throw');
    const body = E.errorBody(caught);
    eq(body.http, 404, 'a 403 would confirm the invoice exists');
    eq(body.body.code, 'NOT_FOUND', 'error code');
  });

  await test('an in-scope row passes through untouched', () => {
    const row = { id: 'AR-1', branch_id: BR_A };
    eq(SalesScope.assertRowInScope(SCOPE_A, row, 'x'), row, 'in-scope read must not be disturbed');
  });

  await test('a global user reads any row, including an unattributed one', () => {
    ok(SalesScope.assertRowInScope(SCOPE_GLOBAL, { id: 'AR-1', branch_id: BR_B }, 'x'), 'global sees branch B');
    ok(SalesScope.assertRowInScope(SCOPE_GLOBAL, { id: 'AR-2', branch_id: null }, 'x'), 'global sees NULL branch');
  });

  await test('a NULL-branch row is invisible to a scoped user (it cannot be proven theirs)', () => {
    eq(SalesScope.isBranchAllowed(SCOPE_A, null), false, 'NULL branch');
    eq(SalesScope.isBranchAllowed(SCOPE_A, ''), false, 'empty branch');
  });

  await test('out-of-scope and never-existed are byte-identical answers', async () => {
    const outOfScope = fakeDb([{ branch_id: BR_B }]);
    const missing = fakeDb([]);
    const grab = async (db) => {
      try { await SalesScope.assertRecordInScope(db, SCOPE_A, 'customer_payments', 'CR-1', 'سند القبض غير موجود'); }
      catch (e) { return JSON.stringify(E.errorBody(e)); }
      throw new Error('expected a throw');
    };
    eq(await grab(outOfScope), await grab(missing),
      'the two responses differ — the difference IS the existence leak');
  });

  await test('assertRecordInScope asks MySQL only about branch A', async () => {
    const db = fakeDb([{ branch_id: BR_B }]);
    try { await SalesScope.assertRecordInScope(db, SCOPE_A, 'customer_payments', 'CR-1'); } catch (e) { /* expected */ }
    const call = db.last();
    ok(/FROM customer_payments/.test(call.sql), 'queried the right table');
    ok(call.params.indexOf(BR_B) === -1, 'branch B must never be bound');
  });

  await test('a global user costs no extra query on a detail read', async () => {
    const db = fakeDb([{ branch_id: BR_B }]);
    await SalesScope.assertRecordInScope(db, SCOPE_GLOBAL, 'customer_payments', 'CR-1');
    eq(db.calls.length, 0, 'global scope must short-circuit');
  });

  await test('only registered tables may be scoped (the name is interpolated into SQL)', async () => {
    let threw = false;
    try { await SalesScope.assertRecordInScope(fakeDb([]), SCOPE_A, 'users; DROP TABLE x', 'id'); }
    catch (e) { threw = /no branch column registered/.test(e.message); }
    ok(threw, 'an unregistered table name must be refused, not interpolated');
  });

  // ── 4. list pages: the emitted SQL, and the rows that survive it ──────────
  console.log('\n4. list pages — the branch predicate that reaches MySQL');

  await test("a branch-A user's page query carries a clause naming ONLY branch A", async () => {
    const db = fakeDb([{ id: 'AR-1' }]);
    await SalesScope.filterPage(db, SCOPE_A, 'ar_documents', [{ id: 'AR-1' }, { id: 'AR-2' }]);
    const call = db.last();
    ok(/branch_id IN \(\?\)/.test(call.sql), 'no branch predicate in the emitted SQL: ' + call.sql);
    ok(call.params.indexOf(BR_A) !== -1, 'branch A must be bound');
    ok(call.params.indexOf(BR_B) === -1, 'branch B must never be bound');
  });

  await test("another branch's row is dropped before it reaches the client", async () => {
    // The fake answers as MySQL would: only the branch-A id comes back in scope.
    const db = fakeDb(() => [{ id: 'AR-1' }]);
    const page = await SalesScope.filterPage(db, SCOPE_A, 'ar_documents',
      [{ id: 'AR-1', document_number: 'INV-A' }, { id: 'AR-2', document_number: 'INV-B' }]);
    eq(page.rows.length, 1, 'exactly one row survives');
    eq(page.rows[0].document_number, 'INV-A', 'and it is the caller\'s own');
    eq(page.dropped, 1, 'the drop is reported so the caller can mark the page');
  });

  await test('a zero-grant user emits 1=0 and receives nothing', async () => {
    const db = fakeDb([]);
    const page = await SalesScope.filterPage(db, SCOPE_NONE, 'ar_documents', [{ id: 'AR-1' }]);
    ok(/1=0/.test(db.last().sql), 'zero grants must emit the fail-closed clause: ' + db.last().sql);
    eq(page.rows.length, 0, 'and return no rows');
  });

  await test('a global user emits NO branch query and keeps every row', async () => {
    const db = fakeDb([]);
    const rows = [{ id: 'AR-1' }, { id: 'AR-2' }];
    const page = await SalesScope.filterPage(db, SCOPE_GLOBAL, 'ar_documents', rows);
    eq(db.calls.length, 0, 'a global admin must not pay for a filter they do not need');
    eq(page.rows.length, 2, 'and must see exactly what they saw before');
  });

  await test('a branch-A user sending ?branchId=BR-B gets the fail-closed clause, not branch B', async () => {
    const eff = SalesScope.assertBranchAllowed(SCOPE_A, SalesScope.requestedBranchIds({ branchId: BR_B }));
    const db = fakeDb([]);
    const page = await SalesScope.filterPage(db, eff, 'sales_returns', [{ id: 'SR-1' }]);
    ok(/1=0/.test(db.last().sql), 'expected 1=0, got: ' + db.last().sql);
    ok(db.last().params.indexOf(BR_B) === -1, 'branch B must never be bound');
    eq(page.rows.length, 0, 'and no row survives');
  });

  await test('every scoped table the routers name is registered', () => {
    ['ar_documents', 'customer_payments', 'sales_returns'].forEach((t) => {
      ok(SalesScope.BRANCH_COLUMN[t], `table ${t} has no branch column registered`);
    });
  });

  // ── 5. the customer statement guard ──────────────────────────────────────
  console.log('\n5. customer statement — access guarded, figures deliberately company-wide');

  await test('a customer who never traded in the caller\'s branch answers 404', async () => {
    const db = fakeDb([]);
    let caught = null;
    try { await SalesScope.assertCustomerInScope(db, SCOPE_A, 'CUST-9', 'العميل غير موجود'); }
    catch (e) { caught = e; }
    ok(caught, 'expected a throw');
    eq(E.errorBody(caught).http, 404, 'must be 404, not 403');
    ok(/branch_id IN \(\?\)/.test(db.last().sql), 'the EXISTS probe must be branch-scoped: ' + db.last().sql);
    ok(db.last().params.indexOf(BR_A) !== -1, 'branch A bound');
  });

  await test('a customer with in-scope trade passes', async () => {
    const db = fakeDb([{ ok: 1 }]);
    eq(await SalesScope.assertCustomerInScope(db, SCOPE_A, 'CUST-1'), true, 'in-scope customer must pass');
  });

  await test('a zero-grant user cannot pull any statement', async () => {
    const db = fakeDb(() => []);
    let threw = false;
    try { await SalesScope.assertCustomerInScope(db, SCOPE_NONE, 'CUST-1'); } catch (e) { threw = true; }
    ok(threw, 'zero grants must not reach a statement');
    ok(/1=0/.test(db.last().sql), 'and must emit the fail-closed clause');
  });

  // ── 6. the routers are actually wired to all of this ─────────────────────
  console.log('\n6. router wiring — a new read handler cannot skip the scope');

  await test('all four routers require lib/salesScope', () => {
    ROUTE_FILES.forEach((rel) => {
      ok(/require\((['"])\.\.\/\.\.\/lib\/salesScope\1\)/.test(readSrc(rel)), `${rel} does not require lib/salesScope`);
    });
  });

  await test('every GET handler in the four routers goes through the scope', () => {
    // reports.js '/' returns the list of report TYPE NAMES — no branch data, so
    // it is the one read that legitimately needs no scope. Everything else must
    // name SalesScope (or _scopedParams, which is SalesScope one call deeper).
    const EXEMPT = { 'routes/order-to-cash/reports.js': ["router.get('/',"] };
    ROUTE_FILES.forEach((rel) => {
      const src = readSrc(rel);
      const exempt = EXEMPT[rel] || [];
      const chunks = src.split(/\nrouter\./).slice(1).map((c) => 'router.' + c);
      chunks.filter((c) => c.startsWith('router.get(')).forEach((c) => {
        const head = c.slice(0, c.indexOf('\n'));
        if (exempt.some((e) => c.startsWith(e))) return;
        ok(/SalesScope|_scopedParams/.test(c), `${rel} — unscoped GET handler: ${head.trim()}`);
      });
    });
  });

  await test('every detail GET (/:id) re-checks the row it just read', () => {
    // Resolving the scope is not enforcing it. Deleting the one assert line
    // leaves `SalesScope.forRequest` sitting there looking enforced, which is
    // exactly how a detail endpoint quietly reopens: the mutation that removed
    // the assert from returns.js passed every other check in this file.
    let checked = 0;
    ROUTE_FILES.forEach((rel) => {
      const src = readSrc(rel);
      const chunks = src.split(/\r?\nrouter\./).slice(1).map((c) => 'router.' + c);
      chunks.filter((c) => /^router\.get\((['"])\/[^'"]*:id/.test(c)).forEach((c) => {
        const head = c.slice(0, c.indexOf('\n')).trim();
        ok(/assertRowInScope|assertRecordInScope/.test(c),
          `${rel} — detail handler resolves a scope but never enforces it: ${head}`);
        checked++;
      });
    });
    ok(checked >= 4, `expected at least 4 detail handlers, found ${checked}`);
  });

  await test('every list call still receives the scope it will need in its WHERE', () => {
    // The plumbing is the half of the fix that survives into the service layer.
    // Pinning it here means nobody deletes it as "unused" while the services
    // still ignore params.scope.
    [
      ['routes/order-to-cash/invoices.js', 'InvoiceService.list'],
      ['routes/order-to-cash/payments.js', 'PaymentService.list'],
      ['routes/order-to-cash/returns.js', 'ReturnService.list'],
    ].forEach(([rel, call]) => {
      const src = readSrc(rel);
      const re = new RegExp(call.replace('.', '\\.') + '\\(Object\\.assign\\(\\{\\}, req\\.query, \\{ scope \\}\\)\\)');
      ok(re.test(src), `${rel} — ${call} is not given the caller's scope`);
    });
    const reports = readSrc('routes/order-to-cash/reports.js');
    const runs = reports.match(/Reporting\.run\(/g) || [];
    eq((reports.match(/Reporting\.run\(req\.params\.type, await _scopedParams\(req\)\)/g) || []).length, runs.length,
      'a Reporting.run call is bypassing _scopedParams — the CSV export was exactly that kind of side door');
  });

  await test('both list pages mark themselves when the scope removed rows', () => {
    ['routes/order-to-cash/invoices.js', 'routes/order-to-cash/payments.js', 'routes/order-to-cash/returns.js']
      .forEach((rel) => {
        ok(/SalesScope\.filterPage\(db, scope,/.test(readSrc(rel)), `${rel} does not filter its page by scope`);
        ok(/scopeFiltered: true/.test(readSrc(rel)), `${rel} does not flag a scope-shortened page`);
      });
  });

  console.log(`\nSales scope isolation: ${_passed}/${_total} passed, ${_failed} failed`);
  process.exit(_failed ? 1 : 0);
}

main();
