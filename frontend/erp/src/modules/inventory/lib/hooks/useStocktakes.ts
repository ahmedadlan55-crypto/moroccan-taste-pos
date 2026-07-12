// Phase 3C — TanStack Query hooks for the professional stocktake. List/detail +
// the full transition set (create/update/start/saveCounts/submit/requestRecount/
// approve/post/cancel/remove). create + post carry an Idempotency-Key; every
// transition carries expectedVersion; 409s surface as ApiError(isConflict) with
// NO auto-retry. onSuccess invalidates the stocktake list+detail AND the
// dashboard/inventory/analytics/report slices so every dependent screen refreshes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { toStocktakePage, toStocktakeDetail, toStocktakeMutation, type StocktakeMutationResult } from "@/modules/inventory/lib/adapters/stocktake.adapter";

const BASE = "/inventory/v2/stocktakes";

export interface CountConflict { lineId: string; itemId: string; itemName: string; code: string; message: string }
export interface SaveCountsResult { success: boolean; applied: number; conflicts: CountConflict[]; aggregates?: unknown }
function uid(): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* jsdom */ }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface StocktakeListQuery { q?: string; status?: string; warehouseId?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number; sort?: string; dir?: string; }

export function useStocktakeList(query: StocktakeListQuery) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.stocktakes.list(scope, params),
    queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toStocktakePage),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useStocktakeDetail(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: queryKeys.stocktakes.detail(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}`, { signal }).then(toStocktakeDetail),
  });
}

export function useStocktakeMutations() {
  const qc = useQueryClient();
  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.stocktakes.all });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.stocktakes.detail(id) });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["analytics"] });
    qc.invalidateQueries({ queryKey: ["report"] });
    // a posted stocktake creates an adjustment → refresh that list too.
    qc.invalidateQueries({ queryKey: ["invtx", "adjustment"] });
  };
  type V = { id: string; expectedVersion?: number };
  type R = StocktakeMutationResult;

  const create = useMutation<R, Error, Record<string, unknown>>({
    mutationFn: (input) => apiClient.post<unknown>(BASE, input, { headers: { "Idempotency-Key": uid() } }).then(toStocktakeMutation),
    onSuccess: () => invalidate(),
  });
  const update = useMutation<R, Error, { id: string; input: Record<string, unknown> }>({
    mutationFn: ({ id, input }) => apiClient.patch<unknown>(`${BASE}/${id}`, input).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const start = useMutation<R, Error, V>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/start`, { expectedVersion }).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const saveCounts = useMutation<SaveCountsResult, Error, { id: string; counts: unknown[] }>({
    mutationFn: ({ id, counts }) => apiClient.put<SaveCountsResult>(`${BASE}/${id}/counts`, { counts }),
    // counts autosave does NOT invalidate the whole detail (would clobber local edits);
    // the workspace refetches explicitly when it needs server truth.
  });
  const submit = useMutation<R, Error, V>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/submit`, { expectedVersion }).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const requestRecount = useMutation<R, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/request-recount`, { reason, expectedVersion }).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const approve = useMutation<R, Error, V>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/approve`, { expectedVersion }).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const post = useMutation<R, Error, V>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/post`, { expectedVersion }, { headers: { "Idempotency-Key": uid() } }).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const cancel = useMutation<R, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/cancel`, { reason, expectedVersion }).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const remove = useMutation<R, Error, { id: string }>({
    mutationFn: ({ id }) => apiClient.delete<unknown>(`${BASE}/${id}`).then(toStocktakeMutation),
    onSuccess: (_r, v) => invalidate(v.id),
  });

  return { create, update, start, saveCounts, submit, requestRecount, approve, post, cancel, remove };
}
