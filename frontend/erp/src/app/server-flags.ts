// Runtime server feature flags — read once from the public /api/version. The
// shell uses them to keep flagged nav items DORMANT until the backend turns the
// corresponding flag on (a nav item with `flag: "x"` is hidden unless flags.x is
// true). Generalized from the warehouse pattern.
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

interface VersionResponse {
  procurementP2P?: boolean;
  warehouseV2?: boolean;
  orderToCash?: boolean;
  [key: string]: unknown;
}

export type ServerFlags = Record<string, boolean>;

export function useServerFlags(): ServerFlags {
  const q = useQuery({
    queryKey: ["erp", "server-flags"],
    queryFn: ({ signal }) => apiClient.get<VersionResponse>("/version", { signal }),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  const v = q.data ?? {};
  return {
    warehouseV2: v.warehouseV2 === true,
    procurementP2P: v.procurementP2P === true,
    orderToCash: v.orderToCash === true,
  };
}
