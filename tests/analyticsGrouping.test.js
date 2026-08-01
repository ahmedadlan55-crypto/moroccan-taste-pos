/**
 * Grouping legality — the client's prediction must equal the planner's verdict.
 * Run: node tests/analyticsGrouping.test.js
 *
 * The Group By control offers every groupable dimension against every metric,
 * and disables the pairs the server would reject. That prediction is made on
 * the CLIENT, from registry data projected through /api/analytics/metadata. If
 * the prediction is wrong in either direction the feature is broken:
 *
 *   predicted legal, actually rejected  → the user picks it and the whole
 *                                         report goes red with a raw 422
 *   predicted illegal, actually legal   → a real grouping is greyed out and
 *                                         the user believes the data is absent
 *
 * So this does not test the module against a hand-written expectation of what
 * the rule is — a second copy of the same belief proves nothing. It runs the
 * REAL planner over EVERY metric × dimension pair in the registry (a few
 * thousand plans, all in-memory, no DB) and asserts the module's verdict
 * matches, pair for pair.
 *
 * Both the metadata route and the client model read this module, so agreement
 * here is agreement all the way to the screen.
 */
'use strict';

const planner = require('../lib/analytics/planner');
const METRICS = require('../lib/analytics/registry/metrics');
const DIMS = require('../lib/analytics/registry/dimensions');
const grouping = require('../lib/analytics/registry/grouping');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Every capability granted: this test is about the FACT graph, not masking.
// A cap-masked metric never reaches the fact partition at all, and the client
// never offers it either, so masking cannot change a verdict here.
const SCOPE = {
  caps: new Set([
    'analytics.view', 'analytics.cost.view',
    'analytics.employees.view', 'analytics.customers.view',
  ]),
};
// meal_period is unplannable without configured rows — the planner returns
// null for the dimension expression and raises the same UNSUPPORTED error it
// raises for a genuinely unsupported fact. One global row is enough to
// separate "not configured" from "not supported", which is what is under test.
const MEAL_PERIODS = [{ period_key: 'lunch', start_time: '11:00:00', end_time: '16:00:00', sort: 1 }];
const RANGE = { from: '2026-07-01', to: '2026-07-10' };

const ALL_METRICS = METRICS.METRICS.filter((m) => !m.takesMetricParam);
const GROUPABLE = DIMS.DIMENSIONS.filter((d) => d.groupable);

/** Ask the REAL planner. Only UNSUPPORTED_COMBINATION counts as "illegal". */
function plannerAccepts(metricId, dimId) {
  try {
    planner.plan(
      { metrics: [metricId], dimensions: [dimId], range: RANGE },
      SCOPE,
      { mealPeriods: MEAL_PERIODS },
    );
    return { legal: true };
  } catch (e) {
    if (e.code === 'ANALYTICS_UNSUPPORTED_COMBINATION') return { legal: false };
    // Anything else (unknown metric, masked, parameterized) is NOT a fact-graph
    // verdict and must not be silently read as one.
    return { legal: null, why: `${e.code}: ${e.message}` };
  }
}

test('the module agrees with the planner on EVERY metric × dimension pair', () => {
  const disagreements = [];
  let compared = 0;
  for (const m of ALL_METRICS) {
    for (const d of GROUPABLE) {
      const actual = plannerAccepts(m.id, d.id);
      if (actual.legal === null) continue; // not a fact-graph verdict
      compared++;
      const predicted = grouping.supports(m.id, d.id);
      if (predicted !== actual.legal) {
        disagreements.push(
          `${m.id} × ${d.id}: module says ${predicted ? 'legal' : 'illegal'}, planner says ${actual.legal ? 'legal' : 'illegal'}`,
        );
      }
    }
  }
  ok(compared > 1000, `only ${compared} pairs compared — the registry shrank or the probe broke`);
  ok(
    disagreements.length === 0,
    `${disagreements.length} of ${compared} pairs disagree:\n       ` + disagreements.slice(0, 12).join('\n       '),
  );
  console.log(`      (${compared} pairs compared)`);
});

/* ── the two traps the module was written to avoid ─────────────────────────
 * Both are pinned directly, because the sweep above would still pass if a
 * later edit broke them in a way that made the module and the planner wrong
 * TOGETHER (e.g. dropping meal_period's sourceColumn entirely).
 */
test('meal_period is groupable — reading only `facts` would report it dead', () => {
  const d = DIMS.byId.meal_period;
  ok(Object.keys(d.facts || {}).length === 0, 'precondition: meal_period has no `facts` map');
  ok(
    grouping.dimensionFacts('meal_period').length >= 4,
    'meal_period must report the facts its sourceColumn covers, not zero',
  );
  ok(grouping.supports('net_ex_vat', 'meal_period'), 'net sales by meal period must be groupable');
});

test('a derived metric needs EVERY input fact to support the dimension', () => {
  // margin_pct = f(net_ex_vat @line, cogs @line) — both on `line`.
  const facts = grouping.metricFacts('margin_pct');
  ok(facts.length > 0, 'margin_pct reported no facts — derived metrics were resolved as null');
  for (const input of METRICS.byId.margin_pct.inputs) {
    const f = METRICS.byId[input].fact;
    ok(facts.includes(f), `margin_pct omits its input ${input}'s fact "${f}"`);
  }
  // payment_method lives on the `payment` fact only, so a line-fact derived
  // metric can never be grouped by it — the planner agrees, checked above.
  ok(!grouping.supports('margin_pct', 'payment_method'), 'margin_pct by payment_method must be illegal');
});

test('discount_reason is backed by the order fact — the reserved id was filled', () => {
  // This test used to assert the OPPOSITE ("groupable in the contract but
  // supported by no fact") and said so deliberately: the id was reserved with
  // an empty `facts` map, and it was pinned so that the day a projector landed,
  // the test would fail and force this note to be rewritten rather than rot.
  // The projector landed — analytics_order_facts.discount_reason, written by
  // ProjectionService.projectPosSale from sales.discount_name — so the pin is
  // inverted and now guards the projection instead of its absence.
  ok(
    grouping.dimensionFacts('discount_reason').length > 0,
    'discount_reason lost its fact support — the projector or the registry map was removed',
  );
  const anyLegal = ALL_METRICS.some((m) => grouping.supports(m.id, 'discount_reason'));
  ok(anyLegal, 'no metric can group by discount_reason — the dimension is offered but unplannable');
  // The full behaviour (projection, NULL-vs-empty, replay) lives in
  // tests/analyticsDiscountReason.test.js; this file only owns the contract
  // that the module and the planner agree, which the sweep above enforces.
});

test('every groupable dimension has at least one metric that can group by it', () => {
  // discount_reason used to be exempted from this sweep by an explicit
  // `continue` — the one dimension the UI could offer and never satisfy. The
  // exemption is gone; a dimension nothing can group by now fails here.
  const dead = [];
  for (const d of GROUPABLE) {
    if (!ALL_METRICS.some((m) => grouping.supports(m.id, d.id))) dead.push(d.id);
  }
  ok(dead.length === 0, `groupable dimensions no metric can group by: ${dead.join(', ')}`);
});

/* ── the void-exclusion flag must agree with the PLANNER, not with a list ──
 *
 * planner.js:350-356 lifts the void exclusion for an ENTIRE fact statement
 * when any of its metrics mentions 'voided' in its SQL:
 *
 *     const hasVoidMetric = factMetrics.some((m) => String(m.sql).includes("'voided'"));
 *     if (!hasStatusFilter && req.includeVoided !== true && !hasVoidMetric) {
 *       whereParts.push("(f.status IS NULL OR f.status <> 'voided')");
 *     }
 *
 * The client cannot see SQL, so `liftsVoidExclusion` is projected per metric
 * through /api/analytics/metadata and drives which combinations the Explorer's
 * metric picker disables. A hardcoded list of "the void metrics" on either
 * side would drift the first time a metric is added — and drift silently, into
 * numbers that mix two populations. So the flag is checked against the SQL the
 * real planner actually emits, metric by metric.
 */
test('liftsVoidExclusion is true for exactly the metrics that drop the exclusion', () => {
  const disagreements = [];
  let checked = 0;
  for (const m of ALL_METRICS) {
    let sql;
    try {
      const p = planner.plan({ metrics: [m.id], dimensions: [], range: RANGE }, SCOPE, { mealPeriods: MEAL_PERIODS });
      sql = p.statements.map((st) => st.rows.sql).join(' ');
    } catch (e) {
      continue; // masked / parameterized — never reaches a fact statement
    }
    checked++;
    // The clause the planner adds ONLY when no void metric is present.
    const exclusionPresent = /<>\s*'voided'/.test(sql);
    const flag = grouping.liftsVoidExclusion(m.id);
    // flag === true  ⇒ the exclusion must be ABSENT
    // flag === false ⇒ the exclusion must be PRESENT (on a fact that has status)
    if (flag && exclusionPresent) {
      disagreements.push(`${m.id}: flagged as lifting the exclusion, but the SQL still carries it`);
    }
    if (!flag && !exclusionPresent && /analytics_order_facts/.test(sql)) {
      disagreements.push(`${m.id}: not flagged, yet the order-fact SQL has no void exclusion`);
    }
  }
  ok(checked > 30, `only ${checked} metrics planned — the probe broke`);
  ok(disagreements.length === 0, `${disagreements.length} disagree:\n       ` + disagreements.join('\n       '));
  console.log(`      (${checked} metrics planned and compared against emitted SQL)`);
});

console.log(`\nAnalytics grouping: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
