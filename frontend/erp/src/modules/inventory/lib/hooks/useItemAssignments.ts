// D1/D3 — item branch/warehouse assignments (GET/PUT
// /api/inventory/v2/items/:id/assignments). The PUT replaces the item's
// assignment set + per-location reorder rules and sets the default warehouse,
// under an optimistic-lock (expectedVersion). Endpoint owned by D3 (backend);
// invalidates items + inventory + replenishment + dashboard on success so every
// dependent surface refreshes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import {
  toItemAssignments,
  type ItemAssignmentsData,
  type SaveAssignmentsInput,
} from "@/modules/inventory/lib/adapters/item-assignments.adapter";

const BASE = "/inventory/v2/items";

export function useItemAssignments(itemId: string | null) {
  return useQuery<ItemAssignmentsData>({
    enabled: !!itemId,
    queryKey: [...queryKeys.items.detail(itemId ?? ""), "assignments"],
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`${BASE}/${itemId}/assignments`, { signal }).then(toItemAssignments),
    staleTime: 15_000,
  });
}

export function useSaveItemAssignments(itemId: string) {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, SaveAssignmentsInput>({
    mutationFn: (input) => apiClient.put<{ success: boolean }>(`${BASE}/${itemId}/assignments`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...queryKeys.items.detail(itemId), "assignments"] });
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["replenishment"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
