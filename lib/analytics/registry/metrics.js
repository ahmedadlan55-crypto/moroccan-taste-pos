/**
 * lib/analytics/registry/metrics.js — the metric dictionary.
 *
 * TWO KINDS:
 *   additive — bound to EXACTLY ONE fact (registry/facts.js), with a SQL
 *              aggregate expression whose aliases must belong to that fact's
 *              constant join graph. Additive metrics are what the planner
 *              actually runs; they re-aggregate safely across any dimension.
 *   derived  — a JS equation (lib/analytics/equations.js) over the values of
 *              other metrics. Never SQL, never a fourth rounding contract:
 *              the equation functions own the arithmetic.
 *
 * Every additive metric carries:
 *   { id, kind: 'additive', fact, sql, format, equationKey, version,
 *     requiresCap? }
 * Every derived metric carries:
 *   { id, kind: 'derived', equationKey, inputs: [metricId...], format,
 *     version, requiresCap? }
 *
 * equationKey names the equations.js function that defines the metric's
 * arithmetic ('sum' / 'count' for plain aggregates — those two are the only
 * keys with no equations.js function behind them).
 *
 * VAT DISCIPLINE: vat_amount sums the STORED d.vat_amount column. No metric
 * derives VAT from a rate, and no SQL string contains a tax constant — the
 * registry test and scripts/audit/analytics-no-vat-constant.js both enforce
 * this.
 *
 * growth is PARAMETERIZED: it applies equations.growth(current, previous) to
 * any base metric across two periods. Its `inputs` name no metric ids —
 * `takesMetricParam: true` tells the planner (and the registry test) that the
 * caller supplies the base metric.
 */
'use strict';

const CAP_COST = 'analytics.cost.view';

const METRICS = Object.freeze([
  // ── additive: product money (line fact) ───────────────────────────────────
  {
    id: 'gross_product_sales', kind: 'additive', fact: 'line',
    sql: 'SUM(d.gross_amount)', format: 'money',
    equationKey: 'grossProductSales', version: 1,
  },
  {
    id: 'discounts_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.discount_total)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'returns_net', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.net_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'net_ex_vat', kind: 'additive', fact: 'line',
    sql: 'SUM(d.net_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'vat_amount', kind: 'additive', fact: 'line',
    sql: 'SUM(d.vat_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'invoice_total', kind: 'additive', fact: 'order',
    sql: 'SUM(doc.total_amount)', format: 'money',
    equationKey: 'invoiceTotal', version: 1,
  },

  // ── additive: counts (order fact) ─────────────────────────────────────────
  {
    id: 'orders', kind: 'additive', fact: 'order',
    sql: 'COUNT(*)', format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'guests', kind: 'additive', fact: 'order',
    sql: 'SUM(COALESCE(f.guests, 0))', format: 'count',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'discounted_orders', kind: 'additive', fact: 'order',
    sql: 'SUM(CASE WHEN f.discount_total > 0 THEN 1 ELSE 0 END)', format: 'count',
    equationKey: 'count', version: 1,
  },

  // ── additive: quantities ──────────────────────────────────────────────────
  {
    id: 'qty_sold', kind: 'additive', fact: 'line',
    sql: 'SUM(d.base_qty)', format: 'qty',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'qty_returned', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.base_qty)', format: 'qty',
    equationKey: 'sum', version: 1,
  },

  // ── additive: voids / returns ─────────────────────────────────────────────
  {
    id: 'voids_count', kind: 'additive', fact: 'order',
    sql: "SUM(CASE WHEN f.status = 'voided' THEN 1 ELSE 0 END)", format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'voids_value', kind: 'additive', fact: 'order',
    sql: "SUM(CASE WHEN f.status = 'voided' THEN doc.total_amount ELSE 0 END)", format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'returns_count', kind: 'additive', fact: 'return',
    sql: 'COUNT(DISTINCT r.id)', format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'returns_value', kind: 'additive', fact: 'return',
    sql: 'SUM(rl.gross_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── additive: cost (capability-gated) ─────────────────────────────────────
  {
    id: 'cogs', kind: 'additive', fact: 'line',
    sql: 'SUM(d.cost_snapshot)', format: 'money',
    equationKey: 'sum', version: 1, requiresCap: CAP_COST,
  },

  // ── additive: payments ────────────────────────────────────────────────────
  {
    id: 'payments_in', kind: 'additive', fact: 'payment',
    sql: "SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE 0 END)", format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'refunds_out', kind: 'additive', fact: 'payment',
    sql: "SUM(CASE WHEN p.direction = 'out' THEN p.amount ELSE 0 END)", format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── additive: order-header extras ─────────────────────────────────────────
  {
    id: 'tips_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.tips_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'fees_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.fees_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },
  {
    id: 'rounding_total', kind: 'additive', fact: 'order',
    sql: 'SUM(f.rounding_amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── additive: till ────────────────────────────────────────────────────────
  {
    id: 'till_expected_cash', kind: 'additive', fact: 'till',
    sql: "SUM(CASE t.movement_type " +
      "WHEN 'open_float' THEN t.amount " +
      "WHEN 'cash_sale' THEN t.amount " +
      "WHEN 'pay_in' THEN t.amount " +
      "WHEN 'cash_refund' THEN -t.amount " +
      "WHEN 'pay_out' THEN -t.amount " +
      "ELSE 0 END)",
    format: 'money', equationKey: 'expectedCash', version: 1,
  },
  {
    id: 'till_counted', kind: 'additive', fact: 'till',
    sql: "SUM(CASE WHEN t.movement_type = 'close_count' THEN t.amount ELSE 0 END)",
    format: 'money', equationKey: 'sum', version: 1,
  },

  // ── additive: modifiers ───────────────────────────────────────────────────
  {
    id: 'modifier_lines', kind: 'additive', fact: 'modifier',
    sql: 'COUNT(*)', format: 'count',
    equationKey: 'count', version: 1,
  },
  {
    id: 'modifier_qty', kind: 'additive', fact: 'modifier',
    sql: 'SUM(m.qty)', format: 'qty',
    equationKey: 'sum', version: 1,
  },

  // ── additive: budget ──────────────────────────────────────────────────────
  {
    id: 'budget_amount', kind: 'additive', fact: 'budget',
    sql: 'SUM(b.amount)', format: 'money',
    equationKey: 'sum', version: 1,
  },

  // ── derived (equations.js owns the arithmetic) ────────────────────────────
  {
    id: 'net_incl_vat', kind: 'derived', equationKey: 'netInclVat',
    inputs: Object.freeze(['net_ex_vat', 'vat_amount']), format: 'money', version: 1,
  },
  {
    id: 'net_product_sales', kind: 'derived', equationKey: 'netProductSales',
    inputs: Object.freeze(['gross_product_sales', 'discounts_total', 'returns_net']),
    format: 'money', version: 1,
  },
  {
    id: 'qty_net', kind: 'derived', equationKey: 'netQuantity',
    inputs: Object.freeze(['qty_sold', 'qty_returned']), format: 'qty', version: 1,
  },
  {
    id: 'avg_ticket', kind: 'derived', equationKey: 'avgTicket',
    inputs: Object.freeze(['net_ex_vat', 'orders']), format: 'money', version: 1,
  },
  {
    id: 'avg_items_per_order', kind: 'derived', equationKey: 'avgItemsPerOrder',
    inputs: Object.freeze(['qty_sold', 'orders']), format: 'ratio', version: 1,
  },
  {
    id: 'discount_pct', kind: 'derived', equationKey: 'discountPct',
    inputs: Object.freeze(['discounts_total', 'gross_product_sales']), format: 'percent', version: 1,
  },
  {
    id: 'gross_profit', kind: 'derived', equationKey: 'grossProfit',
    inputs: Object.freeze(['net_ex_vat', 'cogs']), format: 'money', version: 1,
    requiresCap: CAP_COST,
  },
  {
    id: 'margin_pct', kind: 'derived', equationKey: 'marginPct',
    inputs: Object.freeze(['net_ex_vat', 'cogs']), format: 'percent', version: 1,
    requiresCap: CAP_COST,
  },
  {
    id: 'net_collections', kind: 'derived', equationKey: 'netCollections',
    inputs: Object.freeze(['payments_in', 'refunds_out']), format: 'money', version: 1,
  },
  {
    id: 'till_variance', kind: 'derived', equationKey: 'tillVariance',
    inputs: Object.freeze(['till_counted', 'till_expected_cash']), format: 'money', version: 1,
  },
  {
    id: 'item_contribution_pct', kind: 'derived', equationKey: 'contributionPct',
    inputs: Object.freeze(['net_ex_vat', 'net_ex_vat']), format: 'percent', version: 1,
    // part = the row's group value, whole = the ungrouped total of the same
    // metric — the planner evaluates the second input WITHOUT the group-by.
    scope: 'group_vs_total',
  },
  {
    id: 'attach_rate', kind: 'derived', equationKey: 'attachRate',
    inputs: Object.freeze(['modifier_lines', 'qty_sold']), format: 'percent', version: 1,
  },
  {
    id: 'modifiers_per_item', kind: 'derived', equationKey: 'avgModifiersPerItem',
    inputs: Object.freeze(['modifier_qty', 'qty_sold']), format: 'ratio', version: 1,
  },
  {
    id: 'growth', kind: 'derived', equationKey: 'growth',
    inputs: Object.freeze([]), takesMetricParam: true, format: 'percent', version: 1,
  },
  {
    id: 'discount_rate_by_cashier', kind: 'derived', equationKey: 'ratePct',
    inputs: Object.freeze(['discounted_orders', 'orders']), format: 'percent', version: 1,
    groupBy: 'cashier', requiresCap: 'analytics.employees.view',
  },
  {
    id: 'void_rate_by_cashier', kind: 'derived', equationKey: 'ratePct',
    inputs: Object.freeze(['voids_count', 'orders']), format: 'percent', version: 1,
    groupBy: 'cashier', requiresCap: 'analytics.employees.view',
  },
  {
    id: 'return_rate_by_cashier', kind: 'derived', equationKey: 'ratePct',
    inputs: Object.freeze(['returns_count', 'orders']), format: 'percent', version: 1,
    groupBy: 'cashier', requiresCap: 'analytics.employees.view',
  },
]);

const byId = Object.freeze(Object.fromEntries(METRICS.map((m) => [m.id, m])));
const additive = Object.freeze(METRICS.filter((m) => m.kind === 'additive'));
const derived = Object.freeze(METRICS.filter((m) => m.kind === 'derived'));

module.exports = { METRICS, byId, additive, derived };
