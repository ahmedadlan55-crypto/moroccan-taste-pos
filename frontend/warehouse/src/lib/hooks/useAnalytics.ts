import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toAnalytics, type Analytics } from "@/lib/adapters/analytics.adapter";
import { ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";

export interface AnalyticsFilters {
  from?: string;
  to?: string;
  category?: string;
  type?: string;
  window?: number;
}

// One call → the whole analytics payload (no N+1). Scope + filters are in the
// query key so a change aborts the stale request.
export function useAnalytics(scope: string, filters: AnalyticsFilters) {
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : undefined;
  const params = {
    warehouseId,
    from: filters.from || undefined,
    to: filters.to || undefined,
    category: filters.category || undefined,
    type: filters.type || undefined,
    window: filters.window || undefined,
  };
  return useQuery<Analytics>({
    queryKey: queryKeys.analytics(scope, filters as Record<string, unknown>),
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/inventory/analytics/summary", { signal, params }).then(toAnalytics),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
