import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { toPurchaseIntelligenceResult, toWarehouseIntelligenceOverview } from "./adapters";
import type { WarehouseIntelligenceFilters } from "./contracts";

function params(filters: WarehouseIntelligenceFilters) {
  return {
    from: filters.from,
    to: filters.to,
    warehouseId: filters.warehouseId,
    q: filters.q,
    supplierId: filters.supplierId,
    itemId: filters.itemId,
    sort: filters.sort,
    dir: filters.dir,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export function useWarehouseIntelligenceOverview(filters: WarehouseIntelligenceFilters) {
  return useQuery({
    queryKey: ["warehouse-intelligence", "overview", filters] as const,
    queryFn: ({ signal }) => apiClient
      .get<unknown>("/inventory/intelligence/overview", { signal, params: params(filters) })
      .then(toWarehouseIntelligenceOverview),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}

export function usePurchaseIntelligence(filters: WarehouseIntelligenceFilters, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["warehouse-intelligence", "purchases", filters] as const,
    queryFn: ({ signal }) => apiClient
      .get<unknown>("/inventory/intelligence/purchases", { signal, params: params(filters) })
      .then(toPurchaseIntelligenceResult),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}
