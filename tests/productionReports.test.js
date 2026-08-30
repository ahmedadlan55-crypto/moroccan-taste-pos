#!/usr/bin/env node
'use strict';
/**
 * Production yield / WIP, and recipe standard-vs-actual.
 *
 * ─── WHY THESE REPORTS EXIST ────────────────────────────────────────────────
 * They were declared unbuildable "because the source data does not exist".
 * That was wrong. `production_orders` carries qty_planned / qty_produced /
 * qty_scrap and the three cost buckets; `production_consumption` carries
 * qty_planned AND qty_actual on the SAME row, which is the entire
 * standard-vs-actual report as a subtraction. The tables are empty on some
 * deployments — an empty report, not a missing source. Conflating those two is
 * what kept both reports off the catalogue.
 *
 * ─── WHAT THESE ASSERTIONS PIN ──────────────────────────────────────────────
 * Arithmetic that is wrong in a way nobody can see:
 *   · a yield/scrap percentage taken against the wrong denominator,
 *   · a total yield averaged from per-order percentages, so a 2-unit order
 *     weighs the same as a 2,000-unit one,
 *   · WIP defined by status text rather than by "released and not completed",
 *   · a null percentage rendered as 0, which reads as "produced nothing"
 *     instead of "there was nothing planned".
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
function stub(rel, exports) {
  const resolved = require.resolve(path.join(ROOT, rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Four orders, each present for a reason — see the note above each one.
const ORDERS = [
  {
    id: 'PO-1', order_number: 'PRD-001', product_id: 'ITM-A', status: 'completed',
    product_name: 'كيك', warehouse_id: 'W1', planned_date: '2026-01-01',
    released_at: '2026-01-02 08:00:00', completed_at: '2026-01-03 08:00:00',
    qty_planned: 100, qty_produced: 90, qty_scrap: 10,
    materials_cost: 700, labor_cost: 200, overhead_cost: 100, total_cost: 1000, unit_cost: 11.11,
    output_waste_qty: 2, output_waste_cost: 25,
  },
  {
    id: 'PO-2', order_number: 'PRD-002', product_id: 'ITM-B', status: 'released',
    product_name: 'خبز', warehouse_id: 'W1', planned_date: '2026-01-05',
    released_at: '2026-01-06 08:00:00', completed_at: null,
    qty_planned: 300, qty_produced: 10, qty_scrap: 0,
    materials_cost: 400, labor_cost: 60, overhead_cost: 40, total_cost: 500, unit_cost: 50,
    output_waste_qty: 0, output_waste_cost: 0,
  },
  // PO-3 exists to SEPARATE the two scrap formulas. In PO-1 produced+scrap
  // happens to equal the plan (90+10 = 100), so scrap/(produced+scrap) and
  // scrap/planned both give 10% and a test built only on it cannot tell them
  // apart — a fixture that agrees with the bug proves nothing. Here the line
  // over-delivered: 60+10 = 70 against a plan of 50, so the correct formula
  // gives 14.29% and the wrong one 20%.
  {
    id: 'PO-3', order_number: 'PRD-003', product_id: 'ITM-C', status: 'completed',
    product_name: 'معجنات', warehouse_id: 'W1', planned_date: '2026-01-08',
    released_at: '2026-01-09 08:00:00', completed_at: '2026-01-10 08:00:00',
    qty_planned: 50, qty_produced: 60, qty_scrap: 10,
    materials_cost: 240, labor_cost: 40, overhead_cost: 20, total_cost: 300, unit_cost: 5,
    output_waste_qty: 0, output_waste_cost: 0,
  },
  // PO-4 exists to exercise a ZERO denominator: nothing planned, nothing made.
  // Without it no assertion ever distinguishes "null because there was nothing
  // to divide by" from a rendered 0%, which reads as "produced nothing".
  {
    id: 'PO-4', order_number: 'PRD-004', product_id: 'ITM-D', status: 'draft',
    product_name: 'تجربة', warehouse_id: 'W1', planned_date: '2026-01-11',
    released_at: null, completed_at: null,
    qty_planned: 0, qty_produced: 0, qty_scrap: 0,
    materials_cost: 0, labor_cost: 0, overhead_cost: 0, total_cost: 0, unit_cost: 0,
    output_waste_qty: 0, output_waste_cost: 0,
  },
];

// Standard 10 @ 5.00 ; actual 12 @ 5.00 → +2 qty, +10.00 cost.
const CONSUMPTION = [
  {
    order_id: 'PO-1', order_number: 'PRD-001', status: 'completed', product_name: 'كيك',
    item_id: 'ITM-FLOUR', component_name: 'دقيق', unit: 'KG',
    qty_planned: 10, qty_actual: 12, unit_cost: 5, total_cost: 60,
  },
  {
    order_id: 'PO-1', order_number: 'PRD-001', status: 'completed', product_name: 'كيك',
    item_id: 'ITM-SUGAR', component_name: 'سكر', unit: 'KG',
    qty_planned: 4, qty_actual: 3, unit_cost: 2, total_cost: 6,
  },
];

stub('db/connection.js', {
  query: async (sql) => {
    const s = String(sql);
    if (/FROM production_consumption/.test(s)) return [CONSUMPTION];
    if (/FROM production_orders/.test(s)) return [ORDERS];
    return [[]];
  },
});
stub('middleware/requireCapability.js', Object.assign(
  () => (_req, _res, next) => next(),
  { hasCapability: async () => true },
));

const express = require(path.join(ROOT, 'node_modules', 'express'));
const app = express();
app.use((req, _res, next) => { req.user = { username: 't' }; req.requestId = 'test'; next(); });
app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'production.js')));

function get(server, url) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: url }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    // ── Yield / WIP ────────────────────────────────────────────────────────
    const y = await get(server, '/api/erp/reports/production-yield?from=2026-01-01&to=2026-01-31');
    eq('yield report answers 200', y.status, 200);
    const [o1, o2, o3, o4] = y.json.data;

    eq('yield is produced ÷ planned', o1.yieldPct, 90);
    // Scrap is a share of what came off the line (produced + scrap), not of the
    // plan: measured against the plan, an over-delivered order reports less
    // scrap than it actually made.
    eq('scrap is a share of total output, not of the plan', o1.scrapPct, 10);
    // The case that actually separates the two formulas: 10 / (60+10) = 14.29,
    // where scrap-against-plan would say 10 / 50 = 20.
    eq('an over-delivering order proves the denominator', o3.scrapPct, 14.29);
    check('scrap is NOT measured against the plan', o3.scrapPct !== 20, o3.scrapPct);
    eq('an over-delivery yields above 100%, it is not clamped', o3.yieldPct, 120);
    // Zero planned: there was nothing to divide by. 0% would read as
    // "produced nothing", which is a different and false claim.
    eq('a zero-plan order has NO yield percentage', o4.yieldPct, null);
    eq('a zero-output order has NO scrap percentage', o4.scrapPct, null);
    eq('a low-yield order is reported low, not hidden', o2.yieldPct, 3.33);

    // WIP = released AND not completed. Not a status string: `released` is one
    // of several states an unfinished order can sit in, and the pair of
    // timestamps is what actually defines work in progress.
    eq('a completed order is not WIP', o1.isWip, false);
    eq('a released, uncompleted order IS WIP', o2.isWip, true);
    eq('WIP is counted', y.json.totals.wipOrders, 1);
    eq('WIP carries its cost — capital on the factory floor', y.json.totals.wipCost, 500);

    // The weighting trap.
    eq('total yield is quantity-weighted', y.json.totals.yieldPct, 35.56);
    const meanOfPercentages = Math.round(((o1.yieldPct + o2.yieldPct) / 2) * 100) / 100;
    check('total yield is NOT the mean of the per-order percentages',
      y.json.totals.yieldPct !== meanOfPercentages, { weighted: y.json.totals.yieldPct, mean: meanOfPercentages });

    eq('waste cost rolls up', y.json.totals.wasteCost, 25);
    eq('total cost rolls up', y.json.totals.totalCost, 1800);
    // Completeness travels with the report, like every other snapshot.
    eq('the yield report declares itself complete', y.json.complete, true);
    eq('it reports its row count', y.json.rowCount, 4);

    // ── Recipe standard vs actual ──────────────────────────────────────────
    const v = await get(server, '/api/erp/reports/recipe-variance?from=2026-01-01&to=2026-01-31');
    eq('variance report answers 200', v.status, 200);
    const flour = v.json.data.find((r) => r.itemId === 'ITM-FLOUR');
    const sugar = v.json.data.find((r) => r.itemId === 'ITM-SUGAR');

    eq('an over-consumption is a positive variance', flour.qtyVariance, 2);
    eq('an under-consumption is a negative variance', sugar.qtyVariance, -1);
    eq('variance percentage is against the STANDARD', flour.qtyVariancePct, 20);
    // Valued at the standard price — the classic decomposition.
    eq('quantity variance is valued', flour.qtyVarianceCost, 10);
    eq('an under-run returns money', sugar.qtyVarianceCost, -2);
    eq('standard cost is standard qty × unit cost', flour.standardCost, 50);
    eq('actual cost is what was recorded', flour.actualCost, 60);

    // The schema stores ONE cost per consumption row, so price variance cannot
    // be separated from quantity variance. Reported as unavailable rather than
    // as zero: "no price variance" and "we cannot see it" are different claims.
    eq('price variance is declared unavailable, not zero', flour.priceVarianceCost, null);
    eq('and the totals say so too', v.json.totals.priceVarianceAvailable, false);

    // 56 actual (60+6) vs 58 standard (50+8) = −2.
    eq('total standard cost', v.json.totals.standardCost, 58);
    eq('total actual cost', v.json.totals.actualCost, 66);
    eq('total variance is actual − standard', v.json.totals.totalVariance, 8);
    eq('the quantity variances sum to the total here', v.json.totals.qtyVarianceCost, 8);
    eq('distinct orders are counted, not lines', v.json.totals.orders, 1);
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
  console.log('  ✅ yield weighted by quantity, WIP by timestamps, variance valued at standard');
  console.log(pass + '/' + pass + ' passed');
})();
