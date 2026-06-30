import type { WarehouseAction } from "@/lib/permissions";

// Adapter for GET /api/inventory/access-scope (Phase 2A.2). Normalizes the
// caller's warehouse access + capability map. The backend never lists a
// forbidden warehouse, so this is the authoritative source for the selector.

export interface AccessibleWarehouse {
  id: string;
  name: string;
  code: string;
  type: string;
  branchId: string;
  isActive: boolean;
}

export interface AccessScope {
  enforced: boolean;
  role: string;
  allWarehousesAccess: boolean;
  accessibleWarehouses: AccessibleWarehouse[];
  capabilities: Partial<Record<WarehouseAction, boolean>>;
}

export function toAccessScope(raw: unknown): AccessScope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(r.accessibleWarehouses) ? r.accessibleWarehouses : [];
  return {
    enforced: r.enforced === true,
    role: typeof r.role === "string" ? r.role : "",
    allWarehousesAccess: r.allWarehousesAccess === true,
    accessibleWarehouses: list
      .map((w) => {
        const o = (w ?? {}) as Record<string, unknown>;
        return {
          id: String(o.id ?? ""),
          name: String(o.name ?? o.id ?? ""),
          code: String(o.code ?? ""),
          type: String(o.type ?? ""),
          branchId: String(o.branchId ?? ""),
          isActive: o.isActive !== false,
        };
      })
      .filter((w) => w.id),
    capabilities:
      r.capabilities && typeof r.capabilities === "object"
        ? (r.capabilities as Partial<Record<WarehouseAction, boolean>>)
        : {},
  };
}
