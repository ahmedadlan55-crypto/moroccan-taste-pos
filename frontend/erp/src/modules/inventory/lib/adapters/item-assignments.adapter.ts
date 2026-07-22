// D1/D3 — adapters for the item branch/warehouse assignment surface
// (GET/PUT /api/inventory/v2/items/:id/assignments). The endpoint is owned by
// D3 (backend); this adapter is the ONLY place that knows its response shape.
// Reads defensively so a partial payload never throws before the form renders.

function s(v: unknown): string { return v == null ? "" : String(v); }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function bool(v: unknown): boolean { return v === 1 || v === true || v === "1"; }

/** One item↔warehouse assignment with its per-location reorder rule. */
export interface ItemAssignmentRow {
  branchId: string;
  branchName: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  isActive: boolean;
  isDefault: boolean;
  minQty: number;
  maxStock: number;
  reorderPoint: number;
  reorderQty: number;
  safetyStock: number;
  leadTimeDays: number;
}

export interface ItemAssignmentsData {
  itemId: string;
  version: number;
  defaultWarehouseId: string;
  assignments: ItemAssignmentRow[];
}

export function toAssignmentRow(r: Record<string, unknown>): ItemAssignmentRow {
  return {
    branchId: s(r.branch_id ?? r.branchId),
    branchName: s(r.branch_name ?? r.branchName),
    warehouseId: s(r.warehouse_id ?? r.warehouseId),
    warehouseName: s(r.warehouse_name ?? r.warehouseName ?? r.warehouse_id ?? r.warehouseId),
    warehouseCode: s(r.warehouse_code ?? r.warehouseCode),
    isActive: r.is_active == null && r.isActive == null ? true : bool(r.is_active ?? r.isActive),
    isDefault: bool(r.is_default ?? r.isDefault ?? r.is_main ?? r.isMain),
    minQty: num(r.min_qty ?? r.minQty),
    maxStock: num(r.max_stock ?? r.maxStock),
    reorderPoint: num(r.reorder_point ?? r.reorderPoint),
    reorderQty: num(r.reorder_qty ?? r.reorderQty),
    safetyStock: num(r.safety_stock ?? r.safetyStock),
    leadTimeDays: num(r.lead_time_days ?? r.leadTimeDays),
  };
}

export function toItemAssignments(raw: unknown): ItemAssignmentsData {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? r) as Record<string, unknown>;
  const rows = (Array.isArray(d.assignments) ? d.assignments : []) as Record<string, unknown>[];
  const assignments = rows.map(toAssignmentRow);
  const defaultWarehouseId =
    s(d.default_warehouse_id ?? d.defaultWarehouseId) ||
    (assignments.find((a) => a.isDefault)?.warehouseId ?? "");
  return {
    itemId: s(d.item_id ?? d.itemId ?? d.id),
    version: num(d.version) || 1,
    defaultWarehouseId,
    assignments,
  };
}

/** Payload the form PUTs back. `expectedVersion` carries the optimistic lock. */
export interface AssignmentInput {
  warehouseId: string;
  isActive: boolean;
  minQty: number;
  maxStock: number;
  reorderPoint: number;
  reorderQty: number;
  safetyStock: number;
  leadTimeDays: number;
}
export interface SaveAssignmentsInput {
  defaultWarehouseId: string | null;
  assignments: AssignmentInput[];
  expectedVersion?: number;
}
