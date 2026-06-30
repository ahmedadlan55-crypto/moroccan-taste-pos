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

  // Phase 3A — transfers (stock issues). Scope + filters in the list key so a
  // scope change aborts the in-flight request; detail keyed by id so a mutation
  // can refresh exactly one document.
  transfers: {
    all: ["transfers"] as const,
    list: (scope: string, params: Record<string, unknown>) => ["transfers", "list", scope, params] as const,
    detail: (id: string) => ["transfers", "detail", id] as const,
  },

  // Phase 3B — independent inventory transactions (receipts / issues / adjustments).
  // Keyed by docType so the three doc lists/details share one cache namespace; a
  // mutation invalidates all(docType) (every list) + detail(docType,id).
  invtx: {
    all: (docType: string) => ["invtx", docType] as const,
    list: (docType: string, params: Record<string, unknown>) => ["invtx", docType, "list", params] as const,
    detail: (docType: string, id: string) => ["invtx", docType, "detail", id] as const,
  },

  // Phase 4A — item master + per-warehouse replenishment.
  items: {
    all: ["items"] as const,
    list: (params: Record<string, unknown>) => ["items", "list", params] as const,
    detail: (id: string) => ["items", "detail", id] as const,
    categories: () => ["items", "categories"] as const,
    units: () => ["items", "units"] as const,
  },
  replenishment: {
    all: ["replenishment"] as const,
    list: (scope: string, params: Record<string, unknown>) => ["replenishment", "list", scope, params] as const,
    summary: (scope: string, params: Record<string, unknown>) => ["replenishment", "summary", scope, params] as const,
  },

  // Phase 3C — professional stocktake. List keyed by scope+filters (a scope
  // change aborts the in-flight request); detail keyed by id; a mutation
  // invalidates all + detail(id) + the dependent dashboard/inventory slices.
  stocktakes: {
    all: ["stocktakes"] as const,
    list: (scope: string, params: Record<string, unknown>) => ["stocktakes", "list", scope, params] as const,
    detail: (id: string) => ["stocktakes", "detail", id] as const,
  },

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
