// Phase 4B — lot-integrity hook (read-only; scoped). Surfaces per (warehouse, item)
// drift between Σ(lot balances) and warehouse_stock so an operator can spot a desync.
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { toIntegrity } from "@/lib/adapters/lotIntegrity.adapter";

const BASE = "/inventory/v2/lot-integrity";

export function useLotIntegrity(query: { warehouseId?: string; driftOnly?: boolean }) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  if (query.warehouseId) params.warehouseId = query.warehouseId;
  if (query.driftOnly) params.driftOnly = "1";
  return useQuery({ queryKey: queryKeys.lotIntegrity(scope, params), queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toIntegrity), staleTime: 30_000 });
}
