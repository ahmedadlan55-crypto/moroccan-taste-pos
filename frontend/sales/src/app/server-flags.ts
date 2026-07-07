// Runtime server flags — read once from the public /api/version. The Order-to-Cash
// SPA must stay fully dormant when the backend flag ORDER_TO_CASH_ENABLE is off:
// the router shows a "not enabled" notice instead of a broken section.
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";

interface VersionResponse {
  orderToCash?: boolean;
  procurementP2P?: boolean;
  warehouseV2?: boolean;
  posV2?: boolean;
}

export function useServerFlags() {
  const q = useQuery({
    queryKey: qk.version,
    queryFn: ({ signal }) => apiClient.get<VersionResponse>("/version", { signal }),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  return {
    orderToCashEnabled: q.data?.orderToCash === true,
    loading: q.isLoading,
    error: q.isError,
  };
}
