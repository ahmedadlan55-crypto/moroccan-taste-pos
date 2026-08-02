// TanStack Query hooks for the production BATCH document (one document, many
// independent products). Keys are rooted at ["production", …] so the existing
// `queryKeys.production.all` invalidation in useProductionMutations refreshes
// these slices too without touching the shared key registry.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveBatch,
  cancelBatch,
  createBatch,
  fetchBatchDetail,
  fetchBatchPage,
  fetchBomOptions,
  previewBatch,
  type BomPickOption,
  type BatchDetail,
  type BatchInput,
  type BatchListQuery,
  type BatchPage,
  type BatchPreview,
  type CreatedBatch,
} from "./batchApi";

export const batchKeys = {
  all: ["production", "batch"] as const,
  list: (params: Record<string, unknown>) => ["production", "batch", "list", params] as const,
  detail: (id: string) => ["production", "batch", "detail", id] as const,
  preview: (input: unknown) => ["production", "batch", "preview", input] as const,
  boms: (q: string) => ["production", "batch", "boms", q] as const,
};

/** Recipe options for the picker. The query string is DEBOUNCED by the caller;
 *  the server filters and caps the result, and the picker pages what it gets —
 *  the catalogue is never rendered in one go. */
export function useBomOptions(q: string) {
  return useQuery<BomPickOption[]>({
    queryKey: batchKeys.boms(q),
    queryFn: ({ signal }) => fetchBomOptions(q, signal),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useBatchList(query: BatchListQuery) {
  return useQuery<BatchPage>({
    queryKey: batchKeys.list(query as Record<string, unknown>),
    queryFn: ({ signal }) => fetchBatchPage(query, signal),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useBatchDetail(id: string | null) {
  return useQuery<BatchDetail>({
    enabled: !!id,
    queryKey: batchKeys.detail(id ?? ""),
    queryFn: ({ signal }) => fetchBatchDetail(id as string, signal),
  });
}

/**
 * Consolidated material demand for a PROPOSED batch. `input` is null until
 * every row is locally complete — the endpoint refuses the whole request when
 * any line is invalid, so previewing a half-typed row would only ever produce
 * noise.
 */
export function useBatchPreview(input: BatchInput | null) {
  return useQuery<BatchPreview>({
    enabled: !!input && input.items.length > 0 && !!input.warehouseId,
    queryKey: batchKeys.preview(input),
    queryFn: ({ signal }) => previewBatch(input as BatchInput, signal),
    // The preview is derived from live stock — keep it fresh but do not thrash
    // while the user edits (the key already changes on every meaningful edit).
    staleTime: 15_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export function useBatchMutations() {
  const qc = useQueryClient();
  const invalidate = (id?: string) => {
    qc.invalidateQueries({ queryKey: ["production"] });
    if (id) qc.invalidateQueries({ queryKey: batchKeys.detail(id) });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["lots"] });
    qc.invalidateQueries({ queryKey: ["analytics"] });
  };

  const create = useMutation<CreatedBatch, Error, BatchInput>({
    mutationFn: (input) => createBatch(input),
    onSuccess: () => invalidate(),
  });
  const approve = useMutation<unknown, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) => approveBatch(id, expectedVersion),
    onSuccess: (_r, v) => invalidate(v.id),
  });
  const cancel = useMutation<unknown, Error, { id: string; reason: string; expectedVersion?: number }>({
    mutationFn: ({ id, reason, expectedVersion }) => cancelBatch(id, reason, expectedVersion),
    onSuccess: (_r, v) => invalidate(v.id),
  });

  return { create, approve, cancel };
}
