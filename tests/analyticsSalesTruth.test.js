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
}

// ── 6. Registry hygiene these fixes must not break ─────────────────────────
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
