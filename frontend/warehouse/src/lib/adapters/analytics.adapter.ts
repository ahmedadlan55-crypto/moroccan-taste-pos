// Adapter for GET /api/inventory/analytics/summary (Phase 2B). Thin + safe:
// the backend returns clean typed data; we coerce numbers and default missing
// slices so the charts never crash.

export interface ReportWarning { code: string; message: string; level: string; }

export interface AnalyticsKpis {
  inventoryValueWac: number;
  estimatedCostValue: number;
  itemCount: number;
  totalQty: number;
  availableCount: number;
  lowCount: number;
  outCount: number;
  negativeCount: number;
  activeWarehouses: number;
}
export interface ValueByWarehouse { id: string; name: string; code: string; value: number; qty: number; }
export interface ValueByCategory { category: string; value: number; qty: number; items: number; }
export interface TopItem { itemId: string; name: string; category: string; qty: number; value: number; }
export interface TrendPoint { bucket: string; in: number; out: number; }
export interface WarehouseComparison {
  id: string; name: string; code: string; type: string;
  itemCount: number; totalQty: number; totalValue: number;
  lowCount: number; outCount: number; negativeCount: number; estimatedValue: number; availableCount: number;
}
export interface Transfers { pending: number; inTransit: number; remainingQty: number; byStatus: Record<string, number>; }
export interface DataQuality {
  estimatedCostItems: number; missingMinStock: number;
  expiryCoverage: { lots: number; covered: number; reliable: boolean };
}
export interface Analytics {
  kpis: AnalyticsKpis;
  valueByWarehouse: ValueByWarehouse[];
  warehouseComparison: WarehouseComparison[];
  valueByCategory: ValueByCategory[];
  topItemsByValue: TopItem[];
  movementTrend: TrendPoint[];
  slowNoMovement: { window: number; count: number };
  transfers: Transfers;
  dataQualityIndicators: DataQuality;
  warnings: ReportWarning[];
  generatedAt: string | null;
  scope: { allWarehousesAccess: boolean; warehouseId: string | null };
}

function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function s(v: unknown): string { return v == null ? "" : String(v); }
function arr<T>(v: unknown): T[] { return Array.isArray(v) ? (v as T[]) : []; }

export function toAnalytics(raw: unknown): Analytics {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const k = (d.kpis ?? {}) as Record<string, unknown>;
  const sl = (d.slowNoMovement ?? {}) as Record<string, unknown>;
  const tr = (d.transfers ?? {}) as Record<string, unknown>;
  const dq = (d.dataQualityIndicators ?? {}) as Record<string, unknown>;
  const ec = (dq.expiryCoverage ?? {}) as Record<string, unknown>;
  return {
    kpis: {
      inventoryValueWac: n(k.inventoryValueWac), estimatedCostValue: n(k.estimatedCostValue),
      itemCount: n(k.itemCount), totalQty: n(k.totalQty), availableCount: n(k.availableCount),
      lowCount: n(k.lowCount), outCount: n(k.outCount), negativeCount: n(k.negativeCount), activeWarehouses: n(k.activeWarehouses),
    },
    valueByWarehouse: arr<Record<string, unknown>>(d.valueByWarehouse).map((w) => ({ id: s(w.id), name: s(w.name), code: s(w.code), value: n(w.value), qty: n(w.qty) })),
    warehouseComparison: arr<Record<string, unknown>>(d.warehouseComparison).map((w) => ({
      id: s(w.id), name: s(w.name), code: s(w.code), type: s(w.type), itemCount: n(w.itemCount),
      totalQty: n(w.totalQty), totalValue: n(w.totalValue), lowCount: n(w.lowCount), outCount: n(w.outCount),
      negativeCount: n(w.negativeCount), estimatedValue: n(w.estimatedValue), availableCount: n(w.availableCount),
    })),
    valueByCategory: arr<Record<string, unknown>>(d.valueByCategory).map((c) => ({ category: s(c.category), value: n(c.value), qty: n(c.qty), items: n(c.items) })),
    topItemsByValue: arr<Record<string, unknown>>(d.topItemsByValue).map((t) => ({ itemId: s(t.itemId), name: s(t.name), category: s(t.category), qty: n(t.qty), value: n(t.value) })),
    movementTrend: arr<Record<string, unknown>>(d.movementTrend).map((p) => ({ bucket: s(p.bucket), in: n(p.in), out: n(p.out) })),
    slowNoMovement: { window: n(sl.window), count: n(sl.count) },
    transfers: { pending: n(tr.pending), inTransit: n(tr.inTransit), remainingQty: n(tr.remainingQty), byStatus: (tr.byStatus ?? {}) as Record<string, number> },
    dataQualityIndicators: {
      estimatedCostItems: n(dq.estimatedCostItems), missingMinStock: n(dq.missingMinStock),
      expiryCoverage: { lots: n(ec.lots), covered: n(ec.covered), reliable: ec.reliable === true },
    },
    warnings: arr<ReportWarning>(r.dataQualityWarnings),
    generatedAt: r.generatedAt ? s(r.generatedAt) : null,
    scope: ((): Analytics["scope"] => {
      const sc = (r.scope ?? {}) as Record<string, unknown>;
      return { allWarehousesAccess: sc.allWarehousesAccess === true, warehouseId: sc.warehouseId ? s(sc.warehouseId) : null };
    })(),
  };
}
