// Sales Analytics Hub — THE REPORT REGISTRY.
//
// One declarative module describing every report the hub can show. The picker,
// the view switcher, the filter bar, the request builders, the export specs and
// the tests all read THIS — nothing restates it.
//
// WHAT A REPORT DECLARES
//   center            which of the five centers it belongs to
//   queries           every metric×dimension request it issues (this IS the
//                     contract surface: facts, and therefore legal filters /
//                     date bases, are DERIVED from it — never typed by hand)
//   cap               the capability that gates the whole report
//   optionalCap       extra metrics a viewer only gets with a second capability
//   compare           whether a comparison window means anything here
//   exportQuery       which query the export file mirrors
//   rollupEligible    whether the default request is answerable from a rollup
//   engine            'analytics' (POST /analytics/query) or a bespoke endpoint
//
// WHAT IS DERIVED, AND WHY IT MUST BE
//   The planner partitions a request's metrics by FACT and emits one statement
//   per fact; a filter, a grouping or a date basis that ANY of those facts
//   cannot express raises ANALYTICS_UNSUPPORTED_COMBINATION and the WHOLE
//   request 422s. So:
//
//     report facts     = ∪ facts(query.metrics) over every query it issues
//     report filters   = dimensions expressible on ALL of those facts
//     report dateBases = bases carried by ALL of those facts
//
//   Deriving is not tidiness. Typed by hand, this table drifts the day someone
//   adds a metric on a new fact — and drift here is a red screen naming a fact
//   id the user never chose. __tests__/reportRegistry.test.ts plans EVERY
//   report × filter × basis × tax mode through the REAL server planner, so a
//   declaration the server would refuse fails the suite instead of a user.
//
// WHY "ALL FACTS" AND NOT "THE FACTS OF THIS ONE QUERY"
//   A visible filter must apply to EVERYTHING on the page. A filter legal for
//   the table but not for the KPI row above it would scope half a screen and
//   leave the other half describing the whole company — the invisible wrong
//   number this hub exists to avoid. Request builders additionally drop
//   per-query (see api.ts buildFiltersBody), which is what makes the 422
//   impossible; this intersection is what makes the SCREEN coherent.
import type { Capability } from "@/shared/permissions";
import {
  DIMENSION_CAPS,
  DIMENSION_FACTS,
  LIMITS,
  PLANNER_DATE_BASES,
  dateBasisUsableOn,
  dimensionUsableOn,
  factsForMetrics,
  type DateBasis,
  type FactId,
} from "./contract";

/* ── filter vocabulary ────────────────────────────────────────────────────── */

/**
 * The shared URL filter keys (lib/filters.ts AnalyticsFilters) that map onto a
 * registry DIMENSION — i.e. everything the planner has to be able to express.
 * `from`/`to`/`preset`/`compare`/`businessDay`/`taxIncl` are NOT here: they are
 * the range, the comparison and the two bases, handled separately.
 */
export const FILTER_DIMENSION: Record<string, string> = {
  brandId: "brand",
  branchId: "branch",
  channel: "channel",
  orderType: "order_type",
  paymentMethod: "payment_method",
  hour: "hour",
  menuItemId: "menu_item",
  categoryId: "category",
  cashierId: "cashier",
};

export type FilterKey = keyof typeof FILTER_DIMENSION & string;

export const ALL_FILTER_KEYS: readonly FilterKey[] = Object.keys(FILTER_DIMENSION);

/* ── shape ────────────────────────────────────────────────────────────────── */

export type CenterId = "executive" | "items" | "payments" | "operations" | "explorer";
export type TaxMode = "excl" | "incl";

export interface ReportQuery {
  /** Stable id — the export spec names one of these. */
  id: string;
  /** Registry metric ids this request carries. */
  metrics: readonly string[];
  /**
   * Grouping. `"day"` is a placeholder resolved to business_day / calendar_day
   * from the active date basis, so the report groups by the day it filters on.
   */
  dimensions: readonly string[];
  /** Extra metrics appended only for a holder of the report's optionalCap. */
  capMetrics?: readonly string[];
  /**
   * The subset of `metrics` this query's TABLE renders as columns. Absent means
   * "all of them". Present when a request deliberately carries more metrics
   * than it shows — because a grouped request's `totals` are free, so a period
   * figure another panel needs can ride along instead of costing its own
   * round-trip. The export follows `columns`, not `metrics`: a file is the
   * table, and the planner's 12-metric ceiling has no room for both.
   */
  columns?: readonly string[];
  /** Rows requested (planner DEFAULT_LIMIT is 50 — say so when more is meant). */
  limit?: number;
}

export interface ReportSpec {
  /** Stable id. Doubles as the `view` URL param and the i18n `pages.<id>` key. */
  id: string;
  center: CenterId;
  /** Capability gating the whole report (hidden in the picker, denied deep). */
  cap?: Capability;
  /** Capability unlocking `capMetrics` — the report itself stays visible. */
  optionalCap?: Capability;
  /** Empty for a `dynamic` report: the analyst chooses the metrics. */
  queries: readonly ReportQuery[];
  /**
   * TRUE when the metric set is chosen at runtime (Explorer, Builder). Facts
   * cannot be derived ahead of time, so every filter stays visible and the page
   * drops per-query against its own selection.
   */
  dynamic?: boolean;
  compare: boolean;
  /** Which query the ExportMenu's file mirrors (`null` → not exportable here). */
  exportQuery: string | null;
  /** Sort applied to the export request. */
  exportSort?: ReadonlyArray<{ by: string; dir: "asc" | "desc" }>;
  /**
   * Can the DEFAULT request be answered from a pre-aggregated rollup? Declared,
   * then PROVEN against the real planner's meta.source in the registry test —
   * restating the planner's ROLLUP_SOURCES here would be a second copy free to
   * drift.
   */
  rollupEligible: boolean;
  /** Which backend answers. 'reconciliation' has its own endpoint and contract. */
  engine: "analytics" | "reconciliation";
  /** Reports whose complete screen has a narrower shared filter surface. */
  fixedFilters?: readonly FilterKey[];
  /** …and their own bases. */
  fixedDateBases?: readonly DateBasis[];
  fixedTaxModes?: readonly TaxMode[];
}

export interface CenterSpec {
  id: CenterId;
  /** Report ids in view-switcher order; the first is the center's default. */
  views: readonly string[];
}

/* ── the reports ──────────────────────────────────────────────────────────── */

const COST_CAP: Capability = "analytics.cost.view";
const EMPLOYEE_CAP: Capability = "analytics.employees.view";

/** Metrics shared by every breakdown of the merged Items report. */
const ITEM_BASE = ["qty_sold", "gross_product_sales", "discounts_line", "net_ex_vat"] as const;
const ITEM_COST = ["cogs", "gross_profit", "margin_pct"] as const;

export const REPORTS: readonly ReportSpec[] = [
  /* ── centre 1 — executive summary ─────────────────────────────────────── */
  {
    id: "executive",
    center: "executive",
    compare: true,
    engine: "analytics",
    exportQuery: "daily",
    exportSort: [{ by: "day", dir: "asc" }],
    // MEASURED, not assumed: reportRegistry.test.ts plans this report's export
    // query through the real planner and reads meta.source, so the flag fails
    // the suite the moment it drifts in EITHER direction. It has already moved
    // twice under this file — once when the operational counters were folded
    // into the daily request (adding qty_sold), and back again when the
    // analytics_daily_item / _daily_vat / _daily_cashier / _daily_branch_brand
    // rollups landed and the planner learned to express them.
    rollupEligible: true,
    queries: [
      {
        // The statement ladder. Split into three because the planner caps a
        // request at 12 metrics AND because a voids_* metric drops the void
        // exclusion for every metric sharing its fact statement (group C).
        id: "statement",
        metrics: [
          "sales_before_discount", "discounts_total", "gross_product_sales",
          "net_ex_vat", "vat_amount", "returns_net", "returns_vat",
          "returns_value", "net_product_sales", "net_product_sales_ex_vat",
          "invoice_total", "statement_variance",
        ],
        dimensions: [],
      },
      {
        id: "voidsAndProfit",
        metrics: [
          "voids_count", "voids_value", "net_collections",
          "cogs_after_returns", "gross_profit_after_returns", "margin_pct_after_returns",
          "uncosted_net", "uncosted_returns_net",
        ],
        dimensions: [],
      },
      {
        // THE DAILY DETAIL, AND THE OPERATIONAL COUNTERS ABOVE IT — ONE REQUEST.
        //
        // The counters (qty, items per order, guests, fees, rounding, returns
        // count) used to be a SEVENTH dimensionless request whose only output
        // was a grand total. But every grouped request already computes its
        // grand total server-side, and these six figures are measured over
        // exactly the population this one groups by day. So they ride here and
        // the page reads them off `totals` — one round-trip fewer on the hub's
        // landing page, with no figure lost and no number changed (the totals
        // statement has no LIMIT; it is not the paged rows).
        //
        // The six DAILY COLUMNS are the first six ids; the rest are
        // period-only. Twelve metrics exactly — the planner's MAX_METRICS, so
        // nothing more may be folded in here without splitting again.
        //
        // The row limit is explicit because DEFAULT_LIMIT is 50 while a range
        // may legally run to 400 days: the detail sits directly under a
        // statement that totals the WHOLE period and has to foot to it.
        id: "daily",
        metrics: [
          "orders", "discounts_total", "net_ex_vat", "vat_amount", "invoice_total", "avg_ticket",
          "qty_sold", "avg_items_per_order", "guests", "fees_total", "rounding_total", "returns_count",
        ],
        columns: ["orders", "discounts_total", "net_ex_vat", "vat_amount", "invoice_total", "avg_ticket"],
        dimensions: ["day"],
        limit: LIMITS.MAX_LIMIT,
      },
      { id: "byTax", metrics: ["net_ex_vat", "vat_amount"], dimensions: ["vat_category"] },
      { id: "byPayment", metrics: ["payments_in", "refunds_out", "net_collections"], dimensions: ["payment_method"] },
    ],
  },

  /* ── centre 2 — items, profitability, modifiers ───────────────────────── */
  {
    // THE MERGE. "items" and "item-sales" were two reports over the same line
    // fact: one did category → item with a contribution share, the other did
    // day × item × branch with cost. Nobody could answer "which items, and
    // when" without opening both and reconciling them by eye. This is one
    // report with three BREAKDOWNS and the union of both column sets — the
    // cost columns are here for every breakdown, not hidden on one of them.
    //
    // returns_net rides on the RETURN fact, which cannot express `category`
    // (menu.category is a free-text snapshot on the line only). So the
    // category breakdown is the one that carries no returns column — stated
    // here, in the registry, rather than discovered as a 422.
    id: "items",
    center: "items",
    optionalCap: COST_CAP,
    compare: true,
    engine: "analytics",
    exportQuery: "byItem",
    exportSort: [{ by: "net_ex_vat", dir: "desc" }],
    rollupEligible: false,
    queries: [
      {
        id: "byCategory",
        metrics: [...ITEM_BASE, "item_contribution_pct"],
        capMetrics: ITEM_COST,
        dimensions: ["category", "menu_item"],
        limit: LIMITS.MAX_LIMIT,
      },
      {
        id: "byItem",
        metrics: [...ITEM_BASE, "returns_net", "item_contribution_pct"],
        capMetrics: ITEM_COST,
        dimensions: ["menu_item"],
        limit: LIMITS.MAX_LIMIT,
      },
      {
        id: "byDay",
        metrics: [...ITEM_BASE, "returns_net"],
        capMetrics: ITEM_COST,
        dimensions: ["day", "menu_item", "branch"],
        limit: LIMITS.MAX_LIMIT,
      },
    ],
  },
  {
    id: "profitability",
    center: "items",
    cap: COST_CAP,
    compare: false,
    engine: "analytics",
    exportQuery: "byItem",
    exportSort: [{ by: "gross_profit_after_returns", dir: "desc" }],
    // Return-aware profitability joins line + return facts. The current
    // menu-item rollup cannot express returns_net, so this report must use the
    // exact live facts until the return rollup gains the same dimension.
    rollupEligible: false,
    queries: [
      {
        id: "kpis",
        metrics: [
          "net_product_sales_ex_vat", "cogs_after_returns",
          "gross_profit_after_returns", "margin_pct_after_returns",
          "uncosted_net", "uncosted_returns_net",
        ],
        dimensions: [],
      },
      {
        id: "byItem",
        metrics: [
          "qty_sold", "net_product_sales_ex_vat", "cogs", "cogs_after_returns",
          "gross_profit_after_returns", "margin_pct_after_returns",
          "uncosted_net", "uncosted_returns_net",
        ],
        dimensions: ["menu_item"],
        limit: LIMITS.MAX_LIMIT,
      },
    ],
  },
  {
    id: "modifiers",
    center: "items",
    compare: false,
    engine: "analytics",
    exportQuery: "byKind",
    rollupEligible: false,
    queries: [
      { id: "kpis", metrics: ["modifier_qty", "modifiers_per_item", "attach_rate"], dimensions: [] },
      { id: "byKind", metrics: ["modifier_qty", "modifier_lines"], dimensions: ["modifier_kind"] },
    ],
  },

  /* ── centre 3 — payments, VAT, reconciliation ─────────────────────────── */
  {
    id: "payments",
    center: "payments",
    compare: false,
    engine: "analytics",
    exportQuery: "byMethod",
    rollupEligible: true,
    queries: [
      { id: "kpis", metrics: ["payments_in", "refunds_out", "net_collections", "tips_total"], dimensions: [] },
      { id: "byMethod", metrics: ["payments_in", "refunds_out", "net_collections"], dimensions: ["payment_method"] },
    ],
  },
  {
    id: "reconciliation",
    center: "payments",
    cap: "analytics.reconciliation.view",
    compare: false,
    // GET /analytics/reconciliation — from/to/branchIds and nothing else. Every
    // other filter, the date basis and the tax basis are meaningless here, so
    // the bar must not offer them: a control that changes no number is a lie.
    engine: "reconciliation",
    queries: [],
    exportQuery: null,
    rollupEligible: false,
    fixedFilters: ["branchId"],
    fixedDateBases: ["business_day"],
    fixedTaxModes: ["excl"],
  },
  {
    id: "taxes",
    center: "payments",
    compare: false,
    engine: "analytics",
    exportQuery: "byRate",
    exportSort: [{ by: "vat_amount", dir: "desc" }],
    rollupEligible: true,
    queries: [
      { id: "kpis", metrics: ["vat_amount", "fees_total", "rounding_total", "tips_total"], dimensions: [] },
      { id: "byRate", metrics: ["vat_amount", "net_ex_vat"], dimensions: ["vat_rate"] },
      {
        id: "filing",
        metrics: ["net_ex_vat", "vat_amount", "returns_net", "returns_vat", "net_product_sales_ex_vat", "net_vat"],
        dimensions: ["vat_category", "vat_rate"],
        limit: 200,
      },
    ],
  },
  {
    id: "discounts",
    center: "payments",
    compare: false,
    engine: "analytics",
    exportQuery: "byDay",
    exportSort: [{ by: "day", dir: "asc" }],
    rollupEligible: true,
    queries: [
      { id: "kpis", metrics: ["discounts_total", "discount_pct", "discounted_orders", "orders"], dimensions: [] },
      { id: "byDay", metrics: ["discounts_total", "discount_pct", "discounted_orders", "orders"], dimensions: ["day"] },
      {
        id: "byCashier",
        metrics: ["discounts_total", "discount_pct", "discounted_orders", "orders", "discount_rate_by_cashier"],
        dimensions: ["cashier"],
      },
      {
        // `discount_reason` used to be a RESERVED id: groupable in the contract,
        // plannable nowhere, so this page could only apologise for its absence.
        // analytics_order_facts.discount_reason now carries the snapshot
        // ProjectionService writes from sales.discount_name, so the question
        // "which named discounts are costing us this" finally has a table.
        // NULL is a real bucket here — a sale that carried no named discount.
        // ORDER-FACT METRICS ONLY. `discount_reason` is projected on the order
        // fact alone — one discount name per sale — so `discount_pct` cannot
        // come along: it expands to discounts_total ÷ gross_product_sales, and
        // gross_product_sales lives on the LINE fact, which carries no reason
        // column. The whole request would 422. (Caught by
        // reportRegistry.test.ts planning it against the real planner, which is
        // the entire point of that test.)
        id: "byReason",
        metrics: ["discounts_total", "discounted_orders", "orders"],
        dimensions: ["discount_reason"],
        limit: 100,
      },
    ],
  },

  /* ── centre 4 — operations ────────────────────────────────────────────── */
  {
    id: "branches",
    center: "operations",
    compare: true,
    engine: "analytics",
    exportQuery: "byBranch",
    exportSort: [{ by: "net_ex_vat", dir: "desc" }],
    rollupEligible: true,
    queries: [
      { id: "byBranch", metrics: ["net_ex_vat", "orders"], dimensions: ["brand", "branch"], limit: LIMITS.MAX_LIMIT },
    ],
  },
  {
    // NEW in this reorganisation. Channel performance had no report of its own:
    // `channel` was a filter you could apply but never a breakdown you could
    // read, so "how much of July came through delivery" needed the Explorer.
    id: "channels",
    center: "operations",
    compare: true,
    engine: "analytics",
    exportQuery: "byChannel",
    exportSort: [{ by: "net_ex_vat", dir: "desc" }],
    rollupEligible: false,
    queries: [
      { id: "kpis", metrics: ["net_ex_vat", "orders", "invoice_total", "avg_ticket"], dimensions: [] },
      {
        id: "byChannel",
        metrics: ["net_ex_vat", "orders", "invoice_total", "avg_ticket"],
        dimensions: ["channel"],
        limit: LIMITS.MAX_LIMIT,
      },
    ],
  },
  {
    id: "cashiers",
    center: "operations",
    cap: EMPLOYEE_CAP,
    compare: false,
    engine: "analytics",
    exportQuery: "byCashier",
    exportSort: [{ by: "net_ex_vat", dir: "desc" }],
    rollupEligible: true,
    queries: [
      {
        // return_rate_by_cashier is absent on purpose: its returns_count input
        // is a RETURN-fact metric and the return fact carries no cashier, so
        // the planner refuses the grouping outright.
        id: "byCashier",
        metrics: ["orders", "net_ex_vat", "avg_ticket", "discount_rate_by_cashier"],
        dimensions: ["cashier"],
      },
      {
        // THE VOID RATE RIDES ALONE — the same rule the executive statement's
        // group C obeys. void_rate_by_cashier expands to voids_count ÷ orders,
        // and voids_count's SQL tests status='voided', which makes the planner
        // drop the void exclusion for EVERY metric on that order-fact statement
        // (planner.js:356). Asked for beside `orders`, the cashier's order
        // count silently started including voided orders, `avg_ticket` became a
        // void-excluded numerator over a void-included denominator, and the
        // discount rate's denominator moved under it. Two populations in one
        // row of a table used to judge people. Merged by cashier key on the
        // client instead — see Cashiers.tsx.
        id: "byCashierVoids",
        metrics: ["voids_count", "void_rate_by_cashier"],
        dimensions: ["cashier"],
      },
    ],
  },
  {
    id: "hours",
    center: "operations",
    compare: false,
    engine: "analytics",
    exportQuery: "byHour",
    // analytics_hourly_branch stores slot30, and the registry's `hour` is
    // FLOOR(slot30/2) exactly — so the hourly report is rollup-answerable.
    rollupEligible: true,
    queries: [
      { id: "heatmap", metrics: ["net_ex_vat"], dimensions: ["weekday", "hour"], limit: LIMITS.MAX_LIMIT },
      { id: "byHour", metrics: ["orders", "net_ex_vat"], dimensions: ["hour"] },
    ],
  },
  {
    id: "shifts",
    center: "operations",
    compare: false,
    engine: "analytics",
    exportQuery: "byShift",
    exportSort: [{ by: "till_variance", dir: "asc" }],
    rollupEligible: false,
    queries: [
      { id: "kpis", metrics: ["till_expected_cash", "till_counted", "till_variance"], dimensions: [] },
      { id: "byShift", metrics: ["till_expected_cash", "till_counted", "till_variance"], dimensions: ["shift"] },
    ],
  },
  {
    id: "voids",
    center: "operations",
    compare: false,
    engine: "analytics",
    exportQuery: "byCashier",
    rollupEligible: true,
    queries: [
      {
        id: "kpis",
        metrics: ["voids_count", "voids_value", "returns_count", "returns_value", "qty_returned"],
        dimensions: [],
      },
      { id: "byReason", metrics: ["returns_count", "returns_value", "qty_returned"], dimensions: ["return_reason"] },
      { id: "byCashier", metrics: ["voids_count", "voids_value", "void_rate_by_cashier"], dimensions: ["cashier"] },
    ],
  },
  {
    id: "orders",
    center: "operations",
    compare: false,
    engine: "analytics",
    exportQuery: "byDay",
    exportSort: [{ by: "day", dir: "asc" }],
    // orders / invoice_total / avg_ticket by business day are all columns of
    // analytics_daily_branch.
    rollupEligible: true,
    // Its KPI row and operational invoice table must honour the same scope.
    // Brand/hour/cashier are valid on the analytics order fact but the invoice
    // list cannot express them; showing those controls would scope only half
    // the screen. Dedicated reports cover those dimensions directly.
    fixedFilters: ["branchId", "channel", "orderType"],
    queries: [
      { id: "kpis", metrics: ["orders", "invoice_total", "avg_ticket"], dimensions: [] },
      { id: "byDay", metrics: ["orders", "invoice_total", "avg_ticket"], dimensions: ["day"] },
    ],
  },

  /* ── centre 5 — custom explorer ───────────────────────────────────────── */
  {
    id: "explorer",
    center: "explorer",
    compare: true,
    dynamic: true,
    engine: "analytics",
    queries: [],
    exportQuery: null,
    rollupEligible: false,
  },
  {
    id: "builder",
    center: "explorer",
    compare: true,
    dynamic: true,
    engine: "analytics",
    queries: [],
    exportQuery: null,
    rollupEligible: false,
  },
];

export const REPORT_BY_ID: Readonly<Record<string, ReportSpec>> = Object.freeze(
  Object.fromEntries(REPORTS.map((r) => [r.id, r])),
);

/** The five centers, in picker order. views[0] is the center's default view. */
export const CENTERS: readonly CenterSpec[] = [
  { id: "executive", views: ["executive"] },
  { id: "items", views: ["items", "profitability", "modifiers"] },
  { id: "payments", views: ["payments", "taxes", "discounts", "reconciliation"] },
  { id: "operations", views: ["branches", "channels", "hours", "cashiers", "shifts", "voids", "orders"] },
  { id: "explorer", views: ["explorer", "builder"] },
];

export const CENTER_BY_ID: Readonly<Record<string, CenterSpec>> = Object.freeze(
  Object.fromEntries(CENTERS.map((c) => [c.id, c])),
);

export const CENTER_IDS: readonly CenterId[] = CENTERS.map((c) => c.id);

/**
 * Old `/reports/sales/<segment>` → the center + view it became. A bookmark is a
 * promise; these are the seventeen that were made. Centers whose id equals a
 * retired segment id (executive / items / payments / explorer) are absent
 * because their path did not change — the redirect table holds only real moves.
 */
export const LEGACY_SEGMENT_ROUTES: Readonly<Record<string, { center: CenterId; view: string }>> = Object.freeze({
  "item-sales": { center: "items", view: "items" },
  modifiers: { center: "items", view: "modifiers" },
  profitability: { center: "items", view: "profitability" },
  taxes: { center: "payments", view: "taxes" },
  discounts: { center: "payments", view: "discounts" },
  reconciliation: { center: "payments", view: "reconciliation" },
  branches: { center: "operations", view: "branches" },
  cashiers: { center: "operations", view: "cashiers" },
  hours: { center: "operations", view: "hours" },
  shifts: { center: "operations", view: "shifts" },
  voids: { center: "operations", view: "voids" },
  orders: { center: "operations", view: "orders" },
  builder: { center: "explorer", view: "builder" },
});

/* ── derivations ──────────────────────────────────────────────────────────── */

/** Every metric a report can ever request, cap-gated ones included. */
export function reportMetrics(report: ReportSpec): string[] {
  const out = new Set<string>();
  for (const q of report.queries) {
    for (const m of q.metrics) out.add(m);
    for (const m of q.capMetrics ?? []) out.add(m);
  }
  return [...out];
}

/** Every fact the planner will build a statement for, across all its queries. */
export function reportFacts(report: ReportSpec): FactId[] {
  return factsForMetrics(reportMetrics(report));
}

/**
 * The filter keys this report may SHOW. A dynamic report shows everything (its
 * metrics are picked at runtime and its request builder drops per-query); a
 * bespoke-engine report shows exactly what its endpoint accepts.
 *
 * `can` additionally removes capability-gated dimensions. That is not cosmetic:
 * the planner answers PERMISSION_DENIED (403) for a filter dimension the caller
 * is not entitled to, so a bookmarked `?cashierId=…` opened by someone without
 * analytics.employees.view would break the whole report rather than show it
 * unscoped. Omit `can` to ask what the report supports for a fully-entitled
 * viewer.
 */
export function reportFilterKeys(
  report: ReportSpec,
  can?: (cap: Capability) => boolean,
): FilterKey[] {
  const entitled = (key: FilterKey) => {
    const cap = DIMENSION_CAPS[FILTER_DIMENSION[key]];
    return !cap || !can || can(cap as Capability);
  };
  if (report.fixedFilters) return report.fixedFilters.filter(entitled);
  if (report.dynamic) return ALL_FILTER_KEYS.filter(entitled);
  const facts = reportFacts(report);
  return ALL_FILTER_KEYS.filter(
    (key) => dimensionUsableOn(FILTER_DIMENSION[key], facts) && entitled(key),
  );
}

/** The date bases this report can be asked on. */
export function reportDateBases(report: ReportSpec): DateBasis[] {
  if (report.fixedDateBases) return [...report.fixedDateBases];
  if (report.dynamic) return ["business_day", "calendar_day"];
  const facts = reportFacts(report);
  return PLANNER_DATE_BASES.filter((b) => dateBasisUsableOn(b, facts));
}

/**
 * The tax bases this report can show. The toggle is a CLIENT-SIDE metric swap
 * (net_ex_vat → net_incl_vat, api.ts TAX_INCL_SWAP), NOT a server field — so a
 * report that never asks for net_ex_vat has nothing to swap and the toggle
 * would change no number on its screen.
 */
export function reportTaxModes(report: ReportSpec): TaxMode[] {
  if (report.fixedTaxModes) return [...report.fixedTaxModes];
  if (report.dynamic) return ["excl", "incl"];
  return reportMetrics(report).includes("net_ex_vat") ? ["excl", "incl"] : ["excl"];
}

/** The two-way date-basis control is only meaningful with both bases. */
export function supportsDateBasisToggle(report: ReportSpec): boolean {
  const bases = reportDateBases(report);
  return bases.includes("business_day") && bases.includes("calendar_day");
}

export function supportsTaxToggle(report: ReportSpec): boolean {
  return reportTaxModes(report).length > 1;
}

/** Resolve the `"day"` dimension placeholder against the active basis. */
export function resolveDimensions(
  dimensions: readonly string[],
  basis: DateBasis,
): string[] {
  return dimensions.map((d) => (d === "day" ? (basis === "calendar_day" ? "calendar_day" : "business_day") : d));
}

/** Resolve a `"day"` sort key the same way, so the file sorts by a real column. */
export function resolveSort(
  sort: ReadonlyArray<{ by: string; dir: "asc" | "desc" }> | undefined,
  basis: DateBasis,
): Array<{ by: string; dir: "asc" | "desc" }> | undefined {
  if (!sort) return undefined;
  return sort.map((s) => ({
    ...s,
    by: s.by === "day" ? (basis === "calendar_day" ? "calendar_day" : "business_day") : s.by,
  }));
}

export function reportQuery(report: ReportSpec, queryId: string): ReportQuery | undefined {
  return report.queries.find((q) => q.id === queryId);
}

/** Metrics of one query for a given viewer (cap metrics included only if held). */
export function queryMetrics(query: ReportQuery, hasOptionalCap: boolean): string[] {
  return [...query.metrics, ...(hasOptionalCap ? (query.capMetrics ?? []) : [])];
}

/* ── the auto-drop ────────────────────────────────────────────────────────── */

/**
 * Which currently-set filter keys the report cannot honour.
 *
 * `set` is the list of keys holding a non-default value (lib/filters.ts
 * nonDefaultFilterKeys). Switching reports must clear these — silently
 * carrying one is the worst of the three outcomes: a 422 is at least visible,
 * and dropping it is at least correct, but a filter the new report cannot
 * express while the chip still claims it is a number that quietly answers a
 * different question than the label above it.
 */
export function unsupportedFilterKeys(
  report: ReportSpec,
  set: readonly string[],
  can?: (cap: Capability) => boolean,
): FilterKey[] {
  const allowed = new Set<string>(reportFilterKeys(report, can));
  return ALL_FILTER_KEYS.filter((k) => set.includes(k) && !allowed.has(k));
}

/**
 * The same question for a SINGLE request: which filter keys cannot be expressed
 * on the facts of these metrics. This is the one the request builders use, and
 * it is what makes a 422 unreachable even for a dynamic report.
 */
export function unsupportedFilterKeysForMetrics(
  metricIds: readonly string[],
  set: readonly string[],
): FilterKey[] {
  const facts = factsForMetrics(metricIds);
  return ALL_FILTER_KEYS.filter(
    (k) => set.includes(k) && !dimensionUsableOn(FILTER_DIMENSION[k], facts),
  );
}

/** Is a grouping legal for these metrics? (planner's own condition). */
export function groupingUsable(metricIds: readonly string[], dimId: string): boolean {
  return dimensionUsableOn(dimId, factsForMetrics(metricIds));
}

/* ── centers ──────────────────────────────────────────────────────────────── */

export function centerOfView(viewId: string): CenterId | undefined {
  return REPORT_BY_ID[viewId]?.center;
}

/**
 * The canonical URL of a report, carrying an existing query string forward.
 *
 * Every drill in the hub goes through this. Building `/reports/sales/<report>`
 * by hand still WORKS — the retired-segment redirect catches it — but it costs
 * a second navigation and leaves the old shape in the address bar for a frame,
 * which is exactly the sort of thing a Playwright `waitForURL` races with.
 */
export function hubHref(
  reportId: string,
  search: string,
  extra: Record<string, string> = {},
): string {
  const report = REPORT_BY_ID[reportId];
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) {
    if (v === "") sp.delete(k);
    else sp.set(k, v);
  }
  if (report) sp.set("view", reportId);
  const qs = sp.toString();
  const path = report ? `/reports/sales/${report.center}` : `/reports/sales/${reportId}`;
  return `${path}${qs ? `?${qs}` : ""}`;
}

export function defaultViewOf(center: CenterId): string {
  return CENTER_BY_ID[center].views[0];
}

/**
 * Resolve a hub URL to the report it should show.
 *   - a center id (with an optional `view`)         → that view
 *   - a retired segment id                          → its center + view
 *   - anything else                                 → null (the not-found state)
 * `redirect` is true when the incoming path is not the canonical one, so the
 * hub can <Navigate replace> and keep the query string.
 */
export function resolveHubRoute(
  segment: string,
  view: string | null,
): { center: CenterId; view: string; redirect: boolean } | null {
  const center = CENTER_BY_ID[segment];
  if (center) {
    const wanted = view && center.views.includes(view) ? view : center.views[0];
    // A `view` naming a report in ANOTHER center is not this center's business;
    // send it to its real home rather than silently showing the default.
    if (view && !center.views.includes(view)) {
      const home = centerOfView(view);
      if (home) return { center: home, view, redirect: true };
    }
    return { center: segment as CenterId, view: wanted, redirect: false };
  }
  const legacy = LEGACY_SEGMENT_ROUTES[segment];
  if (legacy) return { center: legacy.center, view: legacy.view, redirect: true };
  return null;
}

/** Every dimension id the registry references — used by the coverage tests. */
export function referencedDimensions(): string[] {
  const out = new Set<string>(Object.values(FILTER_DIMENSION));
  for (const r of REPORTS) {
    for (const q of r.queries) {
      for (const d of q.dimensions) {
        if (d === "day") {
          out.add("business_day");
          out.add("calendar_day");
        } else out.add(d);
      }
    }
  }
  return [...out].filter((d) => DIMENSION_FACTS[d] != null);
}
