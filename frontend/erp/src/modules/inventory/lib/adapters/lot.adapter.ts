// Phase 4B — lot list / detail / trace adapters. The backend (routes/inventory-lots.js)
// already returns camelCase; these add defensive coercion + stable shapes.
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function s(v: unknown): string { return v == null ? "" : String(v); }

export interface LotRow {
  id: string; itemId: string; itemName: string; lotNumber: string;
  expiryDate: string | null; manufactureDate: string | null;
  expiryClass: string; daysToExpiry: number | null; lifecycleStatus: string;
  totalQty: number; unitCost: number; version: number; isImported: boolean;
  sourceType: string | null; sourceId: string | null; notes: string | null; createdAt: string | null;
}
export interface LotPage { rows: LotRow[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }
export interface LotDistribution { warehouseId: string; warehouseName: string; qty: number }
export interface LotDetail { lot: LotRow; distribution: LotDistribution[] }
export interface LotMovement { id: string; warehouseId: string; warehouseName: string; signedQty: number; referenceType: string | null; referenceId: string | null; reason: string | null; actor: string | null; occurredAt: string }
export interface LotTrace { lot: LotRow; source: { type: string | null; id: string | null }; warehouses: LotDistribution[]; timeline: Array<LotMovement & { at: string }>; recallImpact: Array<{ referenceType: string; referenceId: string | null; qty: number }> }

function row(r: Record<string, unknown>): LotRow {
  return {
    id: s(r.id), itemId: s(r.itemId), itemName: s(r.itemName), lotNumber: s(r.lotNumber),
    expiryDate: r.expiryDate ? s(r.expiryDate) : null, manufactureDate: r.manufactureDate ? s(r.manufactureDate) : null,
    expiryClass: s(r.expiryClass || "none"), daysToExpiry: r.daysToExpiry == null ? null : num(r.daysToExpiry),
    lifecycleStatus: s(r.lifecycleStatus || "active"), totalQty: num(r.totalQty), unitCost: num(r.unitCost),
    version: num(r.version) || 1, isImported: !!r.isImported, sourceType: r.sourceType ? s(r.sourceType) : null,
    sourceId: r.sourceId ? s(r.sourceId) : null, notes: r.notes ? s(r.notes) : null, createdAt: r.createdAt ? s(r.createdAt) : null,
  };
}

export function toLotPage(raw: unknown): LotPage {
  const o = (raw || {}) as { data?: unknown[]; pagination?: Record<string, unknown> };
  const rows = Array.isArray(o.data) ? o.data.map((x) => row(x as Record<string, unknown>)) : [];
  const p = o.pagination || {};
  return { rows, pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 } };
}
export function toLotDetail(raw: unknown): LotDetail {
  const o = (raw || {}) as { data?: Record<string, unknown>; distribution?: unknown[] };
  return {
    lot: row(o.data || {}),
    distribution: Array.isArray(o.distribution) ? o.distribution.map((d) => { const x = d as Record<string, unknown>; return { warehouseId: s(x.warehouseId), warehouseName: s(x.warehouseName), qty: num(x.qty) }; }) : [],
  };
}
export function toLotMovements(raw: unknown): LotMovement[] {
  const o = (raw || {}) as { data?: unknown[] };
  return Array.isArray(o.data) ? o.data.map((m) => { const x = m as Record<string, unknown>; return { id: s(x.id), warehouseId: s(x.warehouseId), warehouseName: s(x.warehouseName), signedQty: num(x.signedQty), referenceType: x.referenceType ? s(x.referenceType) : null, referenceId: x.referenceId ? s(x.referenceId) : null, reason: x.reason ? s(x.reason) : null, actor: x.actor ? s(x.actor) : null, occurredAt: s(x.occurredAt) }; }) : [];
}
export function toLotTrace(raw: unknown): LotTrace {
  const o = (raw || {}) as Record<string, unknown>;
  const src = (o.source || {}) as Record<string, unknown>;
  return {
    lot: row((o.lot || {}) as Record<string, unknown>),
    source: { type: src.type ? s(src.type) : null, id: src.id ? s(src.id) : null },
    warehouses: Array.isArray(o.warehouses) ? (o.warehouses as Record<string, unknown>[]).map((x) => ({ warehouseId: s(x.warehouseId), warehouseName: s(x.warehouseName), qty: num(x.qty) })) : [],
    timeline: Array.isArray(o.timeline) ? (o.timeline as Record<string, unknown>[]).map((x) => ({ id: "", warehouseId: s(x.warehouseId), warehouseName: s(x.warehouseName), signedQty: num(x.signedQty), referenceType: x.referenceType ? s(x.referenceType) : null, referenceId: x.referenceId ? s(x.referenceId) : null, reason: x.reason ? s(x.reason) : null, actor: x.actor ? s(x.actor) : null, occurredAt: s(x.at), at: s(x.at) })) : [],
    recallImpact: Array.isArray(o.recallImpact) ? (o.recallImpact as Record<string, unknown>[]).map((x) => ({ referenceType: s(x.referenceType), referenceId: x.referenceId ? s(x.referenceId) : null, qty: num(x.qty) })) : [],
  };
}

export interface LotMutationResult { id: string | null; status: string | null; version: number | null }
export function toLotMutation(raw: unknown): LotMutationResult {
  const o = (raw || {}) as Record<string, unknown>;
  return { id: o.id ? s(o.id) : null, status: o.status ? s(o.status) : null, version: o.version == null ? null : num(o.version) };
}
