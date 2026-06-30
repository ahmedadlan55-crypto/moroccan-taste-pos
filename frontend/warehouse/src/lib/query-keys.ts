// Stable, hierarchical query keys for TanStack Query. Centralized so cache
// invalidation after a (future) mutation targets exactly the right slices, and
// so a warehouse-scope change produces a NEW key — which makes react-query
// abort the in-flight request for the old scope automatically.

export interface InventoryGridParams {
  warehouseId?: string;
  q?: string;
  category?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}

export const queryKeys = {
  // Per-user warehouse access scope (Phase 2A.2) — loaded once, shared by the
  // scope + permission providers.
  accessScope: () => ["access-scope"] as const,

  // Phase 2B — analytics + reports. Scope + filters in the key so a change
  // aborts the in-flight request for the old scope/filters.
  analytics: (scope: string, params: Record<string, unknown>) => ["analytics", scope, params] as const,
  report: (type: string, scope: string, params: Record<string, unknown>) => ["report", type, scope, params] as const,
  reportCatalog: () => ["report-catalog"] as const,

  dashboard: (scope: string) => ["dashboard", scope] as const,

  warehouses: {
    all: ["warehouses"] as const,
    summary: (scope: string) => ["warehouses", "summary", scope] as const,
    detail: (id: string) => ["warehouses", "detail", id] as const,
  },

  inventory: {
    all: ["inventory"] as const,
    // warehouseId kept as its OWN key segment (index 2) so placeholderData can
    // tell "same warehouse, new page" (safe to keep) from a scope change.
    grid: (warehouseId: string, params: Omit<InventoryGridParams, "warehouseId">) =>
      ["inventory", "grid", warehouseId, params] as const,
    categories: (warehouseId: string) => ["inventory", "categories", warehouseId] as const,
    itemDistribution: (itemId: string) => ["inventory", "item", itemId, "distribution"] as const,
    itemMovements: (itemId: string) => ["inventory", "item", itemId, "movements"] as const,
  },
} as const;
