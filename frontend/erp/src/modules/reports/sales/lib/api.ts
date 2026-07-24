// Sales Analytics Hub — API surface for POST /api/analytics/query and
// GET /api/analytics/metadata (backend: routes/analytics.js + lib/analytics/*).
// Types mirror the backend contract; the backend stays authoritative (masked
// metrics arrive as meta.maskedMetrics and render as "—", never as 0).
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
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
  page?: { limit: number; offset: number; total: number };
  meta: AnalyticsResultMeta;
}

/** Registry payload of GET /api/analytics/metadata (metric/dimension catalog). */
export interface AnalyticsRegistry {
  metrics: Array<{ id: string; kind: string; format: string; equationKey?: string; requiresCap?: string }>;
  dimensions: Array<{ id: string; kind: string; groupable: boolean; requiresCap?: string }>;
}

/* ── calls ───────────────────────────────────────────────────── */

export function runAnalyticsQuery(body: AnalyticsQueryBody, signal?: AbortSignal): Promise<AnalyticsResult> {
  return apiClient.post<AnalyticsResult>("/analytics/query", body, { signal });
}

export function fetchAnalyticsRegistry(signal?: AbortSignal): Promise<AnalyticsRegistry> {
  return apiClient.get<AnalyticsRegistry>("/analytics/metadata", { signal });
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
