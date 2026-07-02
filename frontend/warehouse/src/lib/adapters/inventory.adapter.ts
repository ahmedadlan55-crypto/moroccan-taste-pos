// Adapters for the inventory grid + item-detail endpoints:
//   GET /api/inventory/grid                       (paginated, warehouse WAC)
//   GET /api/inventory/items/:itemId/warehouses   (distribution)
//   GET /api/inventory/movements?itemId=          (item movements)
import { toMovement, type Movement } from "./dashboard.adapter";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}

export type ItemStatus = "available" | "low" | "out" | "negative";

export interface InventoryRow {
  itemId: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  qty: number;
  /** null = reservations are NOT tracked by this backend (UI shows "—"). */
  reserved: number | null;
  available: number;
  avgCost: number;
  /** true = value uses the global item cost, not a warehouse WAC. */
  costEstimated: boolean;
  value: number;
  reorderPoint: number;
  status: ItemStatus;
  lastMovementAt: string | null;
}

export interface InventoryPage {
  rows: InventoryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sort: string;
  dir: string;
}

const STATUSES: ItemStatus[] = ["available", "low", "out", "negative"];

export function toInventoryRow(raw: Record<string, unknown>): InventoryRow {
  const status = STATUSES.indexOf(raw.status as ItemStatus) !== -1 ? (raw.status as ItemStatus) : "available";
  return {
    itemId: str(raw.itemId),
    sku: str(raw.sku ?? raw.itemId),
    name: str(raw.name),
    category: str(raw.category),
    unit: str(raw.unit),
    warehouseId: str(raw.warehouseId),
    warehouseName: str(raw.warehouseName),
    warehouseCode: str(raw.warehouseCode),
    qty: num(raw.qty),
    reserved: raw.reserved == null ? null : num(raw.reserved),
    available: num(raw.available),
    avgCost: num(raw.avgCost),
    costEstimated: Boolean(raw.costEstimated),
    value: num(raw.value),
    reorderPoint: num(raw.reorderPoint),
    status,
    lastMovementAt: raw.lastMovementAt ? str(raw.lastMovementAt) : null,
  };
}

export function toInventoryPage(raw: unknown): InventoryPage {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    rows: Array.isArray(r.rows) ? (r.rows as Record<string, unknown>[]).map(toInventoryRow) : [],
    total: num(r.total),
    page: num(r.page) || 1,
    pageSize: num(r.pageSize) || 25,
    totalPages: num(r.totalPages) || 1,
    sort: str(r.sort || "name"),
    dir: str(r.dir || "ASC"),
  };
}

export interface ItemDistribution {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  isMain: boolean;
  qty: number;
  value: number;
}

export function toItemDistribution(raw: unknown): ItemDistribution[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((r) => ({
    warehouseId: str(r.warehouseId),
    warehouseName: str(r.warehouseName),
    warehouseCode: str(r.warehouseCode),
    isMain: Boolean(r.isMain),
    qty: num(r.qty),
    value: num(r.value),
  }));
}

export function toItemMovements(raw: unknown): Movement[] {
  // /movements returns a bare array (unpaginated) or { items, total } (paginated).
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  return (list as Record<string, unknown>[]).map((m) =>
    toMovement({
      id: m.id,
      date: m.date,
      itemId: m.itemId,
      itemName: m.itemName,
      type: m.type,
      qty: m.qty,
      reason: m.reason,
      warehouseId: m.warehouseId,
      warehouseName: m.warehouseName,
    }),
  );
}
