// Warehouse adapter — the ONLY place that knows the backend's snake_case /
// legacy field names. Screens consume the clean camelCase shape below.

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  type: string;
  brandId: string;
  brandName: string;
  branchId: string;
  branchName: string;
  isActive: boolean;
}

// GET /api/erp/warehouses-list already returns a camelCase-ish projection,
// but the legacy flag `isActive` arrives as 0/1; normalize to boolean and
// guarantee every field is present.
export function toWarehouse(raw: Record<string, unknown>): Warehouse {
  return {
    id: String(raw.id ?? ""),
    code: String(raw.code ?? ""),
    name: String(raw.name ?? ""),
    type: String(raw.type ?? "branch"),
    brandId: String(raw.brandId ?? raw.brand_id ?? ""),
    brandName: String(raw.brandName ?? raw.brand_name ?? ""),
    branchId: String(raw.branchId ?? raw.branch_id ?? ""),
    branchName: String(raw.branchName ?? raw.branch_name ?? ""),
    isActive: Boolean(Number(raw.isActive ?? raw.is_active ?? 0)),
  };
}

export function toWarehouseList(rows: unknown): Warehouse[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => toWarehouse(r as Record<string, unknown>));
}
