// Runtime server feature flags — read once from the public /api/version. Used to
// keep the Procurement (P2P) surface fully DORMANT in the UI until the backend
// flag PROCUREMENT_P2P_ENABLE is turned on: when off, the nav entry is hidden and
// the /purchasing routes show a "not enabled" notice (never a broken section).
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

interface VersionResponse {
  procurementP2P?: boolean;
  warehouseV2?: boolean;
}

export function useServerFlags() {
  const q = useQuery({
    queryKey: ["server-flags"],
    queryFn: ({ signal }) => apiClient.get<VersionResponse>("/version", { signal }),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  return {
    procurementEnabled: q.data?.procurementP2P === true,
    loading: q.isLoading,
  };
}
