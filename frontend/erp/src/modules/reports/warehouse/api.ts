import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import {
  toGrniReconciliation,
  toInventoryAccountingReconciliation,
  toInventoryPerformance,
  toPurchaseIntelligenceResult,
  toWarehouseIntelligenceOverview,
} from "./adapters";
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

export function useInventoryPerformance(filters: WarehouseIntelligenceFilters) {
  return useQuery({
    queryKey: ["warehouse-intelligence", "performance", filters.from, filters.to, filters.warehouseId ?? "all"] as const,
    queryFn: ({ signal }) => apiClient
      .get<unknown>("/inventory/intelligence/performance", {
        signal,
        params: { from: filters.from, to: filters.to, warehouseId: filters.warehouseId },
      })
      .then(toInventoryPerformance),
    // Keep the previous period's charts on screen while the next one loads, so
    // changing the date range does not blank the whole dashboard.
    placeholderData: (previous) => previous,
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

export function useInventoryAccountingReconciliation(warehouseId?: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["warehouse-intelligence", "accounting-reconciliation", warehouseId ?? "all"] as const,
    queryFn: ({ signal }) => apiClient
      .get<unknown>("/inventory/intelligence/accounting-reconciliation", { signal, params: { warehouseId } })
      .then(toInventoryAccountingReconciliation),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function useGrniReconciliation(warehouseId?: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["warehouse-intelligence", "grni-reconciliation", warehouseId ?? "all"] as const,
    queryFn: ({ signal }) => apiClient
      .get<unknown>("/inventory/intelligence/grni-reconciliation", { signal, params: { warehouseId } })
      .then(toGrniReconciliation),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}
