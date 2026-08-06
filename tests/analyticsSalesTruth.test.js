#!/usr/bin/env node
'use strict';
/**
 * tests/analyticsSalesTruth.test.js — the four registry defects that made the
 * sales reports answer confidently and wrongly.
 *
 * Each of these shipped GREEN: nothing in the suite asserted the SHAPE of the
 * registry, only that its ids were unique and present. A report that returns a
 * number is indistinguishable from a report that returns the RIGHT number
 * unless something pins the relationship between a metric, its fact, and the
 * column it actually reads. That is what this file does.
 *
 * Run: npm run test:analytics-truth   (pure, no DB)
 */
const assert = require('assert');
const { METRICS, byId } = require('../lib/analytics/registry/metrics');
const { FACTS } = require('../lib/analytics/registry/facts');
const { DIMENSIONS } = require('../lib/analytics/registry/dimensions');

let pass = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  console.error('  ✗ ' + name);
}
const metric = (id) => METRICS.find((m) => m.id === id);
const dim = (id) => DIMENSIONS.find((d) => d.id === id);

// ── 1. Discount must be answerable BESIDE an item dimension ────────────────
// The planner partitions metrics by fact and requires every requested dimension
// to exist on that fact. discounts_total lives on `order`; menu_item does not.
// So "discount by item" returned 422 while ar_document_lines.discount_amount
// sat there populated on every sale.
{
  const dl = metric('discounts_line');
  check('discounts_line exists', !!dl);
  check('discounts_line is on the LINE fact (or item grouping 422s again)', dl && dl.fact === 'line', dl && dl.fact);
  check('discounts_line reads the per-line discount column', dl && /d\.discount_amount/.test(dl.sql), dl && dl.sql);

  const item = dim('menu_item');
  const category = dim('category');
  check('menu_item is available on the line fact', !!(item && item.facts && item.facts.line));
  check('category is available on the line fact', !!(category && category.facts && category.facts.line));
  // The actual legality rule the planner enforces.
  check('discount + item is now a LEGAL combination', !!(dl && item && item.facts[dl.fact]));
  check('discount + category is now a LEGAL combination', !!(dl && category && category.facts[dl.fact]));
  // The order-level metric must survive — it is the right one for day/payment views.
  const dt = metric('discounts_total');
  check('discounts_total is untouched on the order fact', dt && dt.fact === 'order', dt && dt.fact);
}

// ── 2. Category must group on a column that is actually written ────────────
// ProjectionService leaves category_id_snapshot NULL on every row ("there is no
// categories master table") and writes only the name. Grouping on the id put
// every sale in the system into ONE nameless bucket, and the page looked fine.
{
  const category = dim('category');
  check('category does NOT group on the always-NULL id column',
    category && !/category_id_snapshot/.test(String(category.facts.line)), category && category.facts.line);
  check('category groups on the populated name snapshot',
    category && /category_name_snapshot/.test(String(category.facts.line)), category && category.facts.line);
}

// ── 3. Returns must count only what actually happened ──────────────────────
// The return fact carried no status predicate, so drafts and cancelled returns
// were aggregated exactly like posted ones — inflating every returns figure and
// every profit figure taken net of returns.
{
  const rf = FACTS.return;
  check('the return fact exists', !!rf);
  check('the return fact filters to POSTED returns only',
    rf && /r\.status\s*=\s*'posted'/.test(rf.from), rf && rf.from);
  // The alias contract the registry test parses must still hold.
  check('return fact still declares exactly its real aliases',
    rf && rf.aliases.includes('rl') && rf.aliases.includes('r'));
}

// ── 4. Profit must be net of the cost of returned goods ────────────────────
// sales_return_lines.cost_snapshot has always been written and never read, so
// the cost of goods that came BACK stayed in COGS forever.
{
  const rc = metric('returns_cogs');
  check('returns_cogs exists', !!rc);
  check('returns_cogs is on the RETURN fact', rc && rc.fact === 'return', rc && rc.fact);
  check('returns_cogs reads the return line cost snapshot',
    rc && /rl\.cost_snapshot/.test(rc.sql), rc && rc.sql);
  const cogs = metric('cogs');
  check('returns_cogs is capability-gated exactly like cogs',
    rc && cogs && rc.requiresCap === cogs.requiresCap, rc && rc.requiresCap);

  const reversed = metric('returns_cogs_reversed');
  check('returns_cogs_reversed exists on the RETURN fact',
    reversed && reversed.fact === 'return', reversed && reversed.fact);
  check('profitability reads the exact amount persisted by the GL posting transaction',
    reversed && reversed.sql === 'SUM(rl.cogs_reversed_amount)', reversed && reversed.sql);
  check('profitability never re-derives reversed COGS from the rounded line snapshot',
    reversed && !/restock|cost_snapshot/.test(reversed.sql), reversed && reversed.sql);
  check('returns_cogs_reversed is capability-gated exactly like cogs',
    reversed && cogs && reversed.requiresCap === cogs.requiresCap, reversed && reversed.requiresCap);
}

// ── 5. A zero cost must be MEASURABLE, not just invisible ──────────────────
// cost_snapshot is 0.00 for any item with neither a recipe/BOM nor a manual
// cost, and summing that into `cogs` inflates gross_profit and margin_pct by
// exactly the uncosted revenue. A page grouped by menu_item can see a zero row
// itself; at any coarser grain (the executive summary) the gap vanishes into a
// non-zero group total. uncosted_net is the only server-side signal for it.
{
  const un = metric('uncosted_net');
  check('uncosted_net exists', !!un);
  check('uncosted_net is on the LINE fact (cost lives per line)',
    un && un.fact === 'line', un && un.fact);
  check('uncosted_net keys off a ZERO cost snapshot, not a null one',
    un && /COALESCE\(d\.cost_snapshot, 0\) = 0/.test(un.sql), un && un.sql);
  check('uncosted_net measures the NET revenue behind that zero cost',
    un && /d\.net_amount/.test(un.sql), un && un.sql);
  const cogsMetric = metric('cogs');
  check('uncosted_net is capability-gated exactly like cogs',
    un && cogsMetric && un.requiresCap === cogsMetric.requiresCap, un && un.requiresCap);
  // It must be additive: a derived metric would need an equation and would not
  // survive the ROLLUP total row the planner appends.
  check('uncosted_net is additive', un && un.kind === 'additive', un && un.kind);

  const unreturned = metric('uncosted_returns_net');
  check('uncosted_returns_net exists on the RETURN fact',
    unreturned && unreturned.fact === 'return', unreturned && unreturned.fact);
  check('uncosted return exposure counts restocked zero-cost OR unproven-COGS lines',
    unreturned && /rl\.restock/.test(unreturned.sql) &&
      /rl\.cogs_reversed_amount IS NULL/.test(unreturned.sql) &&
      /COALESCE\(rl\.cost_snapshot, 0\) = 0/.test(unreturned.sql) &&
      /rl\.net_amount/.test(unreturned.sql), unreturned && unreturned.sql);
}

// ── 6. A statement may not add figures from different tax bases ────────────
// The executive report printed
//   gross_product_sales − discounts_total − returns_net = net_ex_vat
// as if those were four points on one scale. They are not:
//   • d.gross_amount is net + VAT AFTER the discount (lineAllocation.js:263,
//     calculations.js:138) — tax-INCLUSIVE,
//   • f.discount_total is routes/sales.js:736 appliedDiscountTotal, recorded in
//     GROSS space and already removed from the line amounts,
//   • rl.net_amount is EX-VAT (SalesReturnService.js:92).
// The arithmetic is pinned in tests/analyticsStatementLadder.test.js; what is
// pinned HERE is the registry shape that makes a single-basis ladder possible
// at all — because a metric that does not exist cannot be put on a statement.
{
  const rv = metric('returns_vat');
  check('returns_vat exists (the ex-VAT ↔ incl-VAT bridge for returns)', !!rv);
  check('returns_vat is on the RETURN fact', rv && rv.fact === 'return', rv && rv.fact);
  check('returns_vat reads the STORED return VAT column, never a rate',
    rv && rv.sql === 'SUM(rl.vat_amount)', rv && rv.sql);

  // returns_net (ex-VAT) and returns_value (incl-VAT) are the two legal
  // subtrahends; which one is legal depends entirely on the minuend's basis.
  const rn = metric('returns_net');
  const rvl = metric('returns_value');
  check('returns_net reads the ex-VAT return column', rn && rn.sql === 'SUM(rl.net_amount)', rn && rn.sql);
  check('returns_value reads the incl-VAT return column', rvl && rvl.sql === 'SUM(rl.gross_amount)', rvl && rvl.sql);

  const nps = metric('net_product_sales');
  check('net_product_sales no longer subtracts the already-removed discount',
    nps && !nps.inputs.includes('discounts_total'), nps && nps.inputs);
  check('net_product_sales stays entirely on the INCL-VAT basis',
    nps && nps.inputs.join(',') === 'gross_product_sales,returns_value', nps && nps.inputs);
  check('net_product_sales is versioned as a REDEFINITION', nps && nps.version === 2, nps && nps.version);

  const npsx = metric('net_product_sales_ex_vat');
  check('net_product_sales_ex_vat exists (the ex-VAT bottom line)', !!npsx);
  check('net_product_sales_ex_vat stays entirely on the EX-VAT basis',
    npsx && npsx.inputs.join(',') === 'net_ex_vat,returns_net', npsx && npsx.inputs);

  const sbd = metric('sales_before_discount');
  check('sales_before_discount exists (the reconstructed top line)', !!sbd);
  check('sales_before_discount ADDS the discount back rather than subtracting it',
    sbd && sbd.equationKey === 'salesBeforeDiscount', sbd && sbd.equationKey);
  check('sales_before_discount reconstructs in GROSS space (both inputs incl VAT)',
    sbd && sbd.inputs.join(',') === 'gross_product_sales,discounts_total', sbd && sbd.inputs);

  const sv = metric('statement_variance');
  check('statement_variance exists (headers vs lines, shown not hidden)', !!sv);
  check('statement_variance compares the two invoice totals and nothing else',
    sv && sv.inputs.join(',') === 'invoice_total,gross_product_sales', sv && sv.inputs);

  // fees_total is sales.kita_service_fee, persisted BESIDE total_final and never
  // inside it (routes/sales.js:753 builds invTotal from the line buckets alone),
  // and rounding_amount is written as a literal 0 (ProjectionService.js:284).
  // Neither may become an input to any derived metric — that is how they got
  // onto the ladder in the first place.
  for (const m of METRICS) {
    if (m.kind !== 'derived' || !Array.isArray(m.inputs)) continue;
    check(`derived metric "${m.id}" does not treat fees as invoice money`,
      !m.inputs.includes('fees_total'), m.inputs);
    check(`derived metric "${m.id}" does not treat the rounding column as invoice money`,
      !m.inputs.includes('rounding_total'), m.inputs);
  }
}

// ── 7. Registry hygiene these fixes must not break ─────────────────────────
{
  const ids = METRICS.map((m) => m.id);
  check('metric ids remain unique', new Set(ids).size === ids.length);
  for (const m of METRICS) {
    if (m.kind !== 'additive') continue;
    check(`additive metric "${m.id}" names a real fact`, !!FACTS[m.fact], m.fact);
  }
  // byId is the lookup the planner uses; a new metric absent from it is invisible.
  if (typeof byId === 'function') {
    check('discounts_line is reachable through byId', !!byId('discounts_line'));
    check('returns_cogs is reachable through byId', !!byId('returns_cogs'));
    check('uncosted_net is reachable through byId', !!byId('uncosted_net'));
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
assert.ok(pass >= 20, 'expected the full matrix to run');
console.log('✅ analytics sales truth: discount-by-item legal, category groups on a real column, returns posted-only, profit net of return cost');
