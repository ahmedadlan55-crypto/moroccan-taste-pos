// ── Cash & Banking domain API adapter + React Query hooks ───────────────────
// Thin typed layer over @/shared/api. Every path/param mirrors the legacy cash
// management loaders EXACTLY. All banking endpoints are served under /api/cash
// and are admin/manager gated by the server.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

const KEY = ["cash"] as const;

// ── Summary ─────────────────────────────────────────────────────────────────
export interface CashSummary {
  cashTotal: number;
  cashBoxCount: number;
  bankTotal: number;
  bankCount: number;
  monthReceipts: number;
  monthPayments: number;
}
export function useCashSummary() {
  return useQuery({
    queryKey: [...KEY, "summary"],
    queryFn: () => apiClient.get<CashSummary>("/cash/summary"),
  });
}

// ── Cash boxes ──────────────────────────────────────────────────────────────
export interface CashBox {
  id: string;
  name: string;
  code: string;
  type: string;
  branchId: string | null;
  branchName: string;
  brandId: string | null;
  brandName: string;
  keeperUsername: string;
  currency: string;
  balance: number;
  isActive: boolean;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
}
export interface CashBoxInput {
  id?: string;
  name: string;
  code: string;
  type: string;
  keeperUsername: string;
  currency: string;
  glAccountId?: string;
  parentGlId?: string | null;
  suggestedCode?: string;
  suggestedLevel?: number | null;
}
export function useCashBoxes() {
  return useQuery({
    queryKey: [...KEY, "cash-boxes"],
    queryFn: () => apiClient.get<CashBox[]>("/cash/cash-boxes"),
  });
}
export function useSaveCashBox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CashBoxInput) =>
      apiClient.post<{ success: boolean; id?: string; error?: string }>("/cash/cash-boxes", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "cash-boxes"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}
export function useDeleteCashBox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ success: boolean; error?: string }>(`/cash/cash-boxes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "cash-boxes"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}

// ── Bank accounts ───────────────────────────────────────────────────────────
export interface BankAccount {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  currency: string;
  brandId: string | null;
  brandName: string;
  balance: number;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
}
export interface BankAccountInput {
  id?: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  currency: string;
  glAccountId?: string;
  parentGlId?: string | null;
  suggestedCode?: string;
  suggestedLevel?: number | null;
}
export function useBankAccounts() {
  return useQuery({
    queryKey: [...KEY, "bank-accounts"],
    queryFn: () => apiClient.get<BankAccount[]>("/cash/bank-accounts"),
  });
}
export function useSaveBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankAccountInput) =>
      apiClient.post<{ success: boolean; id?: string; error?: string }>("/cash/bank-accounts", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "bank-accounts"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}
export function useDeleteBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ success: boolean; error?: string }>(`/cash/bank-accounts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "bank-accounts"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}

// ── GL account tree (parent picker for a new box / bank) ────────────────────
export interface GlNode {
  id: string;
  code: string;
  nameAr: string;
  level: number;
  parentId: string | null;
  type: string;
  isLeaf: boolean;
}
export function useGlTree(root: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "gl-tree", root],
    enabled,
    staleTime: 60_000,
    queryFn: () => apiClient.get<GlNode[]>("/cash/gl-accounts-tree", { params: { root } }),
  });
}

/** Mirror of the legacy _cashOnParentChange auto-code: next sibling code + level. */
export function nextChildCode(parent: GlNode, all: GlNode[]): { code: string; level: number } {
  const level = (parent.level || 1) + 1;
  const siblings = all.filter((a) => a.parentId === parent.id);
  const codes = siblings.map((a) => String(a.code || "")).sort();
  if (codes.length === 0) {
    const code = (parent.level || 1) >= 3 ? `${parent.code}01` : `${parent.code}1`;
    return { code, level };
  }
  const last = codes[codes.length - 1];
  const suffix = last.substring(String(parent.code).length);
  const n = parseInt(suffix, 10) + 1;
  const code = parent.code + String(n).padStart(suffix.length || 1, "0");
  return { code, level };
}

// ── Receipts (سندات القبض) ──────────────────────────────────────────────────
export interface Receipt {
  id: string;
  receiptNumber: string;
  receiptDate: string;
  sourceType: string;
  sourceName: string;
  destinationType: string;
  amount: number;
  status: "draft" | "posted" | "cancelled" | string;
  createdBy: string;
  createdByName: string;
  hasManualGl: boolean;
}
export function useReceipts() {
  return useQuery({
    queryKey: [...KEY, "receipts"],
    queryFn: () => apiClient.get<Receipt[]>("/cash/receipts"),
  });
}
export function useApproveReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean; journalNumber?: string; error?: string }>(
        `/cash/receipts/${id}/approve`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "receipts"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}
export function useCancelReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean; error?: string }>(`/cash/receipts/${id}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "receipts"] }),
  });
}

// ── Payments (سندات الصرف) ──────────────────────────────────────────────────
export interface Payment {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  recipientType: string;
  recipientName: string;
  sourceType: string;
  amount: number;
  status: "draft" | "posted" | "cancelled" | string;
  createdBy: string;
  createdByName: string;
  hasManualGl: boolean;
}
export function usePayments() {
  return useQuery({
    queryKey: [...KEY, "payments"],
    queryFn: () => apiClient.get<Payment[]>("/cash/payments"),
  });
}
export function useApprovePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean; journalNumber?: string; error?: string }>(
        `/cash/payments/${id}/approve`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "payments"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}
export function useCancelPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean; error?: string }>(`/cash/payments/${id}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "payments"] }),
  });
}

// ── Transfers (التحويلات النقدية) ───────────────────────────────────────────
export interface Transfer {
  transfer_number: string;
  transfer_date: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  amount: number;
  description: string;
}
export interface TransferInput {
  transferDate: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  amount: number;
  description: string;
}
export function useTransfers() {
  return useQuery({
    queryKey: [...KEY, "transfers"],
    queryFn: () => apiClient.get<Transfer[]>("/cash/transfers"),
  });
}
export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransferInput) =>
      apiClient.post<{ success: boolean; journalNumber?: string; error?: string }>(
        "/cash/transfers",
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "transfers"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
  });
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
