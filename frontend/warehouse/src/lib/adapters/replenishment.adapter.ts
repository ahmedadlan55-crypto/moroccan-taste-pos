// Phase 4A — adapters for /api/inventory/v2/replenishment (advisory recommendations).

function s(v: unknown): string { return v == null ? "" : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export interface ReplenishmentRow {
  itemId: string; sku: string; name: string; unit: string; category: string;
  warehouseId: string; warehouseName: string;
  onHand: number; reorderPoint: number; recommendedQty: number; recommendedValue: number;
  daysOfCover: number | null; avgDailyOutbound: number; reorderStatus: string; stockoutRisk: string;
  leadTimeDays: number; hasRule: boolean; lastMovementAt: string | null;
}
export interface ReplenishmentPage {
  rows: ReplenishmentRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  lookbackDays: number; filters: Record<string, unknown>;
}

function toRow(r: Record<string, unknown>): ReplenishmentRow {
  return {
    itemId: s(r.itemId), sku: s(r.sku), name: s(r.name), unit: s(r.unit), category: s(r.category),
    warehouseId: s(r.warehouseId), warehouseName: s(r.warehouseName),
    onHand: num(r.onHand), reorderPoint: num(r.reorderPoint), recommendedQty: num(r.recommendedQty), recommendedValue: num(r.recommendedValue),
    daysOfCover: r.daysOfCover === null || r.daysOfCover === undefined ? null : num(r.daysOfCover),
    avgDailyOutbound: num(r.avgDailyOutbound), reorderStatus: s(r.reorderStatus) || "ok", stockoutRisk: s(r.stockoutRisk) || "unknown",
    leadTimeDays: num(r.leadTimeDays), hasRule: r.hasRule === true, lastMovementAt: r.lastMovementAt ? s(r.lastMovementAt) : null,
  };
}
export function toReplenishmentPage(raw: unknown): ReplenishmentPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[];
  const p = (r.pagination ?? {}) as Record<string, unknown>;
  return {
    rows: rows.map(toRow),
    pagination: { page: num(p.page) || 1, pageSize: num(p.pageSize) || 25, total: num(p.total), totalPages: num(p.totalPages) || 1 },
    lookbackDays: num(r.lookbackDays) || 30, filters: (r.filters ?? {}) as Record<string, unknown>,
  };
}

export interface ReplenishmentSummary {
  total: number; reorderItems: number; recommendedValue: number; lookbackDays: number;
  byStatus: Record<string, number>; byRisk: Record<string, number>;
}
export function toReplenishmentSummary(raw: unknown): ReplenishmentSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  return {
    total: num(d.total), reorderItems: num(d.reorderItems), recommendedValue: num(d.recommendedValue), lookbackDays: num(d.lookbackDays) || 30,
    byStatus: (d.byStatus ?? {}) as Record<string, number>, byRisk: (d.byRisk ?? {}) as Record<string, number>,
  };
}
