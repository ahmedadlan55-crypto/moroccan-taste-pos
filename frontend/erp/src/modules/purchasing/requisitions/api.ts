// ── Purchase Requisitions — API adapter + React Query hooks ─────────────────
// Thin typed layer over @/shared/api for the /api/procurement/requisitions
// subsystem. Mirrors the hook style of modules/banking/api.ts. Every path/param
// matches routes/procurement/requisitions.js exactly. The backend enforces RBAC
// (purchasing.requisitions.manage / .approve) and recomputes all money.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { EntityFetcher } from "@/shared/ui";
// Tier A.2 corrective gate — todayISO() moved to @/shared/lib/dates
// (local-time components, not toISOString()'s UTC calendar date);
// re-exported here so every existing `from "../api"` import keeps working.
export { todayISO } from "@/shared/lib";

const KEY = ["procurement", "requisitions"] as const;

export type RequisitionStatus = "draft" | "submitted" | "approved" | "rejected" | "converted";

export interface RequisitionRow {
  id: string;
  req_number: string;
  branch_id: string | null;
  warehouse_id: string | null;
  requested_by: string | null;
  status: RequisitionStatus;
  version: number;
  needed_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  po_id: string | null;
  line_count: number;
  estimated_total: number;
}

export interface RequisitionLine {
  id: string;
  requisition_id: string;
  item_id: string | null;
  item_name: string | null;
  quantity: number;
  unit: string | null;
  estimated_price: number;
  notes: string | null;
}

export interface RequisitionDetail extends RequisitionRow {
  lines: RequisitionLine[];
  estimatedTotal: number;
  submitted_by?: string | null;
  rejected_by?: string | null;
  reject_reason?: string | null;
}

export interface LineInput {
  itemId: string;
  itemName?: string;
  quantity: number;
  unit?: string | null;
  estimatedPrice: number;
  notes?: string | null;
}

export interface RequisitionInput {
  branchId?: string | null;
  warehouseId?: string | null;
  requestedBy?: string | null;
  neededDate?: string | null;
  notes?: string | null;
  lines: LineInput[];
}

export interface ListParams {
  status?: string;
  branchId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

interface ListResponse {
  data: RequisitionRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// The shared success envelope (lib/procurement/errors.ok / sendData / sendOk).
interface MutationEnvelope {
  success: boolean;
  data?: { id?: string; poId?: string; deleted?: boolean } | null;
  documentNumber?: string | null;
  status?: string | null;
  version?: number | null;
}

// ── queries ──────────────────────────────────────────────────────────────────
export function useRequisitions(params: ListParams) {
  return useQuery({
    queryKey: [...KEY, "list", params],
    queryFn: () =>
      apiClient.get<ListResponse>("/procurement/requisitions", {
        params: {
          status: params.status || undefined,
          branchId: params.branchId || undefined,
          q: params.q || undefined,
          page: params.page,
          pageSize: params.pageSize,
        },
      }),
  });
}

export function useRequisition(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "detail", id],
    enabled: !!id,
    queryFn: () =>
      apiClient
        .get<{ data: RequisitionDetail }>(`/procurement/requisitions/${id}`)
        .then((r) => r.data),
  });
}

// ── mutations ────────────────────────────────────────────────────────────────
function useInvalidate() {
  const qc = useQueryClient();
  return (id?: string | null) => {
    qc.invalidateQueries({ queryKey: [...KEY, "list"] });
    if (id) qc.invalidateQueries({ queryKey: [...KEY, "detail", id] });
  };
}

export function useCreateRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RequisitionInput) =>
      apiClient.post<MutationEnvelope>("/procurement/requisitions", input),
    onSuccess: (r) => invalidate(r?.data?.id),
  });
}

export function useUpdateRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; input: RequisitionInput }) =>
      apiClient.put<MutationEnvelope>(`/procurement/requisitions/${v.id}`, v.input),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useSubmitRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<MutationEnvelope>(`/procurement/requisitions/${id}/submit`, {}),
    onSuccess: (_r, id) => invalidate(id),
  });
}

export function useApproveRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<MutationEnvelope>(`/procurement/requisitions/${id}/approve`, {}),
    onSuccess: (_r, id) => invalidate(id),
  });
}

export function useRejectRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      apiClient.post<MutationEnvelope>(`/procurement/requisitions/${v.id}/reject`, { reason: v.reason }),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useConvertRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; supplierId: string }) =>
      apiClient.post<MutationEnvelope>(`/procurement/requisitions/${v.id}/convert-to-po`, {
        supplierId: v.supplierId,
      }),
    onSuccess: (_r, v) => invalidate(v.id),
  });
}

export function useDeleteRequisition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<MutationEnvelope>(`/procurement/requisitions/${id}`),
    onSuccess: () => invalidate(),
  });
}

// ── entity pickers (SearchableEntityCombobox fetchers) ──────────────────────
export interface ItemHit {
  id: string;
  name: string;
  sku: string;
  baseUnit?: { code: string; name: string };
}
export const itemFetcher: EntityFetcher<ItemHit> = ({ q, page, signal }) =>
  apiClient
    .get<{ data: ItemHit[]; pagination?: { totalPages: number; total: number } }>(
      "/inventory/v2/item-search",
      { signal, params: { q, page } },
    )
    .then((r) => ({
      items: r.data ?? [],
      nextPage: page < (r.pagination?.totalPages ?? 1) ? page + 1 : null,
      total: r.pagination?.total ?? (r.data ?? []).length,
    }));

export interface SupplierHit {
  id: string;
  name: string;
  name_en?: string | null;
  vat_number?: string | null;
}
export const supplierFetcher: EntityFetcher<SupplierHit> = ({ q, page, signal }) =>
  apiClient
    .get<{ data?: SupplierHit[]; pagination?: { page: number; totalPages: number; total: number } }>(
      "/procurement/suppliers/search",
      { signal, params: { q, page, pageSize: 20 } },
    )
    .then((r) => {
      const data = Array.isArray(r?.data) ? r.data : [];
      const pg = r?.pagination;
      const nextPage = pg && pg.page < pg.totalPages ? pg.page + 1 : null;
      return { items: data, nextPage, total: pg?.total ?? data.length };
    });
