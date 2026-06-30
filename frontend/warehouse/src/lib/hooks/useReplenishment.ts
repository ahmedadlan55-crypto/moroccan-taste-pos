// Phase 4A — replenishment hooks (advisory; read-only). Scope is in the key so a
// warehouse-scope change aborts the in-flight request.

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { toReplenishmentPage, toReplenishmentSummary } from "@/lib/adapters/replenishment.adapter";

const BASE = "/inventory/v2/replenishment";

export interface ReplenishmentQuery { q?: string; warehouseId?: string; category?: string; status?: string; risk?: string; page?: number; pageSize?: number }

export function useReplenishment(query: ReplenishmentQuery) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.replenishment.list(scope, params),
    queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toReplenishmentPage),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useReplenishmentSummary(query: { warehouseId?: string; category?: string }) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.replenishment.summary(scope, params),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/summary`, { signal, params }).then(toReplenishmentSummary),
    staleTime: 30_000,
  });
}
