// Sales Analytics Hub — API surface for POST /api/analytics/query and
// GET /api/analytics/metadata (backend: routes/analytics.js + lib/analytics/*).
// Types mirror the backend contract; the backend stays authoritative (masked
// metrics arrive as meta.maskedMetrics and render as "—", never as 0).
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { useLang, type TFunction } from "@/i18n";
import type { AnalyticsFilters } from "./filters";

/* ── query body ──────────────────────────────────────────────── */

export type DateBasis = "business_day" | "calendar_day" | "paid_at" | "closed_at";
export type TaxMode = "incl" | "excl";

export interface AnalyticsQueryFilters {
  /** ISO YYYY-MM-DD inclusive. */
  from: string;
  to: string;
  brandIds?: string[];
  branchIds?: string[];
  channels?: string[];
  orderTypes?: string[];
  // ── wave-4 drill filters. Each named key maps onto ONE registry dimension
  //    (lib/analytics/registry/dimensions.js) server-side:
  //    paymentMethods → payment_method · hours → hour · menuIds → menu_item ·
  //    categoryIds → category · cashiers → cashier.
  //    Sent ONLY when non-empty — the planner 422s on unknown ids actually sent.
  paymentMethods?: string[];
  hours?: number[];
  menuIds?: string[];
  categoryIds?: string[];
  cashiers?: string[];
  /** Page-local extra dimension filters ({ dimensionId: values[] }). */
  extra?: Record<string, Array<string | number>>;
}

export interface AnalyticsCompareSpec {
  mode: "prevPeriod" | "prevYear";
  /** Concrete comparison window (computed client-side via computeCompareRange). */
  from: string;
  to: string;
}

export interface AnalyticsSortSpec {
  by: string;
  dir: "asc" | "desc";
}

export interface AnalyticsQueryBody {
  metrics: string[];
  dimensions: string[];
  filters: AnalyticsQueryFilters;
  dateBasis: DateBasis;
  taxMode: TaxMode;
  compare?: AnalyticsCompareSpec;
  sort?: AnalyticsSortSpec[];
  limit?: number;
  offset?: number;
}

/* ── result ──────────────────────────────────────────────────── */

export interface AnalyticsColumn {
  id: string;
  kind: "dimension" | "metric";
  label?: string;
}

export interface AnalyticsResultRow {
  /** One entry per requested dimension, in request order. */
  keys: Array<string | number | null>;
  /** Display labels resolved server-side (falls back to String(key)). */
  labels: string[];
  /** metricId → value; ABSENT/null means not computable (render "—", never 0). */
  values: Record<string, number | null>;
  compare?: Record<string, number | null>;
  delta?: Record<string, number | null>;
}

export interface AnalyticsResultMeta {
  freshness: { watermark: string | null; pendingDays?: number };
  completeness?: { complete: boolean; missingDays?: string[] };
  /** Metrics the server refused (capability) — the UI masks them as "—". */
  maskedMetrics: string[];
  defaultsApplied?: Record<string, unknown>;
}

export interface AnalyticsResult {
  columns: AnalyticsColumn[];
  rows: AnalyticsResultRow[];
  /** Server-computed subtotal rows (keys carry null at the free levels). */
  subtotals?: AnalyticsResultRow[];
  totals?: Record<string, number | null>;
  // `total` is NOT a server count: QueryService returns only {limit, offset,
  // rowCountCapped}, so it degrades to rows.length. `rowCountCapped` is the
  // authoritative "a fact hit MAX_LIMIT — you are NOT seeing the whole period"
  // flag; prefer it over comparing rows.length to the requested limit, which
  // cries truncation on a result that merely lands exactly on the cap.
  page?: { limit: number; offset: number; total: number; rowCountCapped?: boolean };
  meta: AnalyticsResultMeta;
}

/** Registry payload of GET /api/analytics/metadata (metric/dimension catalog). */
export interface AnalyticsRegistry {
  metrics: Array<{
    id: string;
    kind: string;
    format: string;
    equationKey?: string;
    requiresCap?: string;
    /** Single fact id — null for every derived metric. Superseded by `facts`. */
    fact?: string | null;
    /**
     * Every fact this metric needs: itself if additive, its inputs' facts if
     * derived. Group By compares these against a dimension's `facts` to
     * disable illegal pairs BEFORE the planner 422s the whole request — see
     * lib/grouping.ts. Absent on an older server (degraded mode).
     */
    facts?: string[];
  }>;
  dimensions: Array<{
    id: string;
    kind: string;
    groupable: boolean;
    requiresCap?: string;
    /**
     * Fact ids this dimension can be expressed on, INCLUDING the derived-js
     * path (meal_period has no SQL `facts` map and is planned from
     * `sourceColumn`). Empty means no projector backs it yet.
     */
    facts?: string[];
  }>;
}

/* ── wire adapter (E2E-wave integration fix) ─────────────────────
 * The page-facing AnalyticsQueryBody / AnalyticsResult contracts above are
 * what every hub page (and its unit tests) speak. The REAL backend speaks the
 * PLANNER contract (lib/analytics/planner.js):
 *   request  — { metrics, dimensions, range:{from,to}, dateBasis,
 *               filters:[{dimension,op:'in',values}], compare:'prevPeriod'|
 *               'prevYear', sort, limit, offset }   (NOT a filters OBJECT,
 *               and `range` is REQUIRED — the old direct POST of the page
 *               body 422'd on every single query)
 *   response — { success, data:{ columns, rows:[{keys:{dim:v}, labels:{dim:l},
 *               values, compare?, delta:{abs,pct}}], subtotals, totals:
 *               {values,...}, page }, meta:{freshness, completeness:[],
 *               maskedMetrics, defaultsApplied } }
 * This section is the ONE translation point, both directions, so neither the
 * pages nor the backend bend to the other.
 *
 * taxMode: the planner has no tax switch — the registry carries net_ex_vat
 * AND net_incl_vat as separate metrics instead. "incl" therefore swaps
 * net_ex_vat → net_incl_vat on the way out (metrics + sort) and maps the
 * value back under the page's net_ex_vat slot on the way in, so the toggle
 * changes the displayed figures honestly (the TopBar chip labels the basis).
 */

const TAX_INCL_SWAP: Record<string, string> = { net_ex_vat: "net_incl_vat" };

/** filters-object key → registry dimension id (same table buildPlannerRequest uses). */
const FILTER_DIMENSION_MAP: ReadonlyArray<[keyof AnalyticsQueryFilters, string]> = [
  ["brandIds", "brand"],
  ["branchIds", "branch"],
  ["channels", "channel"],
  ["orderTypes", "order_type"],
  ["paymentMethods", "payment_method"],
  ["hours", "hour"],
  ["menuIds", "menu_item"],
  ["categoryIds", "category"],
  ["cashiers", "cashier"],
];

function metricSwapFor(body: AnalyticsQueryBody): Record<string, string> | null {
  if (body.taxMode !== "incl") return null;
  // Don't collide when a page legitimately requests net_incl_vat itself.
  if (body.metrics.includes("net_incl_vat")) return null;
  return TAX_INCL_SWAP;
}

/** Page query body → the planner wire request the backend actually accepts. */
export function queryBodyToWireRequest(body: AnalyticsQueryBody): AnalyticsPlannerRequest {
  const swap = metricSwapFor(body);
  const mapId = (id: string) => (swap && swap[id]) || id;
  const f = body.filters;
  const dimFilters: PlannerFilterSpec[] = [];
  for (const [key, dimension] of FILTER_DIMENSION_MAP) {
    const values = f[key];
    if (Array.isArray(values) && values.length > 0) {
      dimFilters.push({ dimension, op: "in", values: values as Array<string | number> });
    }
  }
  for (const [dimension, values] of Object.entries(f.extra ?? {})) {
    if (Array.isArray(values) && values.length > 0) dimFilters.push({ dimension, op: "in", values });
  }
  return {
    metrics: body.metrics.map(mapId),
    dimensions: body.dimensions,
    range: { from: f.from, to: f.to },
    dateBasis: body.dateBasis,
    ...(dimFilters.length > 0 ? { filters: dimFilters } : {}),
    ...(body.compare ? { compare: body.compare.mode } : {}),
    ...(body.sort ? { sort: body.sort.map((s) => ({ ...s, by: mapId(s.by) })) } : {}),
    ...(body.limit != null ? { limit: body.limit } : {}),
    ...(body.offset != null ? { offset: body.offset } : {}),
  };
}

type WireValues = Record<string, number | null | undefined>;
interface WireRow {
  keys?: Record<string, string | number | null>;
  labels?: Record<string, string | null>;
  values?: WireValues;
  compare?: WireValues;
  delta?: Record<string, number | { abs?: number | null; pct?: number | null } | null>;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Rename swapped metric keys back to the page ids (net_incl_vat → net_ex_vat). */
function unswapValues(values: WireValues | undefined, swap: Record<string, string> | null): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!values) return out;
  const back: Record<string, string> = {};
  if (swap) for (const [pageId, wireId] of Object.entries(swap)) back[wireId] = pageId;
  for (const [k, v] of Object.entries(values)) out[back[k] ?? k] = asNumberOrNull(v);
  return out;
}

/** Server delta entries are {abs,pct}; the pages read one growth-% number. */
function unswapDelta(
  delta: WireRow["delta"],
  swap: Record<string, string> | null,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!delta) return out;
  const back: Record<string, string> = {};
  if (swap) for (const [pageId, wireId] of Object.entries(swap)) back[wireId] = pageId;
  for (const [k, v] of Object.entries(delta)) {
    const key = back[k] ?? k;
    if (typeof v === "number") out[key] = Number.isFinite(v) ? v : null;
    else if (v && typeof v === "object") out[key] = asNumberOrNull(v.pct);
    else out[key] = null;
  }
  return out;
}

function wireRowToResultRow(row: WireRow, dims: string[], swap: Record<string, string> | null): AnalyticsResultRow {
  const keys = dims.map((d) => (row.keys && row.keys[d] !== undefined ? row.keys[d] : null));
  const labels = dims.map((d, i) => {
    const label = row.labels ? row.labels[d] : null;
    if (label != null && label !== "") return String(label);
    return keys[i] == null ? "" : String(keys[i]);
  });
  const out: AnalyticsResultRow = { keys, labels, values: unswapValues(row.values, swap) };
  if (row.compare) out.compare = unswapValues(row.compare, swap);
  if (row.delta) out.delta = unswapDelta(row.delta, swap);
  return out;
}

/** Backend envelope → the AnalyticsResult contract every hub page consumes. */
export function normalizeAnalyticsResult(
  raw: unknown,
  dims: string[],
  swap: Record<string, string> | null,
): AnalyticsResult {
  const env = (raw ?? {}) as { data?: unknown; meta?: unknown };
  const data = (env.data && typeof env.data === "object" ? env.data : raw ?? {}) as {
    columns?: unknown;
    rows?: WireRow[];
    subtotals?: WireRow[];
    totals?: { values?: WireValues; compare?: WireValues; delta?: WireRow["delta"] } | WireValues;
    page?: { limit?: number; offset?: number; total?: number; rowCountCapped?: boolean };
  };
  const meta = (env.meta && typeof env.meta === "object" ? env.meta : {}) as {
    freshness?: { watermark?: string | null; pendingDays?: number | null };
    completeness?: unknown;
    maskedMetrics?: string[];
    defaultsApplied?: unknown;
  };

  const rows = (Array.isArray(data.rows) ? data.rows : []).map((r) => wireRowToResultRow(r, dims, swap));
  const subtotals = (Array.isArray(data.subtotals) ? data.subtotals : []).map((r) =>
    wireRowToResultRow(r, dims, swap),
  );

  // totals: {values:{...}} (wire) or an already-flat record (page-shape mocks).
  const totalsSrc =
    data.totals && typeof data.totals === "object" && "values" in data.totals
      ? (data.totals as { values?: WireValues }).values
      : (data.totals as WireValues | undefined);
  const totals = unswapValues(totalsSrc, swap);
  const totalsCompare =
    data.totals && typeof data.totals === "object" && "compare" in data.totals
      ? unswapValues((data.totals as { compare?: WireValues }).compare, swap)
      : undefined;
  const totalsDelta =
    data.totals && typeof data.totals === "object" && "delta" in data.totals
      ? unswapDelta((data.totals as { delta?: WireRow["delta"] }).delta, swap)
      : undefined;

  // Dimensionless queries: the server carries the single aggregate in totals
  // and returns zero rows — synthesize the one row the KPI pages read.
  if (dims.length === 0 && rows.length === 0 && Object.keys(totals).length > 0) {
    const kpiRow: AnalyticsResultRow = { keys: [], labels: [], values: totals };
    if (totalsCompare && Object.keys(totalsCompare).length > 0) kpiRow.compare = totalsCompare;
    if (totalsDelta && Object.keys(totalsDelta).length > 0) kpiRow.delta = totalsDelta;
    rows.push(kpiRow);
  }

  // completeness arrives as [] until the server computes it — that means
  // "not measured", which must NOT render the historical-gap banner.
  const completeness =
    meta.completeness && !Array.isArray(meta.completeness) && typeof meta.completeness === "object"
      ? (meta.completeness as AnalyticsResultMeta["completeness"])
      : undefined;

  const pendingDaysRaw = meta.freshness?.pendingDays;
  const back: Record<string, string> = {};
  if (swap) for (const [pageId, wireId] of Object.entries(swap)) back[wireId] = pageId;

  return {
    columns: Array.isArray(data.columns) ? (data.columns as AnalyticsColumn[]) : [],
    rows,
    ...(subtotals.length > 0 ? { subtotals } : {}),
    totals,
    ...(data.page
      ? {
          page: {
            limit: Number(data.page.limit) || 0,
            offset: Number(data.page.offset) || 0,
            total: Number(data.page.total ?? rows.length) || rows.length,
            ...(data.page.rowCountCapped != null
              ? { rowCountCapped: !!data.page.rowCountCapped }
              : {}),
          },
        }
      : {}),
    meta: {
      freshness: {
        watermark: meta.freshness?.watermark ?? null,
        ...(typeof pendingDaysRaw === "number" && Number.isFinite(pendingDaysRaw)
          ? { pendingDays: pendingDaysRaw }
          : {}),
      },
      ...(completeness ? { completeness } : {}),
      maskedMetrics: (Array.isArray(meta.maskedMetrics) ? meta.maskedMetrics : []).map(
        (id) => back[id] ?? id,
      ),
      ...(meta.defaultsApplied !== undefined
        ? { defaultsApplied: meta.defaultsApplied as Record<string, unknown> }
        : {}),
    },
  };
}

/* ── calls ───────────────────────────────────────────────────── */

export async function runAnalyticsQuery(body: AnalyticsQueryBody, signal?: AbortSignal): Promise<AnalyticsResult> {
  const swap = metricSwapFor(body);
  const raw = await apiClient.post<unknown>("/analytics/query", queryBodyToWireRequest(body), { signal });
  return normalizeAnalyticsResult(raw, body.dimensions, swap);
}

export async function fetchAnalyticsRegistry(signal?: AbortSignal): Promise<AnalyticsRegistry> {
  // GET /analytics/metadata answers {success, data:{metrics, dimensions, …}}.
  const raw = await apiClient.get<unknown>("/analytics/metadata", { signal });
  const data = unwrapData<AnalyticsRegistry>(raw, { metrics: [], dimensions: [] });
  return {
    metrics: Array.isArray(data.metrics) ? data.metrics : [],
    dimensions: Array.isArray(data.dimensions) ? data.dimensions : [],
  };
}

/* ── helpers ─────────────────────────────────────────────────── */

/**
 * Deterministic JSON with recursively SORTED object keys — the cache-key
 * serializer for analyticsKeys.query (two semantically-equal bodies must hash
 * identically regardless of property insertion order).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Map the shared URL filters onto the query-body slice they own. Pages spread
 * this into their body and add metrics/dimensions/sort themselves.
 */
export function buildFiltersBody(
  filters: AnalyticsFilters,
): Pick<AnalyticsQueryBody, "filters" | "dateBasis" | "taxMode"> {
  return {
    filters: {
      from: filters.from,
      to: filters.to,
      ...(filters.brandId.length > 0 ? { brandIds: filters.brandId } : {}),
      ...(filters.branchId.length > 0 ? { branchIds: filters.branchId } : {}),
      ...(filters.channel.length > 0 ? { channels: filters.channel } : {}),
      ...(filters.orderType.length > 0 ? { orderTypes: filters.orderType } : {}),
      // Wave-4 drill filters (named key → registry dimension; see the
      // AnalyticsQueryFilters comment). Only sent when non-empty.
      ...(filters.paymentMethod.length > 0 ? { paymentMethods: filters.paymentMethod } : {}),
      ...(filters.hour !== "" ? { hours: [Number(filters.hour)] } : {}),
      ...(filters.menuItemId.length > 0 ? { menuIds: filters.menuItemId } : {}),
      ...(filters.categoryId.length > 0 ? { categoryIds: filters.categoryId } : {}),
      ...(filters.cashierId.length > 0 ? { cashiers: filters.cashierId } : {}),
    },
    dateBasis: filters.businessDay ? "business_day" : "calendar_day",
    taxMode: filters.taxIncl ? "incl" : "excl",
  };
}

/**
 * The one missing-value contract: a metric that is absent, masked, or
 * non-computable reads as null — callers render "—" (NEVER 0, which would be
 * a lie in a financial report).
 */
export function displayMetric(row: AnalyticsResultRow, metricId: string): number | null {
  const v = row.values[metricId];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* ── option lookups for the top bar (reuse the app-wide caches) ──
 * Same endpoints + queryKeys as the Administration pickers
 * (modules/administration/users/pickers.ts) and the Branches screen, so the
 * caches stay hot across modules. Tolerant extraction: raw array or {data}. */

export interface ScopeOption {
  id: string;
  name: string;
}

function asOptionArray(v: unknown): ScopeOption[] {
  const arr = Array.isArray(v)
    ? v
    : v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)
      ? ((v as { data: unknown[] }).data)
      : [];
  return arr
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? row.nameAr ?? row.branchName ?? row.id ?? ""),
    }))
    .filter((o) => o.id !== "");
}

export function useBrandOptions() {
  return useQuery({
    queryKey: ["erp", "brands"],
    queryFn: async ({ signal }) => asOptionArray(await apiClient.get<unknown>("/erp/brands", { signal })),
  });
}

export function useBranchOptions() {
  return useQuery({
    queryKey: ["erp", "branches-full"],
    queryFn: async ({ signal }) =>
      asOptionArray(await apiClient.get<unknown>("/erp/branches-full", { signal })),
  });
}

interface MenuOptionRow {
  id: string;
  name: string;
  nameEn: string;
}

function asMenuOptionRows(v: unknown): MenuOptionRow[] {
  const arr = Array.isArray(v)
    ? v
    : v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)
      ? ((v as { data: unknown[] }).data)
      : [];
  return arr
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? row.id ?? ""),
      nameEn: String(row.nameEn ?? ""),
    }))
    .filter((o) => o.id !== "");
}

/**
 * Menu items for the top-bar item picker (GET /erp/menu-options — the cheap
 * read-only sibling of /erp/branches-full: ids + both names, no images or
 * prices). The CACHE is language-agnostic on purpose — both names are fetched
 * once and `select` picks the one the current UI language wants, so toggling
 * ar/en re-labels the picker without a refetch.
 */
export function useMenuItemOptions() {
  const lang = useLang();
  return useQuery({
    queryKey: ["erp", "menu-options"],
    queryFn: async ({ signal }) =>
      asMenuOptionRows(await apiClient.get<unknown>("/erp/menu-options", { signal })),
    select: (rows): ScopeOption[] =>
      rows.map((r) => ({ id: r.id, name: (lang === "en" && r.nameEn) || r.name })),
  });
}

/* ── envelope unwrap ─────────────────────────────────────────────
 * The saved-views / analytics-exports / analytics-schedules endpoints answer
 * with { success, data } envelopes. Tolerant unwrap: {data} wins, a raw value
 * passes through (test mocks often return the raw array). */

function unwrapData<T>(v: unknown, fallback: T): T {
  if (v && typeof v === "object" && "data" in (v as Record<string, unknown>)) {
    const d = (v as { data: unknown }).data;
    return (d as T) ?? fallback;
  }
  return (v as T) ?? fallback;
}

/* ── planner-shaped requests (exports + schedules) ───────────────
 * POST /analytics/exports and the schedules' stored request_json are dry-run
 * through lib/analytics/planner.plan() VERBATIM (ExportService.createJob), so
 * they must carry the PLANNER contract — range/filters[{dimension,op,values}]
 * — not the page-query body shape above. buildPlannerRequest is the one
 * translation point from the shared URL filters. */

export interface PlannerFilterSpec {
  dimension: string;
  op: "in";
  values: Array<string | number>;
}

export interface AnalyticsPlannerRequest {
  metrics: string[];
  dimensions: string[];
  range: { from: string; to: string };
  dateBasis: DateBasis;
  filters?: PlannerFilterSpec[];
  /** Planner compare is a MODE string — the server derives the window itself. */
  compare?: "prevPeriod" | "prevYear";
  sort?: AnalyticsSortSpec[];
  limit?: number;
  offset?: number;
}

/** What a page contributes to its export: metrics/dimensions (+ sort/limit). */
export interface PageExportSpec {
  metrics: string[];
  dimensions: string[];
  sort?: AnalyticsSortSpec[];
  limit?: number;
}

export function buildPlannerRequest(
  filters: AnalyticsFilters,
  spec: PageExportSpec,
): AnalyticsPlannerRequest {
  const dimFilters: PlannerFilterSpec[] = [];
  const add = (dimension: string, values: Array<string | number>) => {
    if (values.length > 0) dimFilters.push({ dimension, op: "in", values });
  };
  add("brand", filters.brandId);
  add("branch", filters.branchId);
  add("channel", filters.channel);
  add("order_type", filters.orderType);
  add("payment_method", filters.paymentMethod);
  add("hour", filters.hour === "" ? [] : [Number(filters.hour)]);
  add("menu_item", filters.menuItemId);
  add("category", filters.categoryId);
  add("cashier", filters.cashierId);
  return {
    metrics: spec.metrics,
    dimensions: spec.dimensions,
    range: { from: filters.from, to: filters.to },
    dateBasis: filters.businessDay ? "business_day" : "calendar_day",
    ...(dimFilters.length > 0 ? { filters: dimFilters } : {}),
    ...(spec.sort ? { sort: spec.sort } : {}),
    ...(spec.limit != null ? { limit: spec.limit } : {}),
  };
}

/* ── per-page export request registry ────────────────────────────
 * The TopBar's ExportMenu can't know a page's metrics; pages register a
 * factory keyed by their hub segment. Pages that never register fall back to
 * DEFAULT_EXPORT_SPEC (net + orders by business day). */

export type PageExportSpecFactory = (filters: AnalyticsFilters) => PageExportSpec;

export const DEFAULT_EXPORT_SPEC: PageExportSpec = {
  metrics: ["net_ex_vat", "orders"],
  dimensions: ["business_day"],
};

const pageExportRegistry = new Map<string, PageExportSpecFactory>();

export function setPageExportRequest(segment: string, factory: PageExportSpecFactory): void {
  pageExportRegistry.set(segment, factory);
}

export function getPageExportRequest(segment: string): PageExportSpecFactory | undefined {
  return pageExportRegistry.get(segment);
}

/** The full planner request the ExportMenu posts for a segment. */
export function buildExportRequest(segment: string, filters: AnalyticsFilters): AnalyticsPlannerRequest {
  const factory = getPageExportRequest(segment);
  return buildPlannerRequest(filters, factory ? factory(filters) : DEFAULT_EXPORT_SPEC);
}

/* ── three-way reconciliation (routes/analytics/reconciliation.js) ─
 * GET /api/analytics/reconciliation?from&to[&branchIds=a,b] — one row per
 * business day × branch with the two deltas and the exception drills the
 * server already computed (services/analytics/ReconciliationService). The
 * Reconciliation page renders this contract verbatim — no client re-merge. */

export interface ReconciliationRow {
  business_day: string;
  branch_id: string;
  sales: { orders: number; invoice_total: number; documentIds: string[]; documentIdsTotal: number };
  payments: { in: number; out: number; net: number; factIds: number[]; factIdsTotal: number };
  till: {
    open_float?: number;
    cash_sale?: number;
    cash_refund?: number;
    pay_out?: number;
    deposit?: number;
    /** null = not measurable (no till facts that day). */
    expected_cash: number | null;
    /** null = drawer never counted that day (honest "not measured", never 0). */
    counted: number | null;
  };
  deltas: {
    salesVsPayments: number | null;
    cashExpectedVsCounted: number | null;
  };
  exceptions: {
    paymentsWithoutOrder: { count: number; factIds: number[] };
    ordersWithoutPayment: { count: number; documentIds: string[] };
  };
}

export interface ReconciliationTotals {
  salesVsPayments: number | null;
  cashExpectedVsCounted: number | null;
  paymentsWithoutOrder: number;
  ordersWithoutPayment: number;
}

export interface ReconciliationData {
  rows: ReconciliationRow[];
  totals: ReconciliationTotals;
}

const EMPTY_RECONCILIATION: ReconciliationData = {
  rows: [],
  totals: { salesVsPayments: null, cashExpectedVsCounted: null, paymentsWithoutOrder: 0, ordersWithoutPayment: 0 },
};

export function fetchReconciliation(
  params: { from: string; to: string; branchIds?: string[] },
  signal?: AbortSignal,
): Promise<ReconciliationData> {
  return apiClient
    .get<unknown>("/analytics/reconciliation", {
      params: {
        from: params.from,
        to: params.to,
        ...(params.branchIds && params.branchIds.length > 0
          ? { branchIds: params.branchIds.join(",") }
          : {}),
      },
      signal,
    })
    .then((v) => unwrapData<ReconciliationData>(v, EMPTY_RECONCILIATION));
}

/* ── exports API (routes/analytics/exports.js) ───────────────────*/

export type ExportJobStatus = "queued" | "running" | "done" | "failed";
export type ExportFormat = "csv" | "xlsx";

export interface AnalyticsExportJob {
  id: string;
  status: ExportJobStatus;
  format?: ExportFormat | string;
  error?: string | null;
  row_count?: number | null;
  created_at?: string;
  finished_at?: string | null;
}

/** One export file header cell: the server column key + its display label. */
export interface ExportColumnLabel {
  key: string;
  label: string;
}

/**
 * The header labels for an export request. The backend registry stores ids
 * only (net_ex_vat, business_day, menu_item) — the human names live in these
 * dictionaries, and which language they resolve in is a CLIENT fact, so the
 * requester ships its own resolved labels and the file header comes out in the
 * reader's language. Keys the server never emits are simply ignored there.
 */
export function buildExportColumns(request: AnalyticsPlannerRequest, t: TFunction): ExportColumnLabel[] {
  // A dictionary MISS returns the dotted path itself (the I18nProvider
  // contract), and "salesReports.dims.foo" in a header cell is worse than the
  // raw id the server falls back to — so an unresolved column is not sent.
  const resolve = (path: string, vars?: Record<string, string | number>): string | null => {
    const label = t(path, vars);
    return label === path ? null : label;
  };
  const columns: ExportColumnLabel[] = [];
  for (const dimension of request.dimensions) {
    const label = resolve(`salesReports.dims.${dimension}`);
    if (!label) continue;
    columns.push({ key: dimension, label });
    // A dimension that resolves display labels gets a second `<dim>_label`
    // column server-side; naming it up front costs one array entry when the
    // dimension turns out to carry no labels at all.
    const nameLabel = resolve("salesReports.exportMenu.nameColumn", { name: label });
    if (nameLabel) columns.push({ key: `${dimension}_label`, label: nameLabel });
  }
  for (const metric of request.metrics) {
    const label = resolve(`salesReports.metrics.${metric}`);
    if (label) columns.push({ key: metric, label });
  }
  return columns;
}

export function createAnalyticsExport(
  request: AnalyticsPlannerRequest,
  format: ExportFormat,
  columns?: ExportColumnLabel[],
): Promise<AnalyticsExportJob> {
  return apiClient
    .post<unknown>("/analytics/exports", {
      request,
      format,
      ...(columns && columns.length > 0 ? { columns } : {}),
    })
    .then((v) => unwrapData<AnalyticsExportJob>(v, { id: "", status: "failed" }));
}

export function fetchAnalyticsExport(id: string, signal?: AbortSignal): Promise<AnalyticsExportJob> {
  return apiClient
    .get<unknown>(`/analytics/exports/${id}`, { signal })
    .then((v) => unwrapData<AnalyticsExportJob>(v, { id, status: "failed" }));
}

export function fetchAnalyticsExports(signal?: AbortSignal): Promise<AnalyticsExportJob[]> {
  return apiClient
    .get<unknown>("/analytics/exports", { signal })
    .then((v) => unwrapData<AnalyticsExportJob[]>(v, []));
}

/** GET /analytics/exports/:id/download — the streaming endpoint (JWT header). */
export function analyticsExportDownloadPath(id: string): string {
  return `/analytics/exports/${id}/download`;
}

/* ── schedules API (routes/analytics/schedules.js) ───────────────*/

export type ScheduleFreq = "daily" | "weekly" | "monthly";

export interface AnalyticsSchedule {
  id: string;
  name: string;
  /** The stored planner request (request_json, parsed server-side). */
  request?: AnalyticsPlannerRequest | null;
  format: ExportFormat | string;
  freq: ScheduleFreq | string;
  at_time: string;
  weekday?: number | null;
  month_day?: number | null;
  timezone: string;
  is_active: number | boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
  created_at?: string;
}

export interface AnalyticsSchedulePayload {
  name: string;
  request: AnalyticsPlannerRequest;
  format: ExportFormat;
  freq: ScheduleFreq;
  at_time: string;
  weekday?: number;
  month_day?: number;
  timezone: string;
  is_active: boolean;
}

export function fetchAnalyticsSchedules(signal?: AbortSignal): Promise<AnalyticsSchedule[]> {
  return apiClient
    .get<unknown>("/analytics/schedules", { signal })
    .then((v) => unwrapData<AnalyticsSchedule[]>(v, []));
}

export function createAnalyticsSchedule(payload: AnalyticsSchedulePayload): Promise<AnalyticsSchedule> {
  return apiClient
    .post<unknown>("/analytics/schedules", payload)
    .then((v) => unwrapData<AnalyticsSchedule>(v, payload as unknown as AnalyticsSchedule));
}

export function updateAnalyticsSchedule(
  id: string,
  payload: Partial<AnalyticsSchedulePayload>,
): Promise<AnalyticsSchedule> {
  return apiClient
    .put<unknown>(`/analytics/schedules/${id}`, payload)
    .then((v) => unwrapData<AnalyticsSchedule>(v, { id } as AnalyticsSchedule));
}

export function deleteAnalyticsSchedule(id: string): Promise<void> {
  return apiClient.delete<unknown>(`/analytics/schedules/${id}`).then(() => undefined);
}

/* ── saved views API (routes/saved-views.js) ─────────────────────
 * The shared useSavedViewsSource (shared/tables/SavedViews.tsx) now speaks the
 * same envelope/opaque-value contract (fixed in the retirement wave); the hub
 * keeps these thin wrappers because its views are URL-state blobs, not
 * DataTable captures. filtersJson for analytics views is
 * { filters: "<url search string>" }. */

export interface AnalyticsSavedView {
  id: string;
  name: string;
  module: string;
  isDefault?: boolean;
  isShared?: boolean;
  /** Opaque JSON VALUE (already parsed server-side). */
  filtersJson?: unknown;
  columnsJson?: unknown;
  sortJson?: unknown;
}

export function fetchSavedViews(module: string, signal?: AbortSignal): Promise<AnalyticsSavedView[]> {
  return apiClient
    .get<unknown>("/saved-views", { params: { module }, signal })
    .then((v) =>
      unwrapData<AnalyticsSavedView[]>(v, []).map((row) => ({ ...row, module: row.module ?? module })),
    );
}

export function createSavedView(input: {
  module: string;
  name: string;
  filtersJson: unknown;
}): Promise<AnalyticsSavedView> {
  return apiClient
    .post<unknown>("/saved-views", input)
    .then((v) => unwrapData<AnalyticsSavedView>(v, { id: "", name: input.name, module: input.module }));
}

export function deleteSavedView(id: string): Promise<void> {
  return apiClient.delete<unknown>(`/saved-views/${id}`).then(() => undefined);
}

/**
 * Extract the saved URL search string from a view's filtersJson. Accepts the
 * canonical { filters: "<qs>" } blob, a bare string, or null for anything
 * else (e.g. a legacy DataTable capture — not a URL state).
 */
export function savedViewSearchString(view: Pick<AnalyticsSavedView, "filtersJson">): string | null {
  const fj = view.filtersJson;
  if (typeof fj === "string") return fj.replace(/^\?/, "");
  if (fj && typeof fj === "object") {
    const inner = (fj as { filters?: unknown }).filters;
    if (typeof inner === "string") return inner.replace(/^\?/, "");
  }
  return null;
}
