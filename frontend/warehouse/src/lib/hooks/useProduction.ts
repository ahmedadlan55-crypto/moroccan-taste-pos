// Phase P1 — TanStack Query hooks for Production Orders V2. Mutations carry an
// Idempotency-Key (create/issue/output/reverse) + expectedVersion; 409s surface
// as ApiError(isConflict). onSuccess invalidates the production slices AND the
// dependent dashboard/inventory/lots/analytics surfaces.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import {
  toProductionPage, toProductionDetail, toBomOptions, toAvailability,
  toVarianceReport, toMutationResult,
  type MutationResult,
} from "@/lib/adapters/production.adapter";

const BASE = "/inventory/v2/production-orders";

function uid(): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* jsdom */ }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface ProductionListQuery {
  q?: string;
  status?: string;
  warehouseId?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}

export function useProductionList(query: ProductionListQuery) {
  const { scope } = useWarehouseScope();
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params[k] = v as string | number;
  return useQuery({
    queryKey: queryKeys.production.list(scope, params),
    queryFn: ({ signal }) => apiClient.get<unknown>(BASE, { signal, params }).then(toProductionPage),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useProductionDetail(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: queryKeys.production.detail(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}`, { signal }).then(toProductionDetail),
  });
}

export function useBoms(q?: string) {
  return useQuery({
    queryKey: queryKeys.production.boms(q ?? ""),
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/boms`, { signal, params: q ? { q } : undefined }).then(toBomOptions),
  });
}

export function useProductionAvailability(id: string | null, enabled = true) {
  return useQuery({
    enabled: !!id && enabled,
    queryKey: queryKeys.production.availability(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}/availability`, { signal }).then(toAvailability),
  });
}

export function usePreviewAvailability(input: { bomId: string; qtyPlanned: number; warehouseId: string } | null) {
  return useQuery({
    enabled: !!input && !!input.bomId && !!input.warehouseId && input.qtyPlanned > 0,
    queryKey: queryKeys.production.preview(input ?? {}),
    queryFn: ({ signal }) => apiClient.post<unknown>(`${BASE}/preview-availability`, input, { signal }).then(toAvailability),
  });
}

export function useVarianceReport(id: string | null, enabled = true) {
  return useQuery({
    enabled: !!id && enabled,
    queryKey: queryKeys.production.variance(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${BASE}/${id}/variance-report`, { signal }).then(toVarianceReport),
  });
}

export interface IssueMaterialsInput {
  id: string;
  lines: Array<{ itemId: string; qty: number; lotAllocations?: Array<{ lotId: string; qty: number }> }>;
  laborCost?: number;
  overheadCost?: number;
  reason?: string;
  allowOverIssue?: boolean;
  acknowledgeNegative?: boolean;
  expectedVersion?: number;
}

export interface RecordOutputInput {
  id: string;
  goodQty: number;
  wasteQty?: number;
  wasteReason?: string;
  batchNumber?: string;
  expiryDate?: string;
  expectedVersion?: number;
}

export function useProductionMutations() {
  const qc = useQueryClient();
  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.production.all });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.production.detail(id) });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["lots"] });
    qc.invalidateQueries({ queryKey: ["expiry"] });
    qc.invalidateQueries({ queryKey: ["analytics"] });
    qc.invalidateQueries({ queryKey: ["report"] });
  };

  const create = useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (input) => apiClient.post<unknown>(BASE, input, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: () => invalidate(),
  });
  const update = useMutation<MutationResult, Error, { id: string; input: Record<string, unknown> }>({
    mutationFn: ({ id, input }) => apiClient.patch<unknown>(`${BASE}/${id}`, input).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const approve = useMutation<MutationResult, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/approve`, { expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const issueMaterials = useMutation<MutationResult, Error, IssueMaterialsInput>({
    mutationFn: ({ id, ...input }) => apiClient.post<unknown>(`${BASE}/${id}/issue-materials`, input, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const recordOutput = useMutation<MutationResult, Error, RecordOutputInput>({
    mutationFn: ({ id, ...input }) => apiClient.post<unknown>(`${BASE}/${id}/record-output`, input, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const complete = useMutation<MutationResult, Error, { id: string; reason?: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/complete`, { reason, expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const close = useMutation<MutationResult, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/close`, { expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const cancel = useMutation<MutationResult, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/cancel`, { reason, expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const reverse = useMutation<MutationResult, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => apiClient.post<unknown>(`${BASE}/${id}/reverse`, { reason, expectedVersion }, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const remove = useMutation<MutationResult, Error, { id: string }>({
    mutationFn: ({ id }) => apiClient.delete<unknown>(`${BASE}/${id}`).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });

  return { create, update, approve, issueMaterials, recordOutput, complete, close, cancel, reverse, remove };
}
