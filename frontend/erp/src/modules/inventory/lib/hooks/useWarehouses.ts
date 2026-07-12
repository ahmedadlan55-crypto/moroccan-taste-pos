import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import {
  toWarehousesSummary,
  type WarehousesSummaryResponse,
  type WarehouseSummary,
} from "@/modules/inventory/lib/adapters/dashboard.adapter";
import { ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";

// useWarehouses — every warehouse with value/qty/alerts + grand totals, in ONE
// query (no N+1). Honors the current scope: "all" lists every warehouse; a
// specific id narrows to that one.
export function useWarehouses(scope: string = ALL_WAREHOUSES) {
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : undefined;
  return useQuery<WarehousesSummaryResponse>({
    queryKey: queryKeys.warehouses.summary(scope),
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>("/inventory/warehouses-summary", { signal, params: { warehouseId } })
        .then(toWarehousesSummary),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}

// useWarehouse — a single warehouse's summary (for the detail drawer). Backed
// by the same endpoint scoped to one id.
export function useWarehouse(id: string | null) {
  return useQuery<WarehouseSummary | null>({
    queryKey: queryKeys.warehouses.detail(id ?? ""),
    enabled: !!id,
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>("/inventory/warehouses-summary", { signal, params: { warehouseId: id ?? "" } })
        .then((raw) => {
          const list = toWarehousesSummary(raw).warehouses;
          return list[0] ?? null;
        }),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
