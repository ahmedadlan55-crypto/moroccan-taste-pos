import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toDashboardSummary, type DashboardSummary } from "@/lib/adapters/dashboard.adapter";
import { ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";

// useWarehouseDashboard — the whole command center in one request.
// • scope "all" → company-wide aggregate; a warehouse id → that warehouse only.
// • the scope is part of the query key, so changing it ABORTS the in-flight
//   request (signal passed through) and fetches fresh (no stale carry-over).
export function useWarehouseDashboard(scope: string) {
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : undefined;
  return useQuery<DashboardSummary>({
    queryKey: queryKeys.dashboard(scope),
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>("/inventory/dashboard-summary", { signal, params: { warehouseId } })
        .then(toDashboardSummary),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}
