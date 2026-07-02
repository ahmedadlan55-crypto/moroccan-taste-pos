// Phase 4B — expiry list + summary adapters (backend returns camelCase).
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function s(v: unknown): string { return v == null ? "" : String(v); }

export interface ExpiryRow {
  lotId: string; itemId: string; itemName: string; lotNumber: string;
  expiryDate: string | null; daysToExpiry: number | null; expiryClass: string;
  lifecycleStatus: string; warehouseId: string; warehouseName: string; qty: number;
}
export interface ExpiryPage { rows: ExpiryRow[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }
export interface ExpirySummary { byClass: { expired: number; critical: number; warning: number; safe: number }; qtyExpired: number; total: number }

export function toExpiryPage(raw: unknown): ExpiryPage {
  const o = (raw || {}) as { data?: unknown[]; pagination?: Record<string, unknown> };
  const rows = Array.isArray(o.data) ? o.data.map((d) => { const x = d as Record<string, unknown>; return { lotId: s(x.lotId), itemId: s(x.itemId), itemName: s(x.itemName), lotNumber: s(x.lotNumber), expiryDate: x.expiryDate ? s(x.expiryDate) : null, daysToExpiry: x.daysToExpiry == null ? null : num(x.daysToExpiry), expiryClass: s(x.expiryClass || "none"), lifecycleStatus: s(x.lifecycleStatus || "active"), warehouseId: s(x.warehouseId), warehouseName: s(x.warehouseName), qty: num(x.qty) }; }) : [];
  const p = o.pagination || {};
  return { rows, pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 } };
}
export function toExpirySummary(raw: unknown): ExpirySummary {
  const d = ((raw || {}) as { data?: Record<string, unknown> }).data || {};
  const bc = (d.byClass || {}) as Record<string, unknown>;
  return { byClass: { expired: num(bc.expired), critical: num(bc.critical), warning: num(bc.warning), safe: num(bc.safe) }, qtyExpired: num(d.qtyExpired), total: num(d.total) };
}
