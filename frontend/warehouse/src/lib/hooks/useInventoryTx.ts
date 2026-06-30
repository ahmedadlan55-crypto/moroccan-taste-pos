// Phase 3B — TanStack Query hooks for the three independent inventory-transaction
// doc types. Generic by docType so receipts/issues/adjustments share one data
// layer. Mutations carry an Idempotency-Key (create/post/reverse) + expectedVersion;
// 409s surface as ApiError(isConflict). onSuccess invalidates the doc list+detail
// AND the dashboard/inventory/analytics/reports slices so every screen refreshes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { toInvTxPage, toInvTxDetail, toMutationResult, type MutationResult } from "@/lib/adapters/invtx.adapter";
import type { InvTxDocType } from "@/lib/schemas/invtx.schema";

function uid(): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* jsdom */ }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function base(docType: InvTxDocType): string { return `/inventory/v2/${docType}s`; }

export interface InvTxListQuery {
  q?: string;
  status?: string;
  warehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}

export function useInvTxList(docType: InvTxDocType, query: InvTxListQuery) {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.invtx.list(docType, params),
    queryFn: ({ signal }) => apiClient.get<unknown>(base(docType), { signal, params }).then(toInvTxPage),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useInvTxDetail(docType: InvTxDocType, id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: queryKeys.invtx.detail(docType, id ?? ""),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${base(docType)}/${id}`, { signal }).then(toInvTxDetail),
  });
}

export function useInvTxMutations(docType: InvTxDocType) {
  const qc = useQueryClient();
  const B = base(docType);
  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.invtx.all(docType) });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.invtx.detail(docType, id) });
    // refresh every dependent surface (§9): dashboard, inventory, analytics, reports.
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["analytics"] });
    qc.invalidateQueries({ queryKey: ["report"] });
  };

  const create = useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (input) => apiClient.post<unknown>(B, input, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: () => invalidate(),
  });
  const update = useMutation<MutationResult, Error, { id: string; input: Record<string, unknown> }>({
    mutationFn: ({ id, input }) => apiClient.patch<unknown>(`${B}/${id}`, input).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const approve = useMutation<MutationResult, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${B}/${id}/approve`, { expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const post = useMutation<MutationResult, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${B}/${id}/post`, { expectedVersion }, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const cancel = useMutation<MutationResult, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${B}/${id}/cancel`, { reason, expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const reverse = useMutation<MutationResult, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${B}/${id}/reverse`, { reason, expectedVersion }, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const remove = useMutation<MutationResult, Error, { id: string }>({
    mutationFn: ({ id }) => apiClient.delete<unknown>(`${B}/${id}`).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });

  return { create, update, approve, post, cancel, reverse, remove };
}
