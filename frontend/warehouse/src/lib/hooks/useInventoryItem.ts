import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import {
  toItemDistribution,
  toItemMovements,
  type ItemDistribution,
} from "@/lib/adapters/inventory.adapter";
import type { Movement } from "@/lib/adapters/dashboard.adapter";

// useInventoryItem — drill-down data for the item drawer: its distribution
// across warehouses and its most recent movements. Two parallel queries (the
// drawer opens with both already in flight); only enabled when an id is set.
export function useInventoryItem(itemId: string | null) {
  const distribution = useQuery<ItemDistribution[]>({
    queryKey: queryKeys.inventory.itemDistribution(itemId ?? ""),
    enabled: !!itemId,
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>(`/inventory/items/${encodeURIComponent(itemId ?? "")}/warehouses`, { signal })
        .then(toItemDistribution),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

  const movements = useQuery<Movement[]>({
    queryKey: queryKeys.inventory.itemMovements(itemId ?? ""),
    enabled: !!itemId,
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>("/inventory/movements", { signal, params: { itemId: itemId ?? "", limit: 15 } })
        .then(toItemMovements),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

  return { distribution, movements };
}
