// Procurement / P2P data hooks — TanStack Query wrappers over /api/procurement.
// Lists carry filters in the key so a change aborts the in-flight request;
// mutations are explicit and never auto-retried; each mutation invalidates the
// exact slices it affects.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import type { EntityPage } from "@/shared/ui";
import {
  toPaginated, toSupplier, toOrder, toReceipt, toInvoice, toPayment, toReturn, toDashboard,
  type Supplier, type PurchaseOrder, type Receipt, type SupplierInvoice, type Payment, type PurchaseReturn,
  type ReceiptChargeInput,
} from "@/modules/inventory/lib/adapters/procurement.adapter";

export interface ListParams {
  q?: string;
  status?: string;
  supplierId?: string;
  branchId?: string;
  warehouseId?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
  dateFrom?: string;
  dateTo?: string;
  asOfDate?: string;
}
// query-key factories accept a plain record; ListParams is structurally one.
type KeyParams = Record<string, unknown>;
const kp = (p: ListParams): KeyParams => p as unknown as KeyParams;
export interface MutationResult {
  success: boolean;
  data?: { id?: string } | null;
  documentNumber?: string | null;
  status?: string | null;
  version?: number | null;
  journalIds?: string[];
  [k: string]: unknown;
}

const P = "/procurement";
function clean(params: ListParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") out[k] = v as string | number;
  return out;
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export function useProcurementDashboard() {
  return useQuery({
    queryKey: queryKeys.procurement.dashboard(),
    queryFn: ({ signal }) => apiClient.get<Record<string, unknown>>(`${P}/dashboard`, { signal }).then((r) => toDashboard((r as { data?: Record<string, unknown> }).data ?? r)),
    staleTime: 30_000,
  });
}

// ── Suppliers ─────────────────────────────────────────────────────────────
export function useSuppliers(params: ListParams) {
  return useQuery({
    queryKey: queryKeys.procurement.suppliers.list(kp(params)),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${P}/suppliers`, { signal, params: clean(params) }).then((r) => toPaginated<Supplier>(r, toSupplier)),
    staleTime: 20_000,
  });
}
export function useSupplier(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: queryKeys.procurement.suppliers.detail(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<{ data: Record<string, unknown> }>(`${P}/suppliers/${id}`, { signal }).then((r) => r.data),
  });
}
export function useSupplierStatement(id: string | null, params: ListParams) {
  return useQuery({
    enabled: !!id,
    queryKey: queryKeys.procurement.suppliers.statement(id ?? "", kp(params)),
    queryFn: ({ signal }) => apiClient.get<{ data: unknown[]; closingBalance: number }>(`${P}/suppliers/${id}/statement`, { signal, params: clean(params) }),
  });
}
export function useSupplierAging(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: queryKeys.procurement.suppliers.aging(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<{ data: { buckets: Record<string, number>; total: number } }>(`${P}/suppliers/${id}/aging`, { signal }).then((r) => r.data),
  });
}
/** Combobox fetcher — first page on open, then server search. */
export function supplierFetcher({ q, page, signal }: { q: string; page: number; signal?: AbortSignal }): Promise<EntityPage<Supplier>> {
  return apiClient.get<{ data: Record<string, unknown>[]; pagination: { total: number; totalPages: number } }>(
    `${P}/suppliers/search`, { signal, params: { q, page } },
  ).then((r) => ({
    items: (r.data ?? []).map(toSupplier),
    nextPage: page < (r.pagination?.totalPages ?? 1) ? page + 1 : null,
    total: r.pagination?.total ?? (r.data ?? []).length,
  }));
}

// ── generic list/detail factories ──────────────────────────────────────────
function useList<T>(keyFn: (p: KeyParams) => readonly unknown[], path: string, map: (r: Record<string, unknown>) => T, params: ListParams) {
  return useQuery({
    queryKey: keyFn(kp(params)),
    queryFn: ({ signal }) => apiClient.get<unknown>(`${P}/${path}`, { signal, params: clean(params) }).then((r) => toPaginated<T>(r, map)),
    staleTime: 15_000,
  });
}
function useDetail(keyFn: (id: string) => readonly unknown[], path: string, id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: keyFn(id ?? ""),
    queryFn: ({ signal }) => apiClient.get<{ data: Record<string, unknown> }>(`${P}/${path}/${id}`, { signal }).then((r) => r.data),
  });
}

export const useOrders = (p: ListParams) => useList<PurchaseOrder>(queryKeys.procurement.orders.list, "orders", toOrder, p);
export const useOrder = (id: string | null) => useDetail(queryKeys.procurement.orders.detail, "orders", id);
export const useReceipts = (p: ListParams) => useList<Receipt>(queryKeys.procurement.receipts.list, "receipts", toReceipt, p);
export const useReceipt = (id: string | null) => useDetail(queryKeys.procurement.receipts.detail, "receipts", id);
export const useInvoices = (p: ListParams) => useList<SupplierInvoice>(queryKeys.procurement.invoices.list, "invoices", toInvoice, p);
export const useInvoice = (id: string | null) => useDetail(queryKeys.procurement.invoices.detail, "invoices", id);
export const usePayments = (p: ListParams) => useList<Payment>(queryKeys.procurement.payments.list, "payments", toPayment, p);
export const usePayment = (id: string | null) => useDetail(queryKeys.procurement.payments.detail, "payments", id);
export const useReturns = (p: ListParams) => useList<PurchaseReturn>(queryKeys.procurement.returns.list, "returns", toReturn, p);
export const useReturn = (id: string | null) => useDetail(queryKeys.procurement.returns.detail, "returns", id);

export interface TimelineEvent { id: string; action: string; from_status: string | null; to_status: string | null; actor: string | null; gl_journal_id: string | null; created_at: string }
export function useTimeline(entity: string, id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ["procurement", entity, "timeline", id ?? ""] as const,
    queryFn: ({ signal }) => apiClient.get<{ data: TimelineEvent[] }>(`${P}/${entity}/${id}/timeline`, { signal }).then((r) => r.data ?? []),
    staleTime: 10_000,
  });
}

export interface GLEntry { account_code: string; account_name: string; debit: number; credit: number; description: string }
export interface GLJournal { journal_number: string; journal_date: string; total_debit: number; total_credit: number; entries: GLEntry[] }
export function useGLJournal(journalId: string | null) {
  return useQuery({
    enabled: !!journalId,
    queryKey: ["procurement", "gl", journalId ?? ""] as const,
    queryFn: ({ signal }) => apiClient.get<{ data: GLJournal }>(`${P}/gl/${journalId}`, { signal }).then((r) => r.data),
  });
}

export function useProcurementReport(type: string, params: ListParams, enabled = true) {
  return useQuery({
    enabled,
    queryKey: queryKeys.procurement.report(type, kp(params)),
    queryFn: ({ signal }) => apiClient.get<{ data: unknown }>(`${P}/reports/${type}`, { signal, params: clean(params) }),
    staleTime: 30_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────
function useInvalidate() {
  const qc = useQueryClient();
  return (scope: readonly unknown[], id?: string, detailFn?: (id: string) => readonly unknown[]) => {
    qc.invalidateQueries({ queryKey: scope });
    qc.invalidateQueries({ queryKey: queryKeys.procurement.dashboard() });
    if (id && detailFn) qc.invalidateQueries({ queryKey: detailFn(id) });
  };
}

export function useCreateSupplier() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (body) => apiClient.post<MutationResult>(`${P}/suppliers`, body),
    onSuccess: () => inv(queryKeys.procurement.suppliers.all),
  });
}
export function useUpdateSupplier() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; body: Record<string, unknown> }>({
    mutationFn: ({ id, body }) => apiClient.patch<MutationResult>(`${P}/suppliers/${id}`, body),
    onSuccess: (_r, v) => inv(queryKeys.procurement.suppliers.all, v.id, queryKeys.procurement.suppliers.detail),
  });
}

// ── Supplier beneficiaries (المستفيدون) — the supplier's OWN bank details for
// direct-transfer payment. No GL linkage (unlike bank_accounts, the company's
// own accounts under 1102) — just payee info stored per supplier.
export interface SupplierBeneficiary {
  id: string;
  bankName: string;
  accountName: string | null;
  accountNumber: string | null;
  iban: string | null;
  isPrimary: boolean;
}
function beneficiariesKey(supplierId: string) {
  return ["procurement", "suppliers", "beneficiaries", supplierId] as const;
}
export function useSupplierBeneficiaries(supplierId: string | null) {
  return useQuery({
    enabled: !!supplierId,
    queryKey: beneficiariesKey(supplierId ?? ""),
    queryFn: ({ signal }) =>
      apiClient.get<{ data: SupplierBeneficiary[] }>(`${P}/suppliers/${supplierId}/beneficiaries`, { signal }).then((r) => r.data ?? []),
  });
}
export function useSaveSupplierBeneficiary() {
  const qc = useQueryClient();
  return useMutation<MutationResult, Error, { supplierId: string; body: Record<string, unknown> }>({
    mutationFn: ({ supplierId, body }) => apiClient.post<MutationResult>(`${P}/suppliers/${supplierId}/beneficiaries`, body),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: beneficiariesKey(v.supplierId) }),
  });
}
export function useDeleteSupplierBeneficiary() {
  const qc = useQueryClient();
  return useMutation<MutationResult, Error, { supplierId: string; beneficiaryId: string }>({
    mutationFn: ({ supplierId, beneficiaryId }) =>
      apiClient.delete<MutationResult>(`${P}/suppliers/${supplierId}/beneficiaries/${beneficiaryId}`),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: beneficiariesKey(v.supplierId) }),
  });
}
export function useCreateOrder() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (body) => apiClient.post<MutationResult>(`${P}/orders`, body),
    onSuccess: () => inv(queryKeys.procurement.orders.all),
  });
}
export function useCreateReceipt() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (body) => apiClient.post<MutationResult>(`${P}/receipts`, body),
    onSuccess: () => inv(queryKeys.procurement.receipts.all),
  });
}
/**
 * PUT /receipts/:id/charges — replaces the WHOLE charge set of a draft or
 * approved receipt. A posted/reversed/cancelled receipt answers 409
 * RECEIPT_CHARGES_LOCKED: the landed values already entered inventory and the
 * ledger, so the server refuses and the UI shows the reason instead of the
 * editor. Invalidates the receipt list AND the detail — the detail is where the
 * landed figures are read back from.
 */
export function useUpdateReceiptCharges() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, { id: string; charges: ReceiptChargeInput[] }>({
    mutationFn: ({ id, charges }) => apiClient.put<MutationResult>(`${P}/receipts/${id}/charges`, { charges }),
    onSuccess: (_r, v) => inv(queryKeys.procurement.receipts.all, v.id, queryKeys.procurement.receipts.detail),
  });
}
export function useCreateInvoice() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (body) => apiClient.post<MutationResult>(`${P}/invoices`, body),
    onSuccess: () => inv(queryKeys.procurement.invoices.all),
  });
}
export function useCreatePayment() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (body) => apiClient.post<MutationResult>(`${P}/payments`, body),
    onSuccess: () => inv(queryKeys.procurement.payments.all),
  });
}
export function useCreateReturn() {
  const inv = useInvalidate();
  return useMutation<MutationResult, Error, Record<string, unknown>>({
    mutationFn: (body) => apiClient.post<MutationResult>(`${P}/returns`, body),
    onSuccess: () => inv(queryKeys.procurement.returns.all),
  });
}

export interface ActionInput { id: string; action: string; body?: Record<string, unknown>; expectedVersion?: number }
/** Generic document transition (submit/approve/post/pay/…) for any entity. */
export function useDocAction(entity: "orders" | "receipts" | "invoices" | "payments" | "returns") {
  const inv = useInvalidate();
  const scope = queryKeys.procurement[entity].all;
  const detailFn = (queryKeys.procurement[entity] as { detail?: (id: string) => readonly unknown[] }).detail;
  return useMutation<MutationResult, Error, ActionInput>({
    mutationFn: ({ id, action, body, expectedVersion }) =>
      apiClient.post<MutationResult>(`${P}/${entity}/${id}/${action}`, { ...(body ?? {}), expectedVersion }),
    onSuccess: (_r, v) => inv(scope, v.id, detailFn),
  });
}
