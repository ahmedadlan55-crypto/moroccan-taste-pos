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
  /** Resolved names — the list used to show ids, which nobody recognises. */
  branch_name?: string | null;
  warehouse_name?: string | null;
  requested_by: string | null;
  status: RequisitionStatus;
  version: number;
  needed_date: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  submitted_by?: string | null;
  submitted_at?: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  reject_reason?: string | null;
  po_id: string | null;
  /** The PO's own number and state, so the row can say "PO-0042 · sent"
   *  instead of an opaque id. */
  po_number?: string | null;
  po_status?: string | null;
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
  warehouseId?: string;
  /** The requester's own view: only requests this user filed. */
  mine?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

interface ListResponse {
  data: RequisitionRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// The shared success envelope (lib/procurement/errors.ok / sendData / sendOk).
export interface MutationEnvelope {
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
          warehouseId: params.warehouseId || undefined,
          mine: params.mine ? "1" : undefined,
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

/** Per-line price/VAT overrides keyed by requisition line id. The server
 *  accepted these from day one; the screen simply never offered them. */
export type ConvertLines = Record<string, { unitPrice?: number; vatRate?: number }>;

export function useConvertRequisition() {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; supplierId: string; lines?: ConvertLines }) =>
      apiClient.post<MutationEnvelope>(`/procurement/requisitions/${v.id}/convert-to-po`, {
        supplierId: v.supplierId,
        ...(v.lines && Object.keys(v.lines).length ? { lines: v.lines } : {}),
      }),
    onSuccess: (_r, v) => {
      invalidate(v.id);
      // A new PO now exists; the orders list must not keep showing the old one.
      qc.invalidateQueries({ queryKey: ["procurement", "orders"] });
    },
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

// ── Branch shortage requests — the cashier's «طلبات النواقص» ────────────────
// A SEPARATE subsystem from purchase requisitions: routes/inventory.js
// /shortage-requests over table shortage_requests, filed from the POS
// (RequisitionsDialog). Its lifecycle is pending → approved → converted →
// partially/fully received → closed, or rejected. Until these hooks existed no
// back-office screen read that table: a manager could not see, approve or
// convert what a branch asked for. Paths and params mirror that router; its
// mutations answer HTTP 200 with { success:false, error } on refusal, so every
// mutation here turns that into a thrown error instead of a silent "done".
export type BranchRequestStatus =
  | "pending" | "approved" | "converted" | "rejected" | "partially_received" | "fully_received" | "closed";

export interface BranchRequestRow {
  id: string;
  requestNumber: string;
  requestDate: string;
  username: string;
  notes: string | null;
  status: BranchRequestStatus;
  supplyMode: string | null;
  totalItems: number;
  approvedBy: string | null;
  approvedAt: string | null;
  poId: string | null;
  poNumber: string | null;
  brandId: string;
  brandName: string;
  branchId: string;
  branchName: string;
  warehouseId: string;
  warehouseName: string;
}
export interface BranchRequestItem {
  id: string;
  invItemId: string;
  invItemName: string;
  unit: string;
  currentQty: number;
  minQty: number;
  requestedQty: number;
  unitPrice: number;
}
export interface BranchRequestDetail extends BranchRequestRow {
  items: BranchRequestItem[];
}

const BR_KEY = ["inventory", "shortage-requests"] as const;
const brNum = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const brStr = (v: unknown): string => (v == null ? "" : String(v));

export function toBranchRequestRow(r: Record<string, unknown>): BranchRequestRow {
  return {
    id: brStr(r.id),
    requestNumber: brStr(r.requestNumber),
    requestDate: brStr(r.requestDate),
    username: brStr(r.username),
    notes: r.notes == null ? null : String(r.notes),
    status: (brStr(r.status) || "pending") as BranchRequestStatus,
    supplyMode: r.supplyMode == null ? null : String(r.supplyMode),
    totalItems: brNum(r.totalItems),
    approvedBy: r.approvedBy ? String(r.approvedBy) : null,
    approvedAt: r.approvedAt ? String(r.approvedAt) : null,
    poId: r.poId ? String(r.poId) : null,
    poNumber: r.poNumber ? String(r.poNumber) : null,
    brandId: brStr(r.brandId),
    brandName: brStr(r.brandName),
    branchId: brStr(r.branchId),
    branchName: brStr(r.branchName),
    warehouseId: brStr(r.warehouseId),
    warehouseName: brStr(r.warehouseName),
  };
}
export function toBranchRequestDetail(r: Record<string, unknown>): BranchRequestDetail {
  const items = Array.isArray(r.items) ? (r.items as Record<string, unknown>[]) : [];
  return {
    ...toBranchRequestRow(r),
    items: items.map((i) => ({
      id: brStr(i.id),
      invItemId: brStr(i.invItemId),
      invItemName: brStr(i.invItemName),
      unit: brStr(i.unit),
      currentQty: brNum(i.currentQty),
      minQty: brNum(i.minQty),
      requestedQty: brNum(i.requestedQty),
      unitPrice: brNum(i.unitPrice),
    })),
  };
}

/** The router's refusal shape is HTTP 200 + { success:false, error }. */
function brAssertOk<T extends { success?: boolean; error?: string; code?: string }>(r: T): T {
  if (r && r.success === false) {
    const e = new Error(r.error || r.code || "request failed") as Error & { code?: string };
    e.code = r.code;
    throw e;
  }
  return r;
}

export function useBranchRequests(params: { status?: string; branchId?: string }) {
  return useQuery({
    queryKey: [...BR_KEY, "list", params],
    queryFn: () =>
      apiClient
        .get<Record<string, unknown>[]>("/inventory/shortage-requests", {
          params: { status: params.status || undefined, branchId: params.branchId || undefined },
        })
        .then((rows) => (Array.isArray(rows) ? rows : []).map(toBranchRequestRow)),
  });
}

export function useBranchRequest(id: string | null) {
  return useQuery({
    queryKey: [...BR_KEY, "detail", id],
    enabled: !!id,
    queryFn: () =>
      apiClient
        .get<Record<string, unknown> & { error?: string }>(`/inventory/shortage-requests/${encodeURIComponent(id as string)}`)
        .then((r) => {
          // Not-found / denied come back as HTTP 200 + { error } here.
          if (!r || r.error) throw new Error(r?.error || "not found");
          return toBranchRequestDetail(r);
        }),
  });
}

function useInvalidateBranchRequests() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...BR_KEY] });
    // Approve/convert change what the purchasing dashboard and the orders list show.
    void qc.invalidateQueries({ queryKey: ["procurement"] });
  };
}

export function useApproveBranchRequest() {
  const invalidate = useInvalidateBranchRequests();
  return useMutation({
    mutationFn: (v: { id: string; supplyMode?: string }) =>
      apiClient
        .post<{ success: boolean; error?: string }>(
          `/inventory/shortage-requests/${encodeURIComponent(v.id)}/approve`,
          v.supplyMode ? { supplyMode: v.supplyMode } : {},
        )
        .then(brAssertOk),
    onSuccess: () => invalidate(),
  });
}

export function useRejectBranchRequest() {
  const invalidate = useInvalidateBranchRequests();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      apiClient
        .post<{ success: boolean; error?: string }>(`/inventory/shortage-requests/${encodeURIComponent(v.id)}/reject`, { reason: v.reason })
        .then(brAssertOk),
    onSuccess: () => invalidate(),
  });
}

export interface ConvertBranchRequestResult { success: boolean; poId?: string; poNumber?: string; error?: string; code?: string }
export function useConvertBranchRequest() {
  const invalidate = useInvalidateBranchRequests();
  return useMutation({
    mutationFn: (v: { id: string; supplierId: string; supplierName: string; warehouseId?: string }) =>
      apiClient
        .post<ConvertBranchRequestResult>(`/inventory/shortage-requests/${encodeURIComponent(v.id)}/convert-to-po`, {
          supplierId: v.supplierId,
          supplierName: v.supplierName,
          ...(v.warehouseId ? { warehouseId: v.warehouseId } : {}),
        })
        .then(brAssertOk),
    onSuccess: () => invalidate(),
  });
}

