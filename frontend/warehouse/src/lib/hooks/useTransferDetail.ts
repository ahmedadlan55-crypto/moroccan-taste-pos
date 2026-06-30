// Phase 3A — single transfer detail (header + lines + version + audit timeline
// + related movements + GL refs). Keyed by id so a mutation can refresh exactly
// this document.

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toTransferDetail, type TransferDetail } from "@/lib/adapters/transfer.adapter";

export function useTransferDetail(id: string | null) {
  return useQuery<TransferDetail>({
    queryKey: queryKeys.transfers.detail(id ?? ""),
    enabled: !!id,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`/inventory/transfers/${encodeURIComponent(id ?? "")}`, { signal }).then(toTransferDetail),
    staleTime: 10_000,
  });
}
