// Phase 4B — expiry hooks (read-only; scoped). The list/summary are classified
// server-side (Asia/Riyadh date-only) so the UI just renders + filters.
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { toExpiryPage, toExpirySummary } from "@/modules/inventory/lib/adapters/expiry.adapter";

const BASE = "/inventory/v2/expiry";

export interface ExpiryQuery { warehouseId?: string; level?: string; page?: number; pageSize?: number }

export function useExpiry(query: ExpiryQuery) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({ queryKey: queryKeys.expiry.list(scope, params), queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toExpiryPage), staleTime: 30_000, placeholderData: (prev) => prev });
}
/** Complete expiry snapshot for CSV/print; 413 is surfaced when >5,000 rows. */
export async function fetchExpirySnapshot(query: Omit<ExpiryQuery, "page" | "pageSize">): Promise<ReturnType<typeof toExpiryPage>> {
  const params: Record<string, string | number> = { snapshot: 1 };
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return apiClient.get<unknown>(BASE, { params }).then(toExpiryPage);
}
export function useExpirySummary(query: { warehouseId?: string }) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({ queryKey: queryKeys.expiry.summary(scope, params), queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/summary`, { signal, params }).then(toExpirySummary), staleTime: 30_000 });
}
