// Phase 3A — transfers list query. Scope + filters in the key so a scope change
// aborts the in-flight request; keepPreviousData keeps the table stable while a
// new page/filter loads. Hits the scoped read router (/api/inventory/transfers).

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toTransfersPage, type TransfersPage } from "@/lib/adapters/transfer.adapter";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";

export interface TransfersQuery {
  status?: string;
  q?: string;
  fromWarehouseId?: string;
  toWarehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}

export function useTransfers(query: TransfersQuery) {
  const { scope } = useWarehouseScope();
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : "";
  const params = {
    warehouseId: warehouseId || undefined,
    status: query.status || undefined,
    q: query.q || undefined,
    fromWarehouseId: query.fromWarehouseId || undefined,
    toWarehouseId: query.toWarehouseId || undefined,
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 25,
    sort: query.sort || "created_at",
    dir: query.dir || "desc",
  };
  return useQuery<TransfersPage>({
    queryKey: queryKeys.transfers.list(scope, params),
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/inventory/transfers", { signal, params }).then(toTransfersPage),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}
