/**
 * Analytics registry invariants — static contract tests (no DB).
 * Run: node tests/analyticsRegistry.test.js
 *
 * The registries (facts/dimensions/metrics) are data that a query planner
 * will trust blindly, so their internal consistency IS the security and
 * correctness boundary:
 *   - every additive metric binds to exactly one existing fact,
 *   - every SQL expression references ONLY aliases of its fact's constant
 *     join graph (no smuggled cross-fact joins),
 *   - no VAT constant hides in any SQL string,
 *   - every additive metric has format + equationKey (+ version),
 *   - every derived metric's equationKey is a real equations.js function and
 *     its inputs are real metric ids,
 *   - the full metric dictionary the sprint promised is actually present,
 *   - cost/profit metrics carry the cost capability gate.
 */
'use strict';

const facts = require('../lib/analytics/registry/facts');
const dims = require('../lib/analytics/registry/dimensions');
const metrics = require('../lib/analytics/registry/metrics');
const equations = require('../lib/analytics/equations');

let _passed = 0, _failed = 0, _total = 0;
function test(name, fn) {
  _total++;
  try { fn(); _passed++; console.log('  ✅', name); }
  catch (e) { _failed++; console.log('  ❌', name); console.log('     ', e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

/** Aliases referenced by a SQL expression: every `ident.` prefix. */
function referencedAliases(sqlExpr) {
  const out = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g;
  let m;
  while ((m = re.exec(sqlExpr))) out.add(m[1]);
  return [...out];
}

const VAT_PATTERNS = [/\b1\.15\b/, /\b0\.15\b/, /\/\s*115\b/, /\b15\s*%/];

console.log('\n── facts catalog ──');
test('every fact declares from/aliases/dateBases/scopeColumn', () => {
  for (const [id, f] of Object.entries(facts.FACTS)) {
    ok(typeof f.from === 'string' && f.from.startsWith('FROM '), `${id}: from must be a FROM clause`);
    ok(Array.isArray(f.aliases) && f.aliases.length > 0, `${id}: aliases missing`);
    ok(f.dateBases && f.dateBases.business_day, `${id}: business_day date basis missing`);
    ok(typeof f.scopeColumn === 'string' && f.scopeColumn.includes('.'), `${id}: scopeColumn missing`);
  }
});
test('declared aliases match the aliases actually present in the FROM clause', () => {
  for (const [id, f] of Object.entries(facts.FACTS)) {
    // Table aliases appear as '<table> <alias>' after FROM/JOIN.
    const found = new Set();
    const re = /(?:FROM|JOIN)\s+`?\w+`?\s+(\w+)/g;
    let m;
    while ((m = re.exec(f.from))) found.add(m[1]);
    for (const a of f.aliases) ok(found.has(a), `${id}: declared alias "${a}" not in FROM clause`);
    for (const a of found) ok(f.aliases.includes(a), `${id}: FROM clause alias "${a}" not declared`);
  }
});
test('every fact dateBase and scopeColumn references only its own aliases', () => {
  for (const [id, f] of Object.entries(facts.FACTS)) {
    for (const [basis, col] of Object.entries(f.dateBases)) {
      for (const a of referencedAliases(col)) {
        ok(f.aliases.includes(a), `${id}.dateBases.${basis}: alias "${a}" not in join graph`);
      }
    }
    for (const a of referencedAliases(f.scopeColumn)) {
      ok(f.aliases.includes(a), `${id}.scopeColumn: alias "${a}" not in join graph`);
    }
  }
});

console.log('\n── additive metrics ──');
test('every additive metric binds to exactly one EXISTING fact', () => {
  for (const m of metrics.additive) {
    ok(typeof m.fact === 'string', `${m.id}: fact missing`);
    ok(!!facts.FACTS[m.fact], `${m.id}: unknown fact "${m.fact}"`);
    ok(!Array.isArray(m.fact), `${m.id}: a metric may not span facts`);
  }
});
test('every additive SQL expression stays inside its fact join graph', () => {
  for (const m of metrics.additive) {
    const allowed = facts.FACTS[m.fact].aliases;
    for (const a of referencedAliases(m.sql)) {
      ok(allowed.includes(a), `${m.id}: sql references alias "${a}" outside fact "${m.fact}" (${allowed.join(',')})`);
    }
  }
});
test('every additive metric has format + equationKey + version', () => {
  for (const m of metrics.additive) {
    ok(typeof m.format === 'string' && m.format.length > 0, `${m.id}: format missing`);
    ok(typeof m.equationKey === 'string' && m.equationKey.length > 0, `${m.id}: equationKey missing`);
    ok(Number.isInteger(m.version) && m.version >= 1, `${m.id}: version missing`);
  }
});
test('additive equationKeys are sum/count or a real equations.js function', () => {
  for (const m of metrics.additive) {
    if (m.equationKey === 'sum' || m.equationKey === 'count') continue;
    ok(typeof equations[m.equationKey] === 'function', `${m.id}: equationKey "${m.equationKey}" is not an equations.js function`);
  }
});

console.log('\n── derived metrics ──');
test('every derived equationKey is a real equations.js function', () => {
  for (const m of metrics.derived) {
    ok(typeof equations[m.equationKey] === 'function', `${m.id}: equationKey "${m.equationKey}" is not an equations.js function`);
  }
});
test('every derived input names an existing metric (growth is parameterized)', () => {
  for (const m of metrics.derived) {
    if (m.takesMetricParam) {
      ok(m.inputs.length === 0, `${m.id}: parameterized metrics take no fixed inputs`);
      continue;
    }
    ok(Array.isArray(m.inputs) && m.inputs.length > 0, `${m.id}: inputs missing`);
    for (const input of m.inputs) {
      ok(!!metrics.byId[input], `${m.id}: input "${input}" is not a registered metric`);
    }
  }
});
test('derived metrics carry no SQL of their own', () => {
  for (const m of metrics.derived) ok(m.sql === undefined, `${m.id}: derived metrics must not have sql`);
});

console.log('\n── dimensions ──');
test('every dimension fact key exists and its expr stays inside that join graph', () => {
  for (const d of dims.DIMENSIONS) {
    for (const [factId, expr] of Object.entries(d.facts)) {
      ok(!!facts.FACTS[factId], `${d.id}: unknown fact "${factId}"`);
      const allowed = facts.FACTS[factId].aliases;
      for (const a of referencedAliases(expr)) {
        ok(allowed.includes(a), `${d.id}[${factId}]: alias "${a}" outside join graph (${allowed.join(',')})`);
      }
    }
    ok(Array.isArray(d.ops) && d.ops.length > 0, `${d.id}: ops missing`);
    ok(typeof d.groupable === 'boolean', `${d.id}: groupable missing`);
  }
});
test('meal_period is derived-js with a JS source column, never SQL', () => {
  const mp = dims.byId.meal_period;
  ok(mp && mp.kind === 'derived-js', 'meal_period must be derived-js');
  ok(Object.keys(mp.facts).length === 0, 'meal_period must have no SQL exprs');
  ok(mp.sourceColumn && mp.sourceColumn.order, 'meal_period needs a source timestamp column');
});
test('employee dimensions are capability-gated', () => {
  for (const id of ['cashier', 'salesperson', 'payment_collector', 'discount_by', 'void_by', 'approved_by', 'closed_by']) {
    const d = dims.byId[id];
    ok(!!d, `dimension ${id} missing`);
    ok(d.requiresCap === 'analytics.employees.view', `${id} must require analytics.employees.view`);
  }
});
test('customer dimension is capability-gated', () => {
  ok(dims.byId.customer.requiresCap === 'analytics.customers.view', 'customer must require analytics.customers.view');
});

console.log('\n── VAT discipline ──');
test('no VAT constant in ANY sql string (metrics, dimensions, facts)', () => {
  const sqlStrings = [];
  for (const m of metrics.additive) sqlStrings.push([`metric ${m.id}`, m.sql]);
  for (const d of dims.DIMENSIONS) {
    for (const [factId, expr] of Object.entries(d.facts)) sqlStrings.push([`dim ${d.id}[${factId}]`, expr]);
  }
  for (const [id, f] of Object.entries(facts.FACTS)) {
    sqlStrings.push([`fact ${id}`, f.from]);
    for (const [basis, col] of Object.entries(f.dateBases)) sqlStrings.push([`fact ${id}.${basis}`, col]);
  }
  for (const [where, sql] of sqlStrings) {
    for (const re of VAT_PATTERNS) {
      ok(!re.test(sql), `VAT constant ${re} found in ${where}: ${sql}`);
    }
  }
});
test('vat_amount sums a stored column, never an expression over net', () => {
  const m = metrics.byId.vat_amount;
  ok(m.sql === 'SUM(d.vat_amount)', `vat_amount must read the stored column, got: ${m.sql}`);
});

console.log('\n── dictionary coverage + capability gates ──');
test('the full promised metric dictionary is present', () => {
  const required = [
    'gross_product_sales', 'discounts_total', 'returns_net', 'net_ex_vat',
    'vat_amount', 'net_incl_vat', 'invoice_total', 'orders', 'guests',
    'qty_sold', 'qty_returned', 'qty_net', 'avg_ticket', 'avg_items_per_order',
    'discount_pct', 'voids_count', 'voids_value', 'returns_count',
    'returns_value', 'returns_vat', 'sales_before_discount',
    'net_product_sales', 'net_product_sales_ex_vat', 'statement_variance',
    'cogs', 'returns_cogs_reversed', 'uncosted_returns_net', 'gross_profit', 'margin_pct',
    'cogs_after_returns', 'gross_profit_after_returns',
    'margin_pct_after_returns', 'payments_in',
    'refunds_out', 'net_collections', 'tips_total', 'fees_total',
    'rounding_total', 'till_expected_cash', 'till_counted', 'till_variance',
    'item_contribution_pct', 'attach_rate', 'modifiers_per_item', 'growth',
    'budget_amount', 'discount_rate_by_cashier', 'void_rate_by_cashier',
    'return_rate_by_cashier',
  ];
  for (const id of required) ok(!!metrics.byId[id], `metric "${id}" missing from the dictionary`);
});
test('cost and profit metrics require analytics.cost.view', () => {
  for (const id of [
    'cogs', 'returns_cogs_reversed', 'uncosted_returns_net', 'gross_profit', 'margin_pct',
    'cogs_after_returns', 'gross_profit_after_returns', 'margin_pct_after_returns',
  ]) {
    ok(metrics.byId[id].requiresCap === 'analytics.cost.view', `${id} must require analytics.cost.view`);
  }
});
test('after-return profit metrics use the four stored, single-basis operands', () => {
  const expectedInputs = 'net_ex_vat,cogs,returns_net,returns_cogs_reversed';
  const netCogs = metrics.byId.cogs_after_returns;
  const gp = metrics.byId.gross_profit_after_returns;
  const margin = metrics.byId.margin_pct_after_returns;
  ok(netCogs.kind === 'derived', 'after-return COGS must be derived');
  ok(netCogs.inputs.join(',') === 'cogs,returns_cogs_reversed', `net COGS inputs drifted: ${netCogs.inputs}`);
  ok(netCogs.equationKey === 'cogsAfterReturns', `wrong net-COGS equation: ${netCogs.equationKey}`);
  ok(netCogs.format === 'money', 'net COGS must be formatted as money');
  ok(gp.kind === 'derived' && margin.kind === 'derived', 'after-return profitability must be derived');
  ok(gp.inputs.join(',') === expectedInputs, `gross profit inputs drifted: ${gp.inputs}`);
  ok(margin.inputs.join(',') === expectedInputs, `margin inputs drifted: ${margin.inputs}`);
  ok(gp.equationKey === 'grossProfitAfterReturns', `wrong gross-profit equation: ${gp.equationKey}`);
  ok(margin.equationKey === 'marginPctAfterReturns', `wrong margin equation: ${margin.equationKey}`);
  ok(gp.format === 'money', 'gross profit must be formatted as money');
  ok(margin.format === 'percent', 'margin must be formatted as percent');
  // Nested derived inputs are rejected by the planner. Pin the raw inputs so a
  // tempting refactor through net_product_sales_ex_vat/gross_profit cannot
  // make the metrics unplannable at runtime.
  for (const input of gp.inputs) {
    ok(metrics.byId[input].kind === 'additive', `${input} must remain an additive planner input`);
  }
});
test('metric ids are unique', () => {
  const seen = new Set();
  for (const m of metrics.METRICS) {
    ok(!seen.has(m.id), `duplicate metric id ${m.id}`);
    seen.add(m.id);
  }
});
test('dimension ids are unique', () => {
  const seen = new Set();
  for (const d of dims.DIMENSIONS) {
    ok(!seen.has(d.id), `duplicate dimension id ${d.id}`);
    seen.add(d.id);
  }
});

/* ── a redefined metric must stay DETECTABLE by a stale consumer ────────────
 *
 * `net_product_sales` was redefined (v1 → v2). A saved view and a scheduled
 * export both store METRIC IDS, not definitions, so an old view keeps asking
 * for the same id and now receives a different number. That is acceptable —
 * v1 was a three-basis subtraction that reconciled to nothing — but only if
 * the change is DETECTABLE rather than silent. Two things make it so, and both
 * are one careless edit away from being lost, so both are pinned here:
 *
 *   1. `version` is bumped, and routes/analytics/metadata.js:65 projects it to
 *      every client, so a stale consumer can compare rather than guess;
 *   2. an ex-VAT twin exists, so anyone who actually wanted the ex-VAT figure
 *      has an id to move to instead of being silently re-based.
 */
test('a redefined metric carries version > 1 so a stale saved view is detectable', () => {
  const m = metrics.byId['net_product_sales'];
  ok(m, 'net_product_sales missing');
  ok(m.version > 1, 'net_product_sales was redefined — its version must be bumped past 1');
});
test('every metric declares an integer version (metadata projects it verbatim)', () => {
  for (const m of metrics.METRICS) {
    ok(Number.isInteger(m.version) && m.version >= 1, `metric "${m.id}" has no integer version`);
  }
});
test('the redefined incl-VAT metric keeps an ex-VAT twin to move to', () => {
  ok(
    metrics.byId['net_product_sales_ex_vat'],
    'net_product_sales_ex_vat missing — a consumer that wanted ex-VAT has nowhere to go',
  );
});

console.log(`\nAnalytics registry: ${_passed}/${_total} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
