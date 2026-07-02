import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toInventoryPage, type InventoryPage } from "@/lib/adapters/inventory.adapter";
import { ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";

export interface InventoryQuery {
  scope: string; // warehouse scope: "all" or a warehouse id
  q?: string;
  category?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}

// useWarehouseInventory — the paginated, sortable, filterable grid.
// • Server pagination/sort/filter (the backend whitelists sort columns).
// • placeholderData keeps the previous page's rows ONLY while the warehouse
//   scope is unchanged — so paging/filtering is smooth, but switching
//   warehouses shows a fresh load instead of the wrong warehouse's data.
export function useWarehouseInventory(query: InventoryQuery) {
  const warehouseId = query.scope && query.scope !== ALL_WAREHOUSES ? query.scope : "";
  const params = {
    q: query.q || undefined,
    category: query.category || undefined,
    status: query.status || undefined,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 25,
    sort: query.sort || undefined,
    dir: query.dir || undefined,
  };

  return useQuery<InventoryPage>({
    queryKey: queryKeys.inventory.grid(warehouseId, params),
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>("/inventory/grid", {
          signal,
          params: { warehouseId: warehouseId || undefined, ...params },
        })
        .then(toInventoryPage),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    placeholderData: (previousData, previousQuery) => {
      // queryKey[2] is the warehouse id segment — keep previous rows only
      // within the same scope.
      if (previousData && previousQuery && previousQuery.queryKey[2] === warehouseId) {
        return previousData;
      }
      return undefined;
    },
  });
}

// Distinct categories for the grid filter (scoped to the current warehouse).
export function useInventoryCategories(scope: string) {
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : "";
  return useQuery<string[]>({
    queryKey: queryKeys.inventory.categories(warehouseId),
    queryFn: ({ signal }) =>
      apiClient
        .get<{ categories?: string[] }>("/inventory/categories", {
          signal,
          params: { warehouseId: warehouseId || undefined },
        })
        .then((r) => (Array.isArray(r?.categories) ? r.categories : [])),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}
