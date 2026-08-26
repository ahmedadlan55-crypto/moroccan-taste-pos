// Phase 4B — lot hooks: list/detail/movements/trace + mutations (create / edit /
// quarantine / release / recall). Mutations carry Idempotency-Key + expectedVersion;
// 409s surface as ApiError(isConflict). onSuccess invalidates lots + inventory +
// dashboard + expiry + lot-integrity so every dependent surface refreshes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { toLotPage, toLotDetail, toLotMovements, toLotTrace, toLotMutation, type LotMutationResult } from "@/modules/inventory/lib/adapters/lot.adapter";

const BASE = "/inventory/v2/lots";
function uid(): string { try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* jsdom */ } return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36); }

export interface LotListQuery { q?: string; itemId?: string; warehouseId?: string; status?: string; risk?: string; page?: number; pageSize?: number }

export function useLotList(query: LotListQuery) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({ queryKey: queryKeys.lots.list(scope, params), queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toLotPage), staleTime: 30_000, placeholderData: (prev) => prev });
}
/** Full filtered lot snapshot for print. Never falls back to the visible page. */
export async function fetchLotSnapshot(query: Omit<LotListQuery, "page" | "pageSize">): Promise<ReturnType<typeof toLotPage>> {
  const params: Record<string, string | number> = { snapshot: 1 };
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return apiClient.get<unknown>(BASE, { params }).then(toLotPage);
}
export function useLotDetail(id: string | null) {
  return useQuery({ enabled: !!id, queryKey: queryKeys.lots.detail(id ?? ""), queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}`, { signal }).then(toLotDetail) });
}
export function useLotMovements(id: string | null) {
  return useQuery({ enabled: !!id, queryKey: queryKeys.lots.movements(id ?? ""), queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}/movements`, { signal }).then(toLotMovements) });
}
export function useLotTrace(id: string | null) {
  return useQuery({ enabled: !!id, queryKey: queryKeys.lots.trace(id ?? ""), queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}/trace`, { signal }).then(toLotTrace) });
}

export function useLotMutations() {
  const qc = useQueryClient();
  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.lots.all });
    if (id) { qc.invalidateQueries({ queryKey: queryKeys.lots.detail(id) }); qc.invalidateQueries({ queryKey: queryKeys.lots.trace(id) }); }
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: queryKeys.expiry.all });
    qc.invalidateQueries({ queryKey: ["lot-integrity"] });
  };
  type R = LotMutationResult;
  const create = useMutation<R, Error, Record<string, unknown>>({
    mutationFn: (input) => apiClient.post<unknown>(BASE, input, { headers: { "Idempotency-Key": uid() } }).then(toLotMutation),
    onSuccess: () => invalidate(),
  });
  const update = useMutation<R, Error, { id: string; input: Record<string, unknown> }>({
    mutationFn: ({ id, input }) => apiClient.patch<unknown>(`${BASE}/${id}`, input).then(toLotMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const lifecycle = (action: "quarantine" | "release" | "recall") => useMutation<R, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/${action}`, { reason, expectedVersion }, { headers: { "Idempotency-Key": uid() } }).then(toLotMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  return { create, update, quarantine: lifecycle("quarantine"), release: lifecycle("release"), recall: lifecycle("recall") };
}
