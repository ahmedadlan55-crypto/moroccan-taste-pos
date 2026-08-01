// Sales Analytics Hub — the metric / dimension / equation code lists, COPIED
// from the backend registry (SOURCE OF TRUTH: lib/analytics/registry/metrics.js
// and lib/analytics/registry/dimensions.js — update BOTH when the registry
// changes). registry-i18n.test.ts walks these lists and fails when any code
// lacks a salesReports.metrics.* / dims.* / explain.* entry in ar AND en, so a
// backend registry addition surfaces as a failing frontend test instead of a
// raw code leaking into the UI.

/** Every metric id in lib/analytics/registry/metrics.js (additive + derived). */
export const METRIC_CODES = [
  // additive — product money (line fact)
  "gross_product_sales",
  "discounts_total",
  "discounts_line",
  "returns_net",
  "net_ex_vat",
  "vat_amount",
  "invoice_total",
  // additive — counts
  "orders",
  "guests",
  "discounted_orders",
  // additive — quantities
  "qty_sold",
  "qty_returned",
  // additive — voids / returns
  "voids_count",
  "voids_value",
  "returns_count",
  "returns_value",
  "returns_vat",
  // additive — cost (capability-gated: analytics.cost.view)
  "cogs",
  "returns_cogs",
  "uncosted_net",
  // additive — payments
  "payments_in",
  "refunds_out",
  // additive — order-header extras
  "tips_total",
  "fees_total",
  "rounding_total",
  // additive — till
  "till_expected_cash",
  "till_counted",
  // additive — modifiers
  "modifier_lines",
  "modifier_qty",
  // additive — budget
  "budget_amount",
  // derived
  "net_incl_vat",
  // the sales-statement ladder — each of these names its own tax basis, so a
  // statement built from them cannot silently mix two (see metrics.js).
  "net_product_sales",
  "net_product_sales_ex_vat",
  "net_vat",
  "sales_before_discount",
  "statement_variance",
  "qty_net",
  "avg_ticket",
  "avg_items_per_order",
  "discount_pct",
  "gross_profit",
  "margin_pct",
  "net_collections",
  "till_variance",
  "item_contribution_pct",
  "attach_rate",
  "modifiers_per_item",
  "growth",
  "discount_rate_by_cashier",
  "void_rate_by_cashier",
  "return_rate_by_cashier",
] as const;

/** Every dimension id in lib/analytics/registry/dimensions.js. */
export const DIMENSION_CODES = [
  // time
  "business_day",
  "calendar_day",
  "week",
  "month",
  "quarter",
  "year",
  "hour",
  "half_hour",
  "weekday",
  "meal_period",
  // scope
  "branch",
  "brand",
  "company",
  "warehouse",
  // order attributes
  "channel",
  "order_type",
  "source",
  "origin",
  "device",
  "shift",
  "table_no",
  "order_status",
  "provenance",
  // employees (capability-gated: analytics.employees.view)
  "cashier",
  "salesperson",
  "payment_collector",
  "discount_by",
  "void_by",
  "approved_by",
  "closed_by",
  // catalog
  "menu_item",
  "category",
  "modifier_kind",
  // payments
  "payment_method",
  "direction",
  "payment_provider",
  // reasons
  "discount_reason",
  "return_reason",
  // VAT (stored columns only)
  "vat_category",
  "vat_rate",
  // customers (capability-gated: analytics.customers.view)
  "customer",
  // budget
  "budget_metric",
] as const;

/**
 * Every distinct equationKey in lib/analytics/registry/metrics.js — the keys
 * salesReports.explain.* documents with short formula prose (AR/EN).
 */
export const EQUATION_KEYS = [
  "sum",
  "count",
  "grossProductSales",
  "invoiceTotal",
  "expectedCash",
  "netInclVat",
  "netSalesInclVat",
  "netSalesExVat",
  "netVat",
  "salesBeforeDiscount",
  "statementVariance",
  "netQuantity",
  "avgTicket",
  "avgItemsPerOrder",
  "discountPct",
  "grossProfit",
  "marginPct",
  "netCollections",
  "tillVariance",
  "contributionPct",
  "attachRate",
  "avgModifiersPerItem",
  "growth",
  "ratePct",
] as const;

export type MetricCode = (typeof METRIC_CODES)[number];
export type DimensionCode = (typeof DIMENSION_CODES)[number];
export type EquationKey = (typeof EQUATION_KEYS)[number];
