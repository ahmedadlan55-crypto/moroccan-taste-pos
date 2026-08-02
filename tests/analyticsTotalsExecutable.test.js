#!/usr/bin/env node
'use strict';
/**
 * The planner's SQL must EXECUTE — for every dimension, not for a lucky one.
 *
 * THE DEFECT
 *   The totals statement built its ROLLUP filter by restating the dimension
 *   expression, mirroring the SELECT / GROUPING() / GROUP BY clauses beside it:
 *
 *     HAVING (GROUPING(DATE_FORMAT(f.business_day,'%Y-%m-%d')) = 1)
 *
 *   HAVING is resolved AFTER grouping and cannot see the underlying column, so
 *   MySQL answers ER_BAD_FIELD_ERROR: Unknown column 'f.business_day' in
 *   'having clause'. A BARE column dimension parses fine; every SELECT-WRAPPED
 *   one does not. All nine time dimensions are wrapped — so business_day,
 *   calendar_day, week, month, quarter, year, hour, half_hour and weekday each
 *   returned a 500, which is every time-series report in the product, while
 *   branch, channel, cashier, menu_item and friends worked perfectly.
 *
 * WHY THIS FILE EXISTS RATHER THAN ONE MORE ASSERTION ON THE SQL STRING
 *   The sibling test (`analyticsPlanner.test.js`) checks the statement's TEXT,
 *   and it was green throughout: the text was exactly what it was designed to
 *   be. Only a server can say whether SQL runs. I also spot-checked this
 *   statement by hand against a live MySQL 8.4.9 and it passed — using
 *   GROUPING(branch_id), a bare column. True, and worthless: the one shape I
 *   sampled was the shape that works.
 *
 *   So this file sweeps EVERY groupable dimension in the registry and executes
 *   both statements. It cannot be satisfied by sampling, and a dimension added
 *   later is covered the day it is added.
 */
const assert = require('assert');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const planner = require('../lib/analytics/planner');
const DIMS = require('../lib/analytics/registry/dimensions');
const grouping = require('../lib/analytics/registry/grouping');
const db = require('../db/connection');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++; failures.push(msg); console.log('  FAIL ' + msg);
}

// Every capability, deliberately: this sweep is about whether the SQL RUNS.
// Capability masking has its own tests, and a scope without caps here would
// silently skip the employee and customer dimensions — which is how a blind
// spot gets rebuilt one exclusion at a time.
const GLOBAL = {
  all: true,
  branchIds: [],
  caps: new Set(['analytics.cost.view', 'analytics.employees.view', 'analytics.customers.view']),
};
const RANGE = { from: '2026-01-01', to: '2026-12-31' };

// Real metric ids per fact, read off the registry rather than guessed. The
// first draft invented `payment_amount`, which does not exist, and the
// resulting ANALYTICS_UNKNOWN_METRIC looked like a planner defect when it was
// the test being wrong about its own inputs.
const METRIC_BY_FACT = {
  order: 'orders',
  line: 'qty_sold',
  payment: 'payments_in',
  modifier: 'modifier_qty',
  return: 'returns_count',
  till: 'till_counted',
  budget: 'budget_amount',
};

/** A metric the dimension's own fact can express, so the sweep tests the DIMENSION. */
function metricFor(dimId) {
  for (const f of grouping.dimensionFacts(dimId)) {
    if (METRIC_BY_FACT[f]) return METRIC_BY_FACT[f];
  }
  return null;
}

async function main() {
  console.log('analyticsTotalsExecutable');

  try { await db.query('SELECT 1'); } catch (e) {
    console.log('  FATAL: MySQL unreachable — ' + (e.code || e.message));
    console.log('  This suite exists precisely because a server is the only thing');
    console.log('  that can answer whether the SQL runs. Refusing to report a pass.');
    process.exit(2);
  }

  const dims = DIMS.DIMENSIONS.filter((d) => d.groupable);
  console.log(`\n1. every groupable dimension's rows + totals statement executes (${dims.length} dims)`);

  const wrapped = [];
  for (const d of dims) {
    const metric = metricFor(d.id);
    if (!metric) continue; // no fact expresses it — the planner rejects it by design

    let plan;
    try {
      plan = planner.plan({
        metrics: [metric], dimensions: [d.id], range: RANGE, limit: 10,
      }, GLOBAL);
    } catch (e) {
      // A planner REFUSAL is a legitimate answer (unsupported combination); a
      // planner CRASH is not.
      ok(/UNSUPPORTED|INVALID|combination/i.test(String(e.code || e.message)),
        `${d.id}: planner threw a non-contract error — ${e.code || e.message}`);
      continue;
    }

    for (const st of plan.statements) {
      for (const which of ['rows', 'totals']) {
        const stmt = st[which];
        if (!stmt) continue;
        if (which === 'totals' && /HAVING/.test(stmt.sql) && /DATE_FORMAT|CONCAT|CASE/i.test(stmt.sql)) {
          wrapped.push(d.id);
        }
        try {
          await db.query(stmt.sql, stmt.params);
          pass++;
        } catch (e) {
          fail++;
          const msg = `${d.id} [${which}]: ${e.code} — ${e.sqlMessage || e.message}`;
          failures.push(msg);
          console.log('  FAIL ' + msg);
        }
      }
    }
  }
  console.log(`  ${pass} statement(s) executed`);

  console.log('\n2. the sweep actually covered the shape that was broken');
  // Without this the file could pass by only ever testing bare columns — the
  // exact blind spot that let the defect ship.
  ok(wrapped.length > 0,
    'no SELECT-WRAPPED dimension reached a HAVING clause: this sweep would not have caught the original defect');
  if (wrapped.length) console.log(`  wrapped dims covered: ${[...new Set(wrapped)].join(', ')}`);

  console.log('\n3. multi-dimension totals, where the OR chain has more than one term');
  for (const combo of [['business_day', 'branch'], ['branch', 'channel'], ['month', 'category']]) {
    try {
      const plan = planner.plan(
        { metrics: ['orders'], dimensions: combo, range: RANGE, limit: 10 }, GLOBAL);
      for (const st of plan.statements) {
        if (st.totals) await db.query(st.totals.sql, st.totals.params);
      }
      pass++;
    } catch (e) {
      if (/UNSUPPORTED|INVALID|combination/i.test(String(e.code || e.message))) { pass++; continue; }
      fail++;
      const msg = `${combo.join(' × ')}: ${e.code} — ${e.sqlMessage || e.message}`;
      failures.push(msg); console.log('  FAIL ' + msg);
    }
  }

  console.log('\n4. the totals statement returns AGGREGATES — the grand total, and no detail');
  // Executing is necessary and not sufficient: `HAVING g0 = 1` alone, or
  // `HAVING g{i} = 0`, are both perfectly valid SQL that return the wrong rows.
  // A mutation run proved exactly that — the sweep above stayed green for both.
  // What must hold is the SHAPE of the result: every returned row is an
  // aggregate over at least one dimension, the grand total is among them, and
  // no ungrouped detail row is shipped for Node to throw away.
  {
    const plan = planner.plan(
      { metrics: ['orders'], dimensions: ['business_day', 'branch'], range: RANGE, limit: 10 },
      GLOBAL);
    const st = plan.statements[0];
    const [rows] = await db.query(st.totals.sql, st.totals.params);

    ok(rows.length > 0, 'totals returned no rows at all');

    const flags = (r) => Object.keys(r).filter((k) => /^g\d+$/.test(k)).map((k) => Number(r[k]));
    ok(rows.every((r) => flags(r).length === 2),
      'each row must carry one GROUPING flag per dimension');
    ok(rows.every((r) => flags(r).some((f) => f === 1)),
      'a DETAIL row (every flag 0) reached the client — the discard is not happening in SQL');
    ok(rows.some((r) => flags(r).every((f) => f === 1)),
      'the GRAND TOTAL row is missing — the report has no period total to print');

    // Both dimensions must be able to produce their own subtotal level, or the
    // OR chain has collapsed to a single term.
    const levels = new Set(rows.map((r) => flags(r).join('')));
    ok(levels.size >= 2,
      `only one aggregate level came back (${[...levels].join(' ')}) — the HAVING chain lost a dimension`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nfailures:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
