// Phase 4B — lot-integrity adapter: per (warehouse, item) Σ(lot)=warehouse_stock drift.
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function s(v: unknown): string { return v == null ? "" : String(v); }

export interface IntegrityRow { warehouseId: string; warehouseName: string; itemId: string; itemName: string; stockQty: number; lotQty: number; drift: number; ok: boolean }
export interface IntegrityResult { rows: IntegrityRow[]; summary: { total: number; drifting: number } }

export function toIntegrity(raw: unknown): IntegrityResult {
  const o = (raw || {}) as { data?: unknown[]; summary?: Record<string, unknown> };
  const rows = Array.isArray(o.data) ? o.data.map((d) => { const x = d as Record<string, unknown>; return { warehouseId: s(x.warehouseId), warehouseName: s(x.warehouseName), itemId: s(x.itemId), itemName: s(x.itemName), stockQty: num(x.stockQty), lotQty: num(x.lotQty), drift: num(x.drift), ok: !!x.ok }; }) : [];
  const sm = o.summary || {};
  return { rows, summary: { total: num(sm.total), drifting: num(sm.drifting) } };
}
