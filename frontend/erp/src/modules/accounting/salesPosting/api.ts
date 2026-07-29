// ── «ترحيل المبيعات» — typed adapter over /api/erp/sales-posting ───────────
//
// The server owns all the arithmetic. This layer only fetches and renders; it
// never re-derives a total, because a second implementation of the aggregation
// is exactly how a preview stops matching what gets posted.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

export type Granularity = "daily" | "monthly" | "invoice";

export const GRANULARITIES: Granularity[] = ["daily", "monthly", "invoice"];

export interface QueueSource {
  id: number;
  type: "sale" | "return" | "void";
  sourceId: string;
  invoiceNumber: string | null;
  gross: number;
}

export interface BatchLeg {
  accountCode: string;
  debit: number;
  credit: number;
  warehouseId: string | null;
}

export interface PlannedBatch {
  key: string;
  label: string;
  granularity: Granularity;
  brandId: string | null;
  branchId: string | null;
  journalDate: string;
  itemCount: number;
  salesCount: number;
  returnCount: number;
  net: number;
  tax: number;
  gross: number;
  cogs: number;
  queueIds: number[];
  sources: QueueSource[];
  legs: BatchLeg[];
  balanced: boolean;
  warnings: string[];
  postable: boolean;
}

export interface PendingResponse {
  success: boolean;
  granularity: Granularity;
  batches: PlannedBatch[];
  totals: { batches: number; items: number; net: number; tax: number; gross: number; blocked: number };
}

export interface PostedBatch {
  id: string;
  granularity: Granularity;
  bucket_key: string;
  journal_date: string;
  journal_id: string | null;
  journal_number: string | null;
  status: "posted" | "reversed";
  item_count: number;
  net_amount: number;
  tax_amount: number;
  gross_amount: number;
  cogs_amount: number;
  posted_by: string | null;
  posted_at: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reverse_reason: string | null;
}

export interface HealthProblem {
  severity: "critical" | "blocking" | "warning";
  code: string;
  message: string;
  count?: number;
  bucket?: string;
  account?: string;
}

export interface Filters {
  from?: string;
  to?: string;
  brandId?: string;
  branchId?: string;
}

const clean = (f: Filters) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== ""));

export function usePendingBatches(granularity: Granularity, filters: Filters) {
  return useQuery({
    queryKey: ["sales-posting", "pending", granularity, filters],
    queryFn: ({ signal }) =>
      apiClient.get<PendingResponse>("/erp/sales-posting/pending", {
        params: { granularity, ...clean(filters) },
        signal,
      }),
  });
}

export function usePostedBatches(filters: Filters) {
  return useQuery({
    queryKey: ["sales-posting", "batches", filters],
    queryFn: ({ signal }) =>
      apiClient.get<{ success: boolean; batches: PostedBatch[] }>("/erp/sales-posting/batches", {
        params: clean(filters),
        signal,
      }),
  });
}

export function useBatchDetail(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ["sales-posting", "batch", id],
    queryFn: ({ signal }) =>
      apiClient.get<{ success: boolean; batch: PostedBatch; legs: BatchLeg[]; items: unknown[] }>(
        `/erp/sales-posting/batches/${encodeURIComponent(id!)}`, { signal }),
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["sales-posting", "health"],
    queryFn: ({ signal }) =>
      apiClient.get<{ success: boolean; healthy: boolean; problems: HealthProblem[]; accounts: Record<string, string> }>(
        "/erp/sales-posting/health", { signal }),
  });
}

export function usePostBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { granularity: Granularity; bucketKey: string } & Filters) =>
      apiClient.post<{ success: boolean; batchId: string; journalNumber?: string }>(
        "/erp/sales-posting/post", input),
    // Everything on this screen derives from the queue, so a post invalidates
    // all of it — pending, batches and health alike.
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sales-posting"] }); },
  });
}

export function useReverseBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { batchId: string; reason: string }) =>
      apiClient.post<{ success: boolean; requeued: number }>(
        `/erp/sales-posting/batches/${encodeURIComponent(input.batchId)}/reverse`,
        { reason: input.reason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sales-posting"] }); },
  });
}
