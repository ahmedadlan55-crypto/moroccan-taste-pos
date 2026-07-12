// Adapter for the report envelopes (Phase 2B). Rows are kept generic
// (Record<string, unknown>) and rendered via the per-report column config in
// lib/reports-config.ts.

export interface ReportWarning { code: string; message: string; level: string; }
export interface Pagination { page: number; pageSize: number; total: number; totalPages: number; }

export interface ReportResult {
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  pagination: Pagination | null;
  filters: Record<string, unknown>;
  scope: { allWarehousesAccess: boolean; warehouseId: string | null };
  generatedAt: string | null;
  warnings: ReportWarning[];
}

export interface ReportCatalogEntry { type: string; label: string; adminOnly: boolean; }

function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }

export function toReportResult(raw: unknown): ReportResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = r.pagination as Record<string, unknown> | null;
  const sc = (r.scope ?? {}) as Record<string, unknown>;
  return {
    rows: Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [],
    totals: (r.totals ?? {}) as Record<string, unknown>,
    pagination: p ? { page: n(p.page), pageSize: n(p.pageSize), total: n(p.total), totalPages: n(p.totalPages) } : null,
    filters: (r.filters ?? {}) as Record<string, unknown>,
    scope: { allWarehousesAccess: sc.allWarehousesAccess === true, warehouseId: sc.warehouseId ? String(sc.warehouseId) : null },
    generatedAt: r.generatedAt ? String(r.generatedAt) : null,
    warnings: Array.isArray(r.dataQualityWarnings) ? (r.dataQualityWarnings as ReportWarning[]) : [],
  };
}

export function toReportCatalog(raw: unknown): ReportCatalogEntry[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const data = Array.isArray(r.data) ? r.data : [];
  return data.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return { type: String(o.type ?? ""), label: String(o.label ?? o.type ?? ""), adminOnly: o.adminOnly === true };
  }).filter((e) => e.type);
}
