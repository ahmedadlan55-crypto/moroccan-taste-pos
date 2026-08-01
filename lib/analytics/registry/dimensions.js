/**
 * lib/analytics/registry/dimensions.js — every filterable/groupable dimension.
 *
 * Shape per dimension:
 *   {
 *     id,               stable identifier used by the API contract
 *     kind,             'time' | 'scope' | 'attribute' | 'employee' |
 *                       'derived-js' | 'constant'
 *     facts,            { factId: sqlExpr } — the expression that yields this
 *                       dimension's value on that fact. Every alias referenced
 *                       MUST belong to the fact's constant join graph
 *                       (registry/facts.js) — enforced by the registry test.
 *                       A fact absent from the map does not support the
 *                       dimension; the planner must reject the combination.
 *     ops,              allowed filter operators
 *     groupable,        can appear in GROUP BY
 *     requiresCap,      capability id gating the dimension (optional)
 *     label,            { table, idCol, cols } — how to resolve display labels
 *                       (optional; label joins happen OUTSIDE the fact query)
 *   }
 *
 * kind 'derived-js' (meal_period): no SQL expression exists — the value is
 * computed in JS (lib/analytics/mealPeriods.js) from the local timestamp
 * listed in `sourceColumn` per fact. The planner fetches the timestamp and
 * buckets in code.
 *
 * NO VAT constants anywhere: vat_category/vat_rate expose STORED columns.
 */
'use strict';

const OPS = Object.freeze(['eq', 'in', 'not_in', 'between']);
const OPS_NO_RANGE = Object.freeze(['eq', 'in', 'not_in']);

// Local-timestamp column per fact — reused by every time dimension. The
// `return` and `budget` facts carry DATEs, not timestamps, so sub-day time
// dimensions exclude them.
const TS = Object.freeze({
  order: 'f.occurred_at_local',
  line: 'f.occurred_at_local',
  modifier: 'f.occurred_at_local',
  payment: 'p.occurred_at_local',
  till: 't.occurred_at_local',
});

// Returns an UNFROZEN object — several dimensions Object.assign fact-specific
// overrides onto it before freezing the composed map.
function timeExpr(template) {
  const out = {};
  for (const [fact, col] of Object.entries(TS)) out[fact] = template.replace(/%s/g, col);
  return out;
}

const DIMENSIONS = Object.freeze([
  // ── time ──────────────────────────────────────────────────────────────────
  {
    id: 'business_day', kind: 'time', ops: OPS, groupable: true,
    facts: Object.freeze({
      order: 'f.business_day', line: 'f.business_day', modifier: 'f.business_day',
      payment: 'p.business_day', till: 't.business_day',
      return: 'r.return_date', budget: 'b.period_month',
    }),
  },
  {
    id: 'calendar_day', kind: 'time', ops: OPS, groupable: true,
    facts: Object.freeze(Object.assign(timeExpr('DATE(%s)'), {
      return: 'r.return_date', budget: 'b.period_month',
    })),
  },
  {
    id: 'week', kind: 'time', ops: OPS, groupable: true,
    // Mode 3: ISO week, Monday start, YYYYWW — deterministic across servers.
    facts: Object.freeze(Object.assign(timeExpr('YEARWEEK(%s, 3)'), {
      return: 'YEARWEEK(r.return_date, 3)',
    })),
  },
  {
    id: 'month', kind: 'time', ops: OPS, groupable: true,
    facts: Object.freeze(Object.assign(timeExpr("DATE_FORMAT(%s, '%Y-%m-01')"), {
      return: "DATE_FORMAT(r.return_date, '%Y-%m-01')",
      budget: 'b.period_month',
    })),
  },
  {
    id: 'quarter', kind: 'time', ops: OPS, groupable: true,
    facts: Object.freeze(Object.assign(timeExpr("CONCAT(YEAR(%s), '-Q', QUARTER(%s))"), {
      return: "CONCAT(YEAR(r.return_date), '-Q', QUARTER(r.return_date))",
      budget: "CONCAT(YEAR(b.period_month), '-Q', QUARTER(b.period_month))",
    })),
  },
  {
    id: 'year', kind: 'time', ops: OPS, groupable: true,
    facts: Object.freeze(Object.assign(timeExpr('YEAR(%s)'), {
      return: 'YEAR(r.return_date)', budget: 'YEAR(b.period_month)',
    })),
  },
  {
    id: 'hour', kind: 'time', ops: OPS, groupable: true,
    facts: Object.freeze(timeExpr('HOUR(%s)')),
  },
  {
    id: 'half_hour', kind: 'time', ops: OPS, groupable: true,
    // slot30: 0..47 — hour*2 + (minute >= 30)
    facts: Object.freeze(timeExpr('(HOUR(%s) * 2 + FLOOR(MINUTE(%s) / 30))')),
  },
  {
    id: 'weekday', kind: 'time', ops: OPS_NO_RANGE, groupable: true,
    // MySQL WEEKDAY(): 0 = Monday … 6 = Sunday.
    facts: Object.freeze(Object.assign(timeExpr('WEEKDAY(%s)'), {
      return: 'WEEKDAY(r.return_date)',
    })),
  },
  {
    id: 'meal_period', kind: 'derived-js', ops: OPS_NO_RANGE, groupable: true,
    // No SQL — bucketed in JS from the local timestamp (see header).
    facts: Object.freeze({}),
    sourceColumn: TS,
  },

  // ── scope ─────────────────────────────────────────────────────────────────
  {
    id: 'branch', kind: 'scope', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({
      order: 'f.branch_id', line: 'f.branch_id', modifier: 'f.branch_id',
      payment: 'p.branch_id', till: 't.branch_id', return: 'r.branch_id',
      budget: 'b.branch_id',
    }),
    label: Object.freeze({ table: 'branches', idCol: 'id', cols: Object.freeze(['name']) }),
  },
  {
    id: 'brand', kind: 'scope', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({
      order: 'f.brand_id', line: 'f.brand_id', modifier: 'f.brand_id',
      payment: 'p.brand_id', return: 'r.brand_id', budget: 'b.brand_id',
    }),
  },
  {
    // Single-company install: constant, no SQL. Kept in the catalog so the
    // API contract is stable if multi-company ever lands.
    id: 'company', kind: 'constant', ops: OPS_NO_RANGE, groupable: false,
    facts: Object.freeze({}),
  },
  {
    id: 'warehouse', kind: 'scope', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.warehouse_id', line: 'doc.warehouse_id', return: 'r.warehouse_id' }),
    label: Object.freeze({ table: 'warehouses', idCol: 'id', cols: Object.freeze(['name']) }),
  },

  // ── order attributes ──────────────────────────────────────────────────────
  {
    id: 'channel', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.channel_id', line: 'f.channel_id' }),
    label: Object.freeze({ table: 'sales_channels', idCol: 'id', cols: Object.freeze(['name']) }),
  },
  {
    id: 'order_type', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.order_type', line: 'f.order_type' }),
  },
  {
    id: 'source', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.source', line: 'f.source' }),
  },
  {
    id: 'origin', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.origin', line: 'f.origin' }),
  },
  {
    id: 'device', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.device_id', line: 'f.device_id' }),
  },
  {
    id: 'shift', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({
      order: 'f.shift_id', line: 'f.shift_id', payment: 'p.shift_id', till: 't.shift_id',
    }),
  },
  {
    id: 'table_no', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.table_no', line: 'f.table_no' }),
  },
  {
    id: 'order_status', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.status', line: 'f.status' }),
  },
  {
    id: 'provenance', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({
      order: 'f.provenance', payment: 'p.provenance', modifier: 'm.provenance',
      till: 't.provenance',
    }),
  },

  // ── employees (capability-gated) ──────────────────────────────────────────
  {
    id: 'cashier', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.created_by', line: 'f.created_by' }),
  },
  {
    id: 'salesperson', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.salesperson', line: 'f.salesperson' }),
  },
  {
    id: 'payment_collector', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.payment_collector', payment: 'p.performed_by' }),
  },
  {
    id: 'discount_by', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.discount_by' }),
  },
  {
    id: 'void_by', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.void_by' }),
  },
  {
    id: 'approved_by', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.approved_by', till: 't.approved_by' }),
  },
  {
    id: 'closed_by', kind: 'employee', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.employees.view',
    facts: Object.freeze({ order: 'f.closed_by' }),
  },

  // ── catalog ───────────────────────────────────────────────────────────────
  {
    id: 'menu_item', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({
      line: 'd.menu_id', modifier: 'm.parent_menu_id', return: 'rl.menu_id',
    }),
    label: Object.freeze({ table: 'menu', idCol: 'id', cols: Object.freeze(['name', 'name_en']) }),
  },
  // Grouped by the category NAME, not by an id — deliberately. There is no
  // categories master table (menu.category is free text), so the projector
  // never writes category_id_snapshot: it is NULL on every row ever created
  // (ProjectionService: "category_id_snapshot stays NULL and the name is the
  // snapshot"). Grouping on the id therefore collapsed every sale in the
  // system into one nameless bucket, and the report looked like it worked.
  // The name column is the one that is actually populated, and being a
  // snapshot it still reflects the category AT SALE TIME, which is what a
  // historical report must show.
  {
    id: 'category', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ line: 'd.category_name_snapshot' }),
  },
  {
    id: 'modifier_kind', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ modifier: 'm.kind' }),
  },

  // ── payments ──────────────────────────────────────────────────────────────
  {
    id: 'payment_method', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ payment: 'p.method_norm' }),
  },
  {
    id: 'direction', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ payment: 'p.direction' }),
  },
  {
    id: 'payment_provider', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ payment: 'p.provider' }),
  },

  // ── reasons ───────────────────────────────────────────────────────────────
  {
    // BACKED BY A REAL PROJECTION as of this change. It was a reserved id with
    // an empty `facts` map — groupable in the contract, plannable nowhere — so
    // the UI could only offer it and then explain it had no data source.
    // `analytics_order_facts.discount_reason` (db/migrations/analytics/schema.js)
    // now carries the snapshot ProjectionService.projectPosSale writes from
    // sales.discount_name; NULL means the sale carried no named discount.
    //
    // ORDER FACT ONLY, on purpose. The order fact is the grain the value exists
    // at — one discount name per sale. The `line` fact does expose the alias `f`
    // and would accept `f.discount_reason` too, but a line-grain metric grouped
    // by an order-grain label reads as if the reason applied to each line, which
    // no data supports; discount_by is scoped the same way for the same reason.
    id: 'discount_reason', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ order: 'f.discount_reason' }),
  },
  {
    id: 'return_reason', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ return: 'r.reason_code' }),
  },

  // ── VAT (STORED columns only — never derived) ─────────────────────────────
  {
    id: 'vat_category', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ line: 'd.vat_category', return: 'rl.vat_category' }),
  },
  {
    id: 'vat_rate', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ line: 'd.vat_rate', return: 'rl.vat_rate' }),
  },

  // ── customers (capability-gated) ──────────────────────────────────────────
  {
    id: 'customer', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    requiresCap: 'analytics.customers.view',
    facts: Object.freeze({ order: 'f.customer_id', line: 'doc.customer_id' }),
    label: Object.freeze({ table: 'customers', idCol: 'id', cols: Object.freeze(['name']) }),
  },

  // ── budget ────────────────────────────────────────────────────────────────
  {
    id: 'budget_metric', kind: 'attribute', ops: OPS_NO_RANGE, groupable: true,
    facts: Object.freeze({ budget: 'b.metric' }),
  },
]);

const byId = Object.freeze(Object.fromEntries(DIMENSIONS.map((d) => [d.id, d])));

module.exports = { DIMENSIONS, byId, OPS, OPS_NO_RANGE };
