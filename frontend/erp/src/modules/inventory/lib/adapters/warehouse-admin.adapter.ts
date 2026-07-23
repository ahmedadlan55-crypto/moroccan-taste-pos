// Warehouse ADMIN adapter — Phase W6 (warehouse management CRUD).
//
// The ONLY place that knows the /api/inventory/v2/warehouses response shapes.
// Kept separate from warehouse.adapter.ts (the read-only legacy projection)
// so the existing read paths stay byte-for-byte untouched.

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

// One warehouse with its computed stats (list + detail share this shape).
// Field-compatible with dashboard.adapter's WarehouseSummary so shared helpers
// (warehouseHealth / alertCount / warehouseTypeLabel) work structurally.
export interface WarehouseAdmin {
  id: string;
  code: string;
  name: string;
  nameEn: string;
  type: string;
  brandId: string;
  brandName: string;
  branchId: string;
  branchName: string;
  costCenterId: string;
  location: string;
  manager: string;
  description: string;
  isMain: boolean;
  isActive: boolean;
  createdAt: string | null;
  itemCount: number;
  totalQty: number;
  totalValue: number;
  lowCount: number;
  outCount: number;
  negativeCount: number;
  movementCount: number;
  lastMovementAt: string | null;
}

export interface WarehouseAdminTotals {
  warehouseCount: number;
  activeCount: number;
  itemCount: number;
  totalQty: number;
  totalValue: number;
  movementCount: number;
}

export interface WarehouseAdminListResponse {
  warehouses: WarehouseAdmin[];
  totals: WarehouseAdminTotals;
}

export interface WarehouseMovementRow {
  id: string;
  date: string | null;
  itemId: string;
  itemName: string;
  type: "in" | "out" | string;
  qty: number;
  reason: string;
  username: string;
  notes: string;
  referenceType: string;
}

export interface WarehouseAuditEvent {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  note: string;
  createdAt: string | null;
}

export interface ScopeAssignmentRow {
  userId: number;
  username: string;
  fullName: string;
  role: string;
  createdAt: string | null;
  createdBy: string;
}

export interface ScopeUserRow {
  id: number;
  username: string;
  fullName: string;
  role: string;
  hasAccess: boolean;
}

export interface WarehouseAdminDetailResponse {
  warehouse: WarehouseAdmin;
  movements: WarehouseMovementRow[];
  assignments: ScopeAssignmentRow[];
  timeline: WarehouseAuditEvent[];
}

export interface ScopeAssignmentsResponse {
  warehouseId: string;
  assignments: ScopeAssignmentRow[];
  users: ScopeUserRow[];
}

export interface WarehouseFormOptions {
  brands: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  types: string[];
}

// Mutation envelope (subset of the unified V2 contract we consume in the UI).
export interface WarehouseMutationResult {
  success: boolean;
  id: string;
  documentNumber: string | null;
  status: string | null;
}

export function toWarehouseAdmin(raw: Record<string, unknown>): WarehouseAdmin {
  return {
    id: str(raw.id),
    code: str(raw.code),
    name: str(raw.name),
    nameEn: str(raw.nameEn),
    type: str(raw.type) || "branch",
    brandId: str(raw.brandId),
    brandName: str(raw.brandName),
    branchId: str(raw.branchId),
    branchName: str(raw.branchName),
    costCenterId: str(raw.costCenterId),
    location: str(raw.location),
    manager: str(raw.manager),
    description: str(raw.description),
    isMain: bool(raw.isMain),
    isActive: bool(raw.isActive),
    createdAt: raw.createdAt ? str(raw.createdAt) : null,
    itemCount: num(raw.itemCount),
    totalQty: num(raw.totalQty),
    totalValue: num(raw.totalValue),
    lowCount: num(raw.lowCount),
    outCount: num(raw.outCount),
    negativeCount: num(raw.negativeCount),
    movementCount: num(raw.movementCount),
    lastMovementAt: raw.lastMovementAt ? str(raw.lastMovementAt) : null,
  };
}

export function toWarehouseAdminList(raw: unknown): WarehouseAdminListResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const totals = (r.totals ?? {}) as Record<string, unknown>;
  return {
    warehouses: Array.isArray(r.data)
      ? (r.data as Record<string, unknown>[]).map(toWarehouseAdmin)
      : [],
    totals: {
      warehouseCount: num(totals.warehouseCount),
      activeCount: num(totals.activeCount),
      itemCount: num(totals.itemCount),
      totalQty: num(totals.totalQty),
      totalValue: num(totals.totalValue),
      movementCount: num(totals.movementCount),
    },
  };
}

function toMovementRow(raw: Record<string, unknown>): WarehouseMovementRow {
  return {
    id: str(raw.id),
    date: raw.date ? str(raw.date) : null,
    itemId: str(raw.itemId),
    itemName: str(raw.itemName),
    type: str(raw.type),
    qty: num(raw.qty),
    reason: str(raw.reason),
    username: str(raw.username),
    notes: str(raw.notes),
    referenceType: str(raw.referenceType),
  };
}

function toAssignmentRow(raw: Record<string, unknown>): ScopeAssignmentRow {
  return {
    userId: num(raw.userId),
    username: str(raw.username),
    fullName: str(raw.fullName),
    role: str(raw.role),
    createdAt: raw.createdAt ? str(raw.createdAt) : null,
    createdBy: str(raw.createdBy),
  };
}

function toAuditEvent(raw: Record<string, unknown>): WarehouseAuditEvent {
  return {
    id: str(raw.id),
    action: str(raw.action),
    fromStatus: raw.from_status != null ? str(raw.from_status) : null,
    toStatus: raw.to_status != null ? str(raw.to_status) : null,
    actor: str(raw.actor),
    note: str(raw.note),
    createdAt: raw.created_at ? str(raw.created_at) : null,
  };
}

export function toWarehouseAdminDetail(raw: unknown): WarehouseAdminDetailResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    warehouse: toWarehouseAdmin((r.data ?? {}) as Record<string, unknown>),
    movements: Array.isArray(r.movements)
      ? (r.movements as Record<string, unknown>[]).map(toMovementRow)
      : [],
    assignments: Array.isArray(r.assignments)
      ? (r.assignments as Record<string, unknown>[]).map(toAssignmentRow)
      : [],
    timeline: Array.isArray(r.timeline)
      ? (r.timeline as Record<string, unknown>[]).map(toAuditEvent)
      : [],
  };
}

export function toScopeAssignments(raw: unknown): ScopeAssignmentsResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  return {
    warehouseId: str(d.warehouseId),
    assignments: Array.isArray(d.assignments)
      ? (d.assignments as Record<string, unknown>[]).map(toAssignmentRow)
      : [],
    users: Array.isArray(d.users)
      ? (d.users as Record<string, unknown>[]).map((u) => ({
          id: num(u.id),
          username: str(u.username),
          fullName: str(u.fullName),
          role: str(u.role),
          hasAccess: bool(u.hasAccess),
        }))
      : [],
  };
}

export function toWarehouseFormOptions(raw: unknown): WarehouseFormOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v)
      ? (v as Record<string, unknown>[]).map((x) => ({ id: str(x.id), name: str(x.name) }))
      : [];
  return {
    brands: list(d.brands),
    branches: list(d.branches),
    types: Array.isArray(d.types) ? (d.types as unknown[]).map(str) : [],
  };
}

export function toWarehouseMutationResult(raw: unknown): WarehouseMutationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const data = (r.data ?? {}) as Record<string, unknown>;
  return {
    success: r.success === true,
    id: str(data.id ?? r.id),
    documentNumber: r.documentNumber != null ? str(r.documentNumber) : null,
    status: r.status != null ? str(r.status) : null,
  };
}
