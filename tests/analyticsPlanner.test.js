/**
 * Analytics planner — pure SQL-shape unit tests (no DB).
 * Run: node tests/analyticsPlanner.test.js
 *
 * The planner is the security boundary between the request JSON and SQL text:
 *   - the scope clause must be present on EVERY statement for non-global
 *     callers (and `1=0` for zero grants — fail-closed empty, never unscoped),
 *   - request strings must never reach SQL text (injection ids → 422),
 *   - the totals statement must be ROLLUP + GROUPING flags,
 *   - the default voided exclusion must be present, overridable, and honest
 *     (skipped when the statement computes a voids_* metric),
 *   - '?' placeholder counts must equal params.length on every statement
 *     (a drift here silently shifts every bound value one position).
 */
'use strict';

const planner = require('../lib/analytics/planner');
const compare = require('../lib/analytics/compare');
const { DEFAULT_MEAL_PERIODS } = require('../lib/analytics/mealPeriods');

let _passed = 0, _failed = 0;
function test(name, fn) {
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function qm(sql) { return (String(sql).match(/\?/g) || []).length; }
function expectErr(fn, code, http) {
  try { fn(); } catch (e) {
    ok(e.code === code, `expected code ${code}, got ${e.code}: ${e.message}`);
    if (http) ok(e.http === http, `expected http ${http}, got ${e.http}`);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

const GLOBAL = { all: true, brandIds: [], branchIds: [], caps: new Set(['analytics.view', 'analytics.cost.view', 'analytics.employees.view', 'analytics.customers.view']) };
const SCOPED = { all: false, brandIds: ['BR1'], branchIds: ['B1', 'B2'], caps: new Set(['analytics.view', 'analytics.employees.view']) };
const ZERO = { all: false, brandIds: [], branchIds: [], caps: new Set(['analytics.view']) };

const RANGE = { from: '2032-03-01', to: '2032-03-31' };
const req = (over = {}) => Object.assign({ metrics: ['net_ex_vat'], dimensions: ['branch'], range: RANGE }, over);

console.log('\n── scope clause ──');
test('scope clause present on EVERY statement for a non-global caller', () => {
  const p = planner.plan(req({ metrics: ['net_ex_vat', 'orders', 'payments_in'] }), SCOPED);
  ok(p.statements.length === 3, `expected 3 fact statements, got ${p.statements.length}`);
  for (const st of p.statements) {
    ok(/branch_id IN \(\?,\?\)/.test(st.rows.sql), `${st.fact}: rows stmt missing scope clause`);
    ok(/branch_id IN \(\?,\?\)/.test(st.totals.sql), `${st.fact}: totals stmt missing scope clause`);
    ok(st.rows.params.includes('B1') && st.rows.params.includes('B2'), `${st.fact}: scope params missing`);
  }
});
test('global caller gets NO scope clause', () => {
  const p = planner.plan(req(), GLOBAL);
  ok(!/branch_id IN \(/.test(p.statements[0].rows.sql), 'unexpected scope clause for admin');
});
test('zero grants → 1=0 (fail-closed empty, not unscoped)', () => {
  const p = planner.plan(req(), ZERO);
  ok(/ 1=0/.test(p.statements[0].rows.sql), 'expected 1=0 clause');
  ok(/ 1=0/.test(p.statements[0].totals.sql), 'expected 1=0 in totals too');
});

console.log('\n── injection ──');
test("metric id 'x; DROP TABLE sales' → ANALYTICS_UNKNOWN_METRIC, never SQL", () => {
  expectErr(() => planner.plan(req({ metrics: ['x; DROP TABLE sales--'] }), GLOBAL), 'ANALYTICS_UNKNOWN_METRIC', 422);
});
test("dimension id '1;DELETE' → ANALYTICS_UNKNOWN_DIMENSION", () => {
  expectErr(() => planner.plan(req({ dimensions: ['1;DELETE FROM x'] }), GLOBAL), 'ANALYTICS_UNKNOWN_DIMENSION', 422);
});
test('filter dimension injection → ANALYTICS_UNKNOWN_DIMENSION', () => {
  expectErr(() => planner.plan(req({ filters: [{ dimension: 'branch); DROP', op: 'eq', value: 'x' }] }), GLOBAL), 'ANALYTICS_UNKNOWN_DIMENSION', 422);
});
test('sort.by outside the requested set → VALIDATION_ERROR (allow-list)', () => {
  expectErr(() => planner.plan(req({ sort: [{ by: 'sales.total; --', dir: 'desc' }] }), GLOBAL), 'VALIDATION_ERROR', 422);
});
test('filter VALUES are parameterized, never inlined', () => {
  const p = planner.plan(req({ filters: [{ dimension: 'branch', op: 'in', values: ["x'); DROP TABLE sales; --"] }] }), GLOBAL);
  ok(!p.statements[0].rows.sql.includes('DROP'), 'filter value leaked into SQL text');
  ok(p.statements[0].rows.params.includes("x'); DROP TABLE sales; --"), 'filter value must be a bound param');
});

console.log('\n── totals statement shape ──');
test('totals = GROUP BY <exprs> WITH ROLLUP + GROUPING flag per dimension', () => {
  const p = planner.plan(req({ dimensions: ['branch', 'business_day'] }), GLOBAL);
  const t = p.statements[0].totals.sql;
  ok(/WITH ROLLUP$/.test(t.trim()), 'totals must end WITH ROLLUP');
  ok(/GROUPING\(f\.branch_id\) AS g0/.test(t), 'GROUPING flag g0 missing');
  // date dims are select-wrapped; GROUPING/GROUP BY must reuse the EXACT
  // wrapped expression (ONLY_FULL_GROUP_BY matches by text)
  ok(/GROUPING\(DATE_FORMAT\(f\.business_day, '%Y-%m-%d'\)\) AS g1/.test(t), 'GROUPING flag g1 missing/unwrapped');
  ok(/GROUP BY f\.branch_id, DATE_FORMAT\(f\.business_day, '%Y-%m-%d'\) WITH ROLLUP/.test(t), 'GROUP BY must reuse the wrapped exprs');
});
test('no dimensions → totals statement collapses to the plain aggregate', () => {
  const p = planner.plan(req({ dimensions: [] }), GLOBAL);
  ok(!/ROLLUP/.test(p.statements[0].totals.sql), 'no-dim request must not ROLLUP');
  ok(!/GROUP BY/.test(p.statements[0].rows.sql), 'no-dim request must not GROUP BY');
});

console.log('\n── default filters ──');
test("default voided exclusion present + reported in defaultsApplied", () => {
  const p = planner.plan(req(), GLOBAL);
  ok(/f\.status <> 'voided'/.test(p.statements[0].rows.sql), 'voided exclusion missing');
  ok(p.meta.defaultsApplied.includes('excluded_voided'), 'excluded_voided not reported');
});
test('an explicit order_status filter OVERRIDES the voided default', () => {
  const p = planner.plan(req({ filters: [{ dimension: 'order_status', op: 'eq', value: 'voided' }] }), GLOBAL);
  ok(!/status <> 'voided'/.test(p.statements[0].rows.sql), 'default must yield to the explicit filter');
  ok(!p.meta.defaultsApplied.includes('excluded_voided'), 'must not report an unapplied default');
});
test('includeVoided:true overrides the voided default', () => {
  const p = planner.plan(req({ includeVoided: true }), GLOBAL);
  ok(!/status <> 'voided'/.test(p.statements[0].rows.sql), 'includeVoided must lift the default');
});
test('voids_count statement does NOT self-exclude voided rows', () => {
  const p = planner.plan(req({ metrics: ['voids_count', 'voids_value'] }), GLOBAL);
  ok(!/status <> 'voided'/.test(p.statements[0].rows.sql), 'a voids metric must see voided rows');
});
test('credit-note docs excluded by default; source filter overrides', () => {
  const p1 = planner.plan(req(), GLOBAL);
  ok(/NOT IN \('sales_return','credit_note'\)/.test(p1.statements[0].rows.sql), 'CN exclusion missing');
  ok(p1.meta.defaultsApplied.includes('excluded_credit_note_docs'), 'CN default not reported');
  const p2 = planner.plan(req({ filters: [{ dimension: 'source', op: 'eq', value: 'sales_return' }] }), GLOBAL);
  ok(!/NOT IN \('sales_return','credit_note'\)/.test(p2.statements[0].rows.sql), 'source filter must override');
});
test('payment fact (no f alias) carries NO order-fact defaults', () => {
  const p = planner.plan(req({ metrics: ['payments_in'], dimensions: ['payment_method'] }), GLOBAL);
  ok(!/voided/.test(p.statements[0].rows.sql), 'payment stmt must not reference order status');
});

console.log('\n── placeholder discipline ──');
test('cross-fact filter the payment fact cannot express → ANALYTICS_UNSUPPORTED_COMBINATION', () => {
  expectErr(() => planner.plan(req({
    metrics: ['net_ex_vat', 'payments_in'],
    filters: [{ dimension: 'order_type', op: 'eq', value: 'dine_in' }],
  }), GLOBAL), 'ANALYTICS_UNSUPPORTED_COMBINATION', 422);
});
test('placeholders === params on rows AND totals (meal_period + filters + scope)', () => {
  const p = planner.plan({
    metrics: ['net_ex_vat', 'orders'],
    dimensions: ['meal_period', 'branch'],
    range: RANGE,
    filters: [
      { dimension: 'branch', op: 'in', values: ['B1', 'B2', 'B3'] },
      { dimension: 'order_type', op: 'not_in', values: ['delivery'] },
    ],
    sort: [{ by: 'net_ex_vat', dir: 'desc' }],
    limit: 10, offset: 5,
  }, SCOPED, { mealPeriods: DEFAULT_MEAL_PERIODS });
  for (const st of p.statements) {
    ok(qm(st.rows.sql) === st.rows.params.length,
      `${st.fact} rows: ${qm(st.rows.sql)} placeholders vs ${st.rows.params.length} params`);
    ok(qm(st.totals.sql) === st.totals.params.length,
      `${st.fact} totals: ${qm(st.totals.sql)} placeholders vs ${st.totals.params.length} params`);
  }
});

console.log('\n── validation & masking ──');
test('range REQUIRED', () => {
  expectErr(() => planner.plan({ metrics: ['orders'] }, GLOBAL), 'VALIDATION_ERROR', 422);
});
test('range > 400 days → ANALYTICS_RANGE_TOO_WIDE 422', () => {
  expectErr(() => planner.plan(req({ range: { from: '2031-01-01', to: '2032-12-31' } }), GLOBAL), 'ANALYTICS_RANGE_TOO_WIDE', 422);
});
test('cap-masked metrics stripped into meta.maskedMetrics', () => {
  const p = planner.plan(req({ metrics: ['net_ex_vat', 'cogs', 'gross_profit'] }), SCOPED);
  ok(p.meta.maskedMetrics.join(',') === 'cogs,gross_profit', `masked: ${p.meta.maskedMetrics}`);
  ok(p.meta.requestedMetrics.join(',') === 'net_ex_vat', 'only net should survive');
});
test('ALL metrics masked → 403 ANALYTICS_ALL_MASKED', () => {
  expectErr(() => planner.plan(req({ metrics: ['cogs', 'margin_pct'] }), SCOPED), 'ANALYTICS_ALL_MASKED', 403);
});
test('capability-gated dimension without the cap → 403 PERMISSION_DENIED', () => {
  const noEmp = { all: false, branchIds: ['B1'], caps: new Set(['analytics.view']) };
  expectErr(() => planner.plan(req({ dimensions: ['cashier'] }), noEmp), 'PERMISSION_DENIED', 403);
});
test('metric×dimension the fact cannot express → ANALYTICS_UNSUPPORTED_COMBINATION', () => {
  expectErr(() => planner.plan(req({ metrics: ['invoice_total'], dimensions: ['menu_item'] }), GLOBAL), 'ANALYTICS_UNSUPPORTED_COMBINATION', 422);
});
test('parameterized growth metric rejected as a direct request', () => {
  expectErr(() => planner.plan(req({ metrics: ['growth'] }), GLOBAL), 'VALIDATION_ERROR', 422);
});
test('more than 3 dimensions / 12 metrics rejected', () => {
  expectErr(() => planner.plan(req({ dimensions: ['branch', 'business_day', 'hour', 'weekday'] }), GLOBAL), 'VALIDATION_ERROR', 422);
});

console.log('\n── compare.shiftRange ──');
test('prevPeriod: equal-length window immediately before', () => {
  const r = compare.shiftRange({ from: '2032-03-01', to: '2032-03-31' }, 'prevPeriod');
  ok(r.from === '2032-01-30' && r.to === '2032-02-29', `got ${r.from}..${r.to}`);
});
test('prevYear: same dates minus one year; Feb-29 clamps', () => {
  const r1 = compare.shiftRange({ from: '2032-03-01', to: '2032-03-31' }, 'prevYear');
  ok(r1.from === '2031-03-01' && r1.to === '2031-03-31', `got ${r1.from}..${r1.to}`);
  const r2 = compare.shiftRange({ from: '2032-02-29', to: '2032-02-29' }, 'prevYear');
  ok(r2.from === '2031-02-28' && r2.to === '2031-02-28', `got ${r2.from}..${r2.to}`);
});

console.log(`\n${_failed === 0 ? '✅' : '❌'} analyticsPlanner: ${_passed} passed, ${_failed} failed`);
process.exit(_failed === 0 ? 0 : 1);
