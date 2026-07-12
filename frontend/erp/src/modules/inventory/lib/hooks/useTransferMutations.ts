// Phase 3A — transfer lifecycle mutations (the FIRST mutations in the SPA).
//
// • Every action posts to the hardened /api/erp/stock-issues/* endpoints.
// • create/issue/receive carry an Idempotency-Key so a double-submit / retry
//   never produces a duplicate draft or a double stock move.
// • expectedVersion is sent for optimistic concurrency → a stale document
//   surfaces as an ApiError of kind "conflict" (409 VERSION_CONFLICT), which
//   the UI renders as a "refresh & retry" state.
// • onSuccess invalidates the list (KPIs refresh) + the specific detail so the
//   UI never shows stale data after an action. Mutations never auto-retry
//   (providers.tsx sets mutations.retry = false).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { toMutationResult, type MutationResult } from "@/modules/inventory/lib/adapters/transfer.adapter";
import type {
  CreateTransferDraftInput,
  ReceiveTransferInput,
  ReverseTransferInput,
  CancelTransferInput,
  UpdateTransferDraftInput,
} from "@/modules/inventory/lib/schemas/transfer.schema";

const BASE = "/erp/stock-issues";

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* jsdom / older runtimes */
  }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function useInvalidate() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.transfers.all });
    if (id) qc.invalidateQueries({ queryKey: queryKeys.transfers.detail(id) });
  };
}

export function useCreateDraft() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, CreateTransferDraftInput>({
    mutationFn: (input) =>
      apiClient.post<unknown>(BASE, input, { headers: { "Idempotency-Key": uid() } }).then(toMutationResult),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteDraft() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string }>({
    mutationFn: ({ id }) => apiClient.delete<unknown>(`${BASE}/${id}`).then(toMutationResult),
    onSuccess: () => invalidate(),
  });
}

// Phase 3A.1 — real in-place draft edit. PATCHes the SAME document (keeps its
// number + URL); never delete+recreate. expectedVersion drives 409 conflicts.
export function useUpdateDraft() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; input: UpdateTransferDraftInput }>({
    mutationFn: ({ id, input }) => apiClient.patch<unknown>(`${BASE}/${id}`, input).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useApproveTransfer() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) =>
      apiClient.post<unknown>(`${BASE}/${id}/approve`, { expectedVersion }).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useIssueTransfer() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; expectedVersion?: number }>({
    mutationFn: ({ id, expectedVersion }) =>
      apiClient
        .post<unknown>(`${BASE}/${id}/issue`, { expectedVersion }, { headers: { "Idempotency-Key": uid() } })
        .then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useReceiveTransfer() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; input: ReceiveTransferInput }>({
    mutationFn: ({ id, input }) =>
      apiClient
        .post<unknown>(`${BASE}/${id}/receive`, input, { headers: { "Idempotency-Key": uid() } })
        .then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useCancelTransfer() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; input: CancelTransferInput }>({
    mutationFn: ({ id, input }) => apiClient.post<unknown>(`${BASE}/${id}/cancel`, input).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useReverseTransfer() {
  const invalidate = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; input: ReverseTransferInput }>({
    mutationFn: ({ id, input }) => apiClient.post<unknown>(`${BASE}/${id}/reverse`, input).then(toMutationResult),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}
