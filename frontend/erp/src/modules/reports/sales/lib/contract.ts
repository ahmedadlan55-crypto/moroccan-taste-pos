// Sales Analytics Hub — the SERVER CONTRACT, mirrored for the browser.
//
// WHAT THIS IS
//   Four tables copied from lib/analytics/registry/* plus lib/analytics/planner.js:
//   which facts each metric needs, which facts each dimension can be expressed
//   on, which date bases each fact carries, and which metrics lift the void
//   exclusion. Everything the report registry derives — visible filters,
//   legal groupings, legal date bases — is computed from these four tables and
//   nothing else.
//
// WHY A MIRROR AND NOT A FETCH
//   /api/analytics/metadata projects the same graph, and lib/grouping.ts uses it
//   at runtime for the Group By pickers. But filter VISIBILITY has to be decided
//   on first paint, before any round-trip, and a filter that appears and then
//   vanishes when the catalog lands is worse than one that was never offered.
//   So the graph is static here and the runtime catalog stays authoritative for
//   the pickers.
//
// WHY IT IS SAFE TO DUPLICATE
//   Because __tests__/contract.test.ts loads the REAL server modules
//   (lib/analytics/registry/grouping.js, .../facts.js, planner.js) through
//   node:module createRequire and asserts EXACT set equality, both directions,
//   for every table below. A registry change on the server fails that test
//   before it can reach a user as a 422. This file is generated data under a
//   proof, not a second opinion.
//
// THE RULE ALL OF THIS ENCODES (planner.js, statement assembly):
//   the planner partitions the requested metrics by FACT and emits one SQL
//   statement per fact. A dimension — grouped OR filtered — that any one of
//   those facts cannot express raises ANALYTICS_UNSUPPORTED_COMBINATION and the
//   WHOLE request 422s. Same for the date basis. So a report may only offer a
//   filter / grouping / basis that EVERY fact its metrics touch can express.

export type FactId = "order" | "line" | "modifier" | "payment" | "return" | "till" | "budget";
export type DateBasis = "business_day" | "calendar_day" | "paid_at" | "closed_at";

export const FACT_IDS: readonly FactId[] = [
  "order",
  "line",
  "modifier",
  "payment",
  "return",
  "till",
  "budget",
];

/** planner.js DATE_BASES — the only four the request contract accepts. */
export const PLANNER_DATE_BASES: readonly DateBasis[] = [
  "business_day",
  "calendar_day",
  "paid_at",
  "closed_at",
];

/**
 * Which of PLANNER_DATE_BASES each fact actually carries (facts.js dateBases,
 * intersected with the contract's allow-list). `payment.settled_at` and
 * `order.opened_at` exist on the fact but are NOT in the planner's allow-list,
 * so they are unreachable and absent here.
 */
export const FACT_DATE_BASES: Record<FactId, readonly DateBasis[]> = {
  order: ["business_day", "calendar_day", "paid_at", "closed_at"],
  line: ["business_day", "calendar_day", "paid_at"],
  modifier: ["business_day", "calendar_day"],
  payment: ["business_day", "calendar_day"],
  return: ["business_day", "calendar_day"],
  till: ["business_day", "calendar_day"],
  budget: ["business_day", "calendar_day"],
};

/**
 * Facts a METRIC needs — its own for an additive metric, the union of its
 * additive inputs' facts for a derived one (the planner computes every input,
 * so every input's fact must express whatever is grouped or filtered).
 *
 * `growth` is EMPTY on purpose: it is `takesMetricParam`, and the planner
 * refuses it outright ("request a base metric with compare instead"). It is a
 * rendering-only metric id — never put it in a request.
 */
export const METRIC_FACTS: Record<string, readonly FactId[]> = {
  gross_product_sales: ["line"],
  discounts_total: ["order"],
  discounts_line: ["line"],
  returns_net: ["return"],
  net_ex_vat: ["line"],
  vat_amount: ["line"],
  invoice_total: ["order"],
  orders: ["order"],
  guests: ["order"],
  discounted_orders: ["order"],
  qty_sold: ["line"],
  qty_returned: ["return"],
  voids_count: ["order"],
  voids_value: ["order"],
  returns_count: ["return"],
  returns_value: ["return"],
  returns_vat: ["return"],
  cogs: ["line"],
  returns_cogs: ["return"],
  uncosted_net: ["line"],
  payments_in: ["payment"],
  refunds_out: ["payment"],
  tips_total: ["order"],
  fees_total: ["order"],
  rounding_total: ["order"],
  till_expected_cash: ["till"],
  till_counted: ["till"],
  modifier_lines: ["modifier"],
  modifier_qty: ["modifier"],
  budget_amount: ["budget"],
  net_incl_vat: ["line"],
  net_product_sales: ["line", "return"],
  net_product_sales_ex_vat: ["line", "return"],
  net_vat: ["line", "return"],
  sales_before_discount: ["line", "order"],
  statement_variance: ["line", "order"],
  qty_net: ["line", "return"],
  avg_ticket: ["line", "order"],
  avg_items_per_order: ["line", "order"],
  discount_pct: ["line", "order"],
  gross_profit: ["line"],
  margin_pct: ["line"],
  net_collections: ["payment"],
  till_variance: ["till"],
  item_contribution_pct: ["line"],
  attach_rate: ["line", "modifier"],
  modifiers_per_item: ["line", "modifier"],
  growth: [],
  discount_rate_by_cashier: ["order"],
  void_rate_by_cashier: ["order"],
  return_rate_by_cashier: ["order", "return"],
};

/** Capability a metric is gated on (planner masks it rather than failing). */
export const METRIC_CAPS: Record<string, string> = {
  cogs: "analytics.cost.view",
  returns_cogs: "analytics.cost.view",
  uncosted_net: "analytics.cost.view",
  gross_profit: "analytics.cost.view",
  margin_pct: "analytics.cost.view",
  discount_rate_by_cashier: "analytics.employees.view",
  void_rate_by_cashier: "analytics.employees.view",
  return_rate_by_cashier: "analytics.employees.view",
};

/**
 * Metrics whose SQL tests `status = 'voided'` — asking for one drops the void
 * exclusion for EVERY metric on the same fact statement (planner.js:356). Two
 * populations inside one screen, with nothing to say so.
 */
export const VOID_LIFTING_METRICS: readonly string[] = [
  "voids_count",
  "voids_value",
  "void_rate_by_cashier",
];

/**
 * Facts a DIMENSION can be expressed on — the union of its SQL `facts` map and,
 * for kind 'derived-js' (meal_period), the `sourceColumn` map the planner
 * buckets from. `company` is a constant with no SQL and supports nothing.
 */
export const DIMENSION_FACTS: Record<string, readonly FactId[]> = {
  business_day: ["budget", "line", "modifier", "order", "payment", "return", "till"],
  calendar_day: ["budget", "line", "modifier", "order", "payment", "return", "till"],
  week: ["line", "modifier", "order", "payment", "return", "till"],
  month: ["budget", "line", "modifier", "order", "payment", "return", "till"],
  quarter: ["budget", "line", "modifier", "order", "payment", "return", "till"],
  year: ["budget", "line", "modifier", "order", "payment", "return", "till"],
  hour: ["line", "modifier", "order", "payment", "till"],
  half_hour: ["line", "modifier", "order", "payment", "till"],
  weekday: ["line", "modifier", "order", "payment", "return", "till"],
  meal_period: ["line", "modifier", "order", "payment", "till"],
  branch: ["budget", "line", "modifier", "order", "payment", "return", "till"],
  brand: ["budget", "line", "modifier", "order", "payment", "return"],
  company: [],
  warehouse: ["line", "order", "return"],
  channel: ["line", "order"],
  order_type: ["line", "order"],
  source: ["line", "order"],
  origin: ["line", "order"],
  device: ["line", "order"],
  shift: ["line", "order", "payment", "till"],
  table_no: ["line", "order"],
  order_status: ["line", "order"],
  provenance: ["modifier", "order", "payment", "till"],
  cashier: ["line", "order"],
  salesperson: ["line", "order"],
  payment_collector: ["order", "payment"],
  discount_by: ["order"],
  void_by: ["order"],
  approved_by: ["order", "till"],
  closed_by: ["order"],
  menu_item: ["line", "modifier", "return"],
  category: ["line"],
  modifier_kind: ["modifier"],
  payment_method: ["payment"],
  direction: ["payment"],
  payment_provider: ["payment"],
  discount_reason: ["order"],
  return_reason: ["return"],
  vat_category: ["line", "return"],
  vat_rate: ["line", "return"],
  customer: ["line", "order"],
  budget_metric: ["budget"],
};

/** Capability a dimension is gated on (the planner answers 403, not 422). */
export const DIMENSION_CAPS: Record<string, string> = {
  cashier: "analytics.employees.view",
  salesperson: "analytics.employees.view",
  payment_collector: "analytics.employees.view",
  discount_by: "analytics.employees.view",
  void_by: "analytics.employees.view",
  approved_by: "analytics.employees.view",
  closed_by: "analytics.employees.view",
  customer: "analytics.customers.view",
};

/** Dimensions the planner will accept in `dimensions` (GROUP BY). */
export const GROUPABLE_DIMENSIONS: readonly string[] = [
  "business_day", "calendar_day", "week", "month", "quarter", "year", "hour",
  "half_hour", "weekday", "meal_period", "branch", "brand", "warehouse",
  "channel", "order_type", "source", "origin", "device", "shift", "table_no",
  "order_status", "provenance", "cashier", "salesperson", "payment_collector",
  "discount_by", "void_by", "approved_by", "closed_by", "menu_item", "category",
  "modifier_kind", "payment_method", "direction", "payment_provider",
  "discount_reason", "return_reason", "vat_category", "vat_rate", "customer",
  "budget_metric",
];

/** planner.js hard caps a report must stay inside or the request 422s. */
export const LIMITS = {
  MAX_METRICS: 12,
  MAX_DIMENSIONS: 3,
  MAX_LIMIT: 500,
  MAX_RANGE_DAYS: 400,
} as const;

/* ── derivations ──────────────────────────────────────────────────────────── */

/** Every fact a set of metrics forces the planner to build a statement for. */
export function factsForMetrics(metricIds: readonly string[]): FactId[] {
  const out = new Set<FactId>();
  for (const id of metricIds) for (const f of METRIC_FACTS[id] ?? []) out.add(f);
  return FACT_IDS.filter((f) => out.has(f));
}

/**
 * Can a dimension be used (grouped OR filtered) against these facts? The
 * planner's own condition: EVERY fact statement must be able to express it.
 */
export function dimensionUsableOn(dimId: string, facts: readonly FactId[]): boolean {
  if (facts.length === 0) return false;
  const have = new Set(DIMENSION_FACTS[dimId] ?? []);
  return facts.every((f) => have.has(f));
}

/** Same question for a date basis (facts.js dateBases per fact). */
export function dateBasisUsableOn(basis: DateBasis, facts: readonly FactId[]): boolean {
  if (facts.length === 0) return false;
  return facts.every((f) => (FACT_DATE_BASES[f] ?? []).includes(basis));
}

/** The date bases a metric set can be asked on — never empty for a real report. */
export function dateBasesForMetrics(metricIds: readonly string[]): DateBasis[] {
  const facts = factsForMetrics(metricIds);
  return PLANNER_DATE_BASES.filter((b) => dateBasisUsableOn(b, facts));
}
