// Adapters for the Phase 2A read-only endpoints:
//   GET /api/inventory/dashboard-summary
//   GET /api/inventory/warehouses-summary
// The backend already emits camelCase, but the adapter is still the boundary
// that COERCES every number, defaults every array, and gives the UI a single
// stable type — so a contract drift fails here, not deep in a screen.

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}

export interface WarehouseSummary {
  id: string;
  name: string;
  code: string;
  type: string;
  location: string;
  manager: string;
  isActive: boolean;
  itemCount: number;
  totalQty: number;
  totalValue: number;
  lowCount: number;
  outCount: number;
  negativeCount: number;
  lastMovementAt: string | null;
}

export interface Movement {
  id: string;
  date: string | null;
  itemId: string;
  itemName: string;
  type: "in" | "out" | string;
  qty: number;
  reason: string;
  warehouseId: string;
  warehouseName: string;
}

export interface WarehouseTotals {
  warehouseCount: number;
  activeCount: number;
  itemCount: number;
  totalQty: number;
  totalValue: number;
  lowCount: number;
  outCount: number;
  negativeCount: number;
}

export interface DashboardSummary {
  scope: { warehouseId: string | null };
  kpis: {
    inventoryValue: number;
    itemCount: number;
    lowCount: number;
    outCount: number;
    negativeCount: number;
    activeWarehouses: number;
  };
  transfers: { pending: number; inTransit: number };
  warehouses: WarehouseSummary[];
  recentMovements: Movement[];
  expiry: { available: boolean; count: number; atRiskValue: number; days: number };
}

export function toWarehouseSummary(raw: Record<string, unknown>): WarehouseSummary {
  return {
    id: str(raw.id),
    name: str(raw.name),
    code: str(raw.code),
    type: str(raw.type),
    location: str(raw.location),
    manager: str(raw.manager),
    isActive: Boolean(raw.isActive),
    itemCount: num(raw.itemCount),
    totalQty: num(raw.totalQty),
    totalValue: num(raw.totalValue),
    lowCount: num(raw.lowCount),
    outCount: num(raw.outCount),
    negativeCount: num(raw.negativeCount),
    lastMovementAt: raw.lastMovementAt ? str(raw.lastMovementAt) : null,
  };
}

export function toMovement(raw: Record<string, unknown>): Movement {
  return {
    id: str(raw.id),
    date: raw.date ? str(raw.date) : null,
    itemId: str(raw.itemId),
    itemName: str(raw.itemName),
    type: str(raw.type),
    qty: num(raw.qty),
    reason: str(raw.reason),
    warehouseId: str(raw.warehouseId),
    warehouseName: str(raw.warehouseName),
  };
}

export function toDashboardSummary(raw: unknown): DashboardSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kpis = (r.kpis ?? {}) as Record<string, unknown>;
  const transfers = (r.transfers ?? {}) as Record<string, unknown>;
  const expiry = (r.expiry ?? {}) as Record<string, unknown>;
  return {
    scope: { warehouseId: (r.scope as { warehouseId?: string })?.warehouseId ?? null },
    kpis: {
      inventoryValue: num(kpis.inventoryValue),
      itemCount: num(kpis.itemCount),
      lowCount: num(kpis.lowCount),
      outCount: num(kpis.outCount),
      negativeCount: num(kpis.negativeCount),
      activeWarehouses: num(kpis.activeWarehouses),
    },
    transfers: { pending: num(transfers.pending), inTransit: num(transfers.inTransit) },
    warehouses: Array.isArray(r.warehouses)
      ? (r.warehouses as Record<string, unknown>[]).map(toWarehouseSummary)
      : [],
    recentMovements: Array.isArray(r.recentMovements)
      ? (r.recentMovements as Record<string, unknown>[]).map(toMovement)
      : [],
    expiry: {
      available: Boolean(expiry.available),
      count: num(expiry.count),
      atRiskValue: num(expiry.atRiskValue),
      days: num(expiry.days) || 30,
    },
  };
}

export interface WarehousesSummaryResponse {
  warehouses: WarehouseSummary[];
  totals: WarehouseTotals;
}

export function toWarehousesSummary(raw: unknown): WarehousesSummaryResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const totals = (r.totals ?? {}) as Record<string, unknown>;
  return {
    warehouses: Array.isArray(r.warehouses)
      ? (r.warehouses as Record<string, unknown>[]).map(toWarehouseSummary)
      : [],
    totals: {
      warehouseCount: num(totals.warehouseCount),
      activeCount: num(totals.activeCount),
      itemCount: num(totals.itemCount),
      totalQty: num(totals.totalQty),
      totalValue: num(totals.totalValue),
      lowCount: num(totals.lowCount),
      outCount: num(totals.outCount),
      negativeCount: num(totals.negativeCount),
    },
  };
}
