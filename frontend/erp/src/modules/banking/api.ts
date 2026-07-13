// ── Cash & Banking domain API adapter + React Query hooks ───────────────────
// Thin typed layer over @/shared/api. Every path/param mirrors the legacy cash
// management loaders EXACTLY. All banking endpoints are served under /api/cash
// and are admin/manager gated by the server.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { EntityFetcher, EntityPage } from "@/shared/ui";

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
// ── Voucher draft creation ──────────────────────────────────────────────────
// Optional bookkeeper-controlled journal (overrides the auto-routed contra).
// Server validates it balances AND equals `amount`; we validate the same
// client-side before submit.
export interface ManualGlLine {
  accountId: string;
  debit: number;
  credit: number;
  description?: string;
}

// POST /cash/receipts body — mirrors the route exactly. Persists a DRAFT.
export interface ReceiptInput {
  receiptDate: string;
  amount: number;
  destinationType: "cash" | "bank";
  destinationId: string;
  sourceType: string; // customer | employee | rent | sales | other
  sourceId?: string | null;
  sourceName?: string;
  reference?: string;
  description?: string;
  brandId?: string | null;
  branchId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  manualGlLines?: ManualGlLine[];
}
export function useCreateReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReceiptInput) =>
      apiClient.post<{ success: boolean; id?: string; number?: string; error?: string }>(
        "/cash/receipts",
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "receipts"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
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
// POST /cash/payments body — mirrors the route exactly. Persists a DRAFT.
export interface PaymentInput {
  paymentDate: string;
  amount: number;
  sourceType: "cash" | "bank";
  sourceId: string;
  recipientType: string; // supplier | employee | expense | other
  recipientId?: string | null;
  recipientName?: string;
  expenseAccountId?: string | null;
  reference?: string;
  description?: string;
  brandId?: string | null;
  branchId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  manualGlLines?: ManualGlLine[];
}
export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PaymentInput) =>
      apiClient.post<{ success: boolean; id?: string; number?: string; error?: string }>(
        "/cash/payments",
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "payments"] });
      qc.invalidateQueries({ queryKey: [...KEY, "summary"] });
    },
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

// ════════════════════════════════════════════════════════════════════════════
// Voucher form lookups — dimensions, parties, and the COA (manual GL / expense)
// ════════════════════════════════════════════════════════════════════════════

// ── Header dimensions (optional) — reuse the same erp endpoints the accounting
//    screens read; the voucher header carries brand/branch/cost-center. ────────
export interface DimOption {
  id: string;
  label: string;
}
function mapDimOptions(
  rows: Array<Record<string, unknown>>,
  opts: { withCode?: boolean; activeOnly?: boolean } = {},
): DimOption[] {
  return (rows ?? [])
    .filter((r) => (opts.activeOnly ? r.isActive !== false : true))
    .map((r) => {
      const name = String(r.nameAr ?? r.name ?? r.name_ar ?? r.id ?? "");
      const code = String(r.code ?? "");
      return { id: String(r.id ?? ""), label: opts.withCode && code ? `${code} — ${name}` : name };
    })
    .filter((o) => o.id);
}
export function useBrandDims() {
  return useQuery({
    queryKey: [...KEY, "dim-brands"],
    staleTime: 300_000,
    queryFn: async () =>
      mapDimOptions(await apiClient.get<Array<Record<string, unknown>>>("/erp/brands-stats")),
  });
}
export function useBranchDims() {
  return useQuery({
    queryKey: [...KEY, "dim-branches"],
    staleTime: 300_000,
    queryFn: async () =>
      mapDimOptions(await apiClient.get<Array<Record<string, unknown>>>("/erp/branches-full")),
  });
}
export function useCostCenterDims() {
  return useQuery({
    queryKey: [...KEY, "dim-cost-centers"],
    staleTime: 300_000,
    queryFn: async () =>
      mapDimOptions(await apiClient.get<Array<Record<string, unknown>>>("/erp/cost-centers"), {
        withCode: true,
        activeOnly: true,
      }),
  });
}

// ── Party pickers — server-side searchable customer / supplier lists, shaped
//    for SearchableEntityCombobox. ─────────────────────────────────────────────
export interface PartyHit {
  id: string;
  name: string;
  phone?: string | null;
}
export const customerFetcher: EntityFetcher<PartyHit> = ({ q, signal }) =>
  apiClient
    .get<PartyHit[]>("/erp/customers/search", { signal, params: { q } })
    .then((rows) => ({
      items: Array.isArray(rows) ? rows : [],
      nextPage: null,
      total: Array.isArray(rows) ? rows.length : 0,
    }));
export const supplierFetcher: EntityFetcher<PartyHit> = ({ q, page, signal }) =>
  apiClient
    .get<{ data?: PartyHit[]; pagination?: { page: number; totalPages: number; total: number } }>(
      "/erp/suppliers/search",
      { signal, params: { q, page, pageSize: 20 } },
    )
    .then((r) => {
      const data = Array.isArray(r?.data) ? r.data : [];
      const pg = r?.pagination;
      const nextPage = pg && pg.page < pg.totalPages ? pg.page + 1 : null;
      return { items: data, nextPage, total: pg?.total ?? data.length };
    });

// ── COA accounts for the OPTIONAL manual-GL editor / expense-account picker.
//    /cash/gl-accounts-tree returns a subtree per root; merge the standard roots
//    into one flat, de-duped chart and flag postable leaves (accounts that are
//    not a parent of any other account). ───────────────────────────────────────
export interface CoaAccount {
  id: string;
  code: string;
  nameAr: string;
  isLeaf: boolean;
}
const COA_ROOTS = ["1", "2", "3", "4", "5"] as const;
export function useCoaAccounts(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "coa-accounts"],
    enabled,
    staleTime: 300_000,
    queryFn: async () => {
      const chunks = await Promise.all(
        COA_ROOTS.map((root) =>
          apiClient
            .get<GlNode[]>("/cash/gl-accounts-tree", { params: { root } })
            .catch(() => [] as GlNode[]),
        ),
      );
      const byId = new Map<string, GlNode>();
      for (const rows of chunks) for (const n of rows ?? []) if (!byId.has(n.id)) byId.set(n.id, n);
      const all = [...byId.values()];
      const parentIds = new Set(all.map((n) => n.parentId).filter(Boolean) as string[]);
      return all
        .map((n) => ({ id: n.id, code: n.code, nameAr: n.nameAr, isLeaf: !parentIds.has(n.id) }))
        .sort((a, b) => a.code.localeCompare(b.code));
    },
  });
}
// In-memory fetcher over the loaded chart → drives a SearchableEntityCombobox
// (instant client-side filter, no per-keystroke network calls).
export function makeCoaFetcher(accounts: CoaAccount[]): EntityFetcher<CoaAccount> {
  return ({ q }) => {
    const needle = q.trim().toLowerCase();
    const items = needle
      ? accounts.filter((a) => `${a.code} ${a.nameAr}`.toLowerCase().includes(needle))
      : accounts;
    return Promise.resolve({ items, nextPage: null, total: items.length } as EntityPage<CoaAccount>);
  };
}
