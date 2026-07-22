// ── Accounting domain API adapter + React Query hooks ───────────────────────
// A thin, typed layer over @/shared/api (apiClient). Every endpoint, request
// shape, and query param below is preserved EXACTLY as the legacy report
// loaders call them — these report screens are read-only, so the server owns
// all the math. We only fetch and render what the server returns.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { TFunction } from "@/i18n";

// ── date helpers (defaults mirror the legacy loaders) ───────────────────────
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
export function startOfYearISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}

// Legacy endpoints answer HTTP 200 even on failure, carrying { success:false }
// or { error }. Normalize that into a thrown Error so React Query shows the
// error state instead of a silently empty report.
function unwrap<T extends { success?: boolean; error?: string }>(data: T): T {
  if (data && (data.success === false || (typeof data.error === "string" && data.error))) {
    throw new Error(data.error || "تعذّر تحميل البيانات");
  }
  return data;
}

// ── Trial Balance — GET /api/erp/reports/trial-balance ──────────────────────
export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameAr: string;
  type: string;
  parentId: string | null;
  level: number;
  hasChildren: boolean;
  opening: number;
  periodDebit: number;
  periodCredit: number;
  net: number;
  closing: number;
  rowCount: number;
}
export interface TrialBalanceResponse {
  success?: boolean;
  error?: string;
  rows: TrialBalanceRow[];
  totals: {
    opening?: number;
    periodDebit?: number;
    periodCredit?: number;
    closing?: number;
    isBalanced?: boolean;
  };
}
export interface DateRange {
  from: string;
  to: string;
}
export function useTrialBalance(range: DateRange | null) {
  return useQuery({
    queryKey: ["acc", "trial-balance", range?.from, range?.to],
    enabled: !!range,
    queryFn: async () =>
      unwrap(
        await apiClient.get<TrialBalanceResponse>("/erp/reports/trial-balance", {
          params: { from: range!.from, to: range!.to, includeZero: "1" },
        }),
      ),
  });
}

// ── Income Statement (P&L) — GET /api/erp/reports/pnl ───────────────────────
export interface PnlRow {
  accountId: string | null;
  code: string;
  nameAr: string;
  type: "revenue" | "expense";
  amount: number;
  totalDebit: number;
  totalCredit: number;
}
export interface PnlResponse {
  success?: boolean;
  error?: string;
  revenue: PnlRow[];
  expenses: PnlRow[];
  summary: {
    totalRevenue: number;
    totalExpense: number;
    netProfit: number;
    grossMargin: number;
  };
}
export function usePnl(range: DateRange | null) {
  return useQuery({
    queryKey: ["acc", "pnl", range?.from, range?.to],
    enabled: !!range,
    queryFn: async () =>
      unwrap(
        await apiClient.get<PnlResponse>("/erp/reports/pnl", {
          params: { from: range!.from, to: range!.to, groupBy: "account" },
        }),
      ),
  });
}

// ── Balance Sheet (IAS 1) — GET /api/erp/reports/balance-sheet-ifrs ─────────
export interface BsFlatItem {
  id: string;
  code: string;
  name: string;
  balance: number;
  level: number;
}
export interface BalanceSheetResponse {
  error?: string;
  currentAssets: BsFlatItem[];
  nonCurrentAssets: BsFlatItem[];
  currentLiab: BsFlatItem[];
  nonCurrentLiab: BsFlatItem[];
  equityItems: BsFlatItem[];
  totCA: number;
  totNCA: number;
  totCL: number;
  totNCL: number;
  totalAssets: number;
  totalLiabilities: number;
  totEq: number;
  netIncome: number;
  isBalanced: boolean;
  asOfDate: string;
}
export function useBalanceSheet(asOfDate: string | null) {
  return useQuery({
    queryKey: ["acc", "balance-sheet", asOfDate],
    enabled: !!asOfDate,
    queryFn: async () =>
      unwrap(
        await apiClient.get<BalanceSheetResponse>("/erp/reports/balance-sheet-ifrs", {
          params: { asOfDate: asOfDate! },
        }),
      ),
  });
}

// ── Cash Flow (IAS 7) — GET /api/erp/reports/cash-flow-ias7 ─────────────────
export interface CashFlowLine {
  label: string;
  amount: number;
  kind?: string;
  code?: string;
}
export interface CashFlowSection {
  lines: CashFlowLine[];
  total: number;
}
export interface CashFlowResponse {
  error?: string;
  from: string;
  to: string;
  netIncome: number;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChange: number;
  cashOpening: number;
  cashClosing: number;
  actualMovement: number;
  reconciliationDiff: number;
  isReconciled: boolean;
}
export function useCashFlow(range: DateRange | null) {
  return useQuery({
    queryKey: ["acc", "cash-flow", range?.from, range?.to],
    enabled: !!range,
    queryFn: async () =>
      unwrap(
        await apiClient.get<CashFlowResponse>("/erp/reports/cash-flow-ias7", {
          params: { from: range!.from, to: range!.to },
        }),
      ),
  });
}

// ── General Ledger — GET /api/erp/reports/gl-ledger-multi ───────────────────
export interface GlLine {
  id: string;
  journalId: string;
  journalNumber: string;
  date: string;
  addedBy: string;
  description: string;
  referenceType: string;
  referenceId: string;
  debit: number;
  credit: number;
  runningBalance: number;
}
export interface GlSection {
  accountId: string;
  code: string;
  nameAr: string;
  type: string;
  parentId: string | null;
  opening: number;
  openingDebit: number;
  openingCredit: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  lineCount: number;
  lines: GlLine[];
}
export interface GlLedgerResponse {
  success?: boolean;
  error?: string;
  sections: GlSection[];
  grandTotals: {
    debit: number;
    credit: number;
    opening: number;
    closing: number;
    accountCount: number;
    lineCount: number;
  };
}
export function useGlLedger(range: DateRange | null, scope: string) {
  return useQuery({
    queryKey: ["acc", "gl-ledger", range?.from, range?.to, scope],
    enabled: !!range,
    queryFn: async () =>
      unwrap(
        await apiClient.get<GlLedgerResponse>("/erp/reports/gl-ledger-multi", {
          params: { from: range!.from, to: range!.to, scope, accType: "both" },
        }),
      ),
  });
}

// ── Aging (AR / AP) — GET /api/erp/reports/ar-aging | ap-aging ──────────────
export type AgingBucketKey = "0-30" | "31-60" | "61-90" | "91-120" | "120+";
export type AgingBuckets = Record<AgingBucketKey, number>;
export interface ArAgingParty {
  customerId: string;
  customerName: string;
  customerPhone: string;
  total: number;
  buckets: AgingBuckets;
}
export interface ApAgingParty {
  supplierId: string | null;
  supplierName: string;
  total: number;
  buckets: AgingBuckets;
}
export interface AgingResponse<P> {
  success?: boolean;
  error?: string;
  asOfDate: string;
  grandTotal: number;
  grandBuckets: AgingBuckets;
  overdue90PlusRatio: number;
  customers?: P[];
  suppliers?: P[];
}
export function useArAging(asOfDate: string | null) {
  return useQuery({
    queryKey: ["acc", "ar-aging", asOfDate],
    enabled: !!asOfDate,
    queryFn: async () =>
      unwrap(
        await apiClient.get<AgingResponse<ArAgingParty>>("/erp/reports/ar-aging", {
          params: { asOfDate: asOfDate! },
        }),
      ),
  });
}
export function useApAging(asOfDate: string | null) {
  return useQuery({
    queryKey: ["acc", "ap-aging", asOfDate],
    enabled: !!asOfDate,
    queryFn: async () =>
      unwrap(
        await apiClient.get<AgingResponse<ApAgingParty>>("/erp/reports/ap-aging", {
          params: { asOfDate: asOfDate! },
        }),
      ),
  });
}

export const AGING_BUCKETS: AgingBucketKey[] = ["0-30", "31-60", "61-90", "91-120", "120+"];
// Bucket key → i18n leaf (the range keys carry "-"/"+", not valid as dotted paths).
const AGING_BUCKET_KEY: Record<AgingBucketKey, string> = {
  "0-30": "b0_30",
  "31-60": "b31_60",
  "61-90": "b61_90",
  "91-120": "b91_120",
  "120+": "b120plus",
};
/** Aging bucket → localized label; `t` is supplied by the calling component. */
export function agingBucketLabel(t: TFunction, b: AgingBucketKey): string {
  return t(`accounting.aging.buckets.${AGING_BUCKET_KEY[b]}`);
}

// ── Cost Centers — /api/erp/cost-centers (CRUD) ─────────────────────────────
export interface CostCenter {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  branchId: string;
  branchName: string;
  parentId: string;
  parentName: string;
  isActive: boolean;
  notes: string;
  createdAt: string;
  createdBy: string;
}
export interface CostCenterInput {
  id?: string;
  code: string;
  nameAr: string;
  nameEn: string;
  parentId: string | null;
  isActive: boolean;
  notes: string;
}
export function useCostCenters(search: string) {
  return useQuery({
    queryKey: ["acc", "cost-centers", search],
    queryFn: async () =>
      apiClient.get<CostCenter[]>("/erp/cost-centers", {
        params: { q: search || undefined },
      }),
  });
}
export function useSaveCostCenter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CostCenterInput) =>
      apiClient.post<{ success: boolean; id: string; error?: string }>("/erp/cost-centers", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "cost-centers"] }),
  });
}
export function useDeleteCostCenter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ success: boolean; error?: string }>(`/erp/cost-centers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "cost-centers"] }),
  });
}

// ── Projects / Dimensions — GET /api/erp/projects (read-only) ───────────────
export interface Project {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  status: string;
  brandId: string;
  branchId: string;
}
export function useProjects(search: string) {
  return useQuery({
    queryKey: ["acc", "projects", search],
    queryFn: async () =>
      apiClient.get<Project[]>("/erp/projects", {
        params: { q: search || undefined },
      }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// E1 — Chart of Accounts (دليل الحسابات)  ·  /api/erp/gl/accounts
// The legacy screen loads a FLAT array and builds the tree client-side from
// parentId. We preserve that contract exactly: same endpoints, same payloads.
// ════════════════════════════════════════════════════════════════════════════

export type GlAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export const GL_ACCOUNT_TYPES: GlAccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];
/** GL account type → localized label; `t` is supplied by the calling component.
 *  An unknown/blank type falls back to its raw value (never an empty cell). */
export function glTypeLabel(t: TFunction, type: string | null | undefined): string {
  const s = String(type ?? "");
  return (GL_ACCOUNT_TYPES as string[]).includes(s) ? t(`accounting.accountType.${s}`) : s;
}
// Normal balance side, derived from type (mirrors legacy typeNature).
export const GL_TYPE_NATURE: Record<GlAccountType, "debit" | "credit"> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};
// Accounts whose lines require a cost center (P&L). Enforced in the editor.
export const PNL_TYPES: GlAccountType[] = ["revenue", "expense"];

export interface GlAccount {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: GlAccountType;
  parentId: string | null;
  level: number;
  isActive: boolean;
  isFolder: boolean;
  displayOrder: number | null;
  balance: number;
  storedBalance: number;
  movementCount: number;
  accountClass: string;
  reportSection: string | null;
  taxNature: string;
}

export interface GlAccountInput {
  id?: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: GlAccountType;
  parentId: string | null;
  level: number;
  isFolder: boolean;
  isActive?: boolean;
}

// GET /api/erp/gl/accounts → flat GlAccount[] (server owns balances).
export function useGlAccounts() {
  return useQuery({
    queryKey: ["acc", "gl-accounts"],
    queryFn: async () => apiClient.get<GlAccount[]>("/erp/gl/accounts"),
  });
}

// POST /api/erp/gl/accounts (upsert). isActive is honored by the E1 backend
// gap-fix; omitting it leaves the flag untouched (legacy behavior).
export function useSaveGlAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GlAccountInput) =>
      apiClient.post<{ success: boolean; id: string; error?: string }>("/erp/gl/accounts", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "gl-accounts"] }),
  });
}

// Activate / deactivate — re-sends the full account with a flipped isActive so
// the upsert preserves every other column. Distinct hook = testable intent.
export function useSetAccountActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ account, isActive }: { account: GlAccount; isActive: boolean }) =>
      apiClient.post<{ success: boolean; id: string; error?: string }>("/erp/gl/accounts", {
        id: account.id,
        code: account.code,
        nameAr: account.nameAr,
        nameEn: account.nameEn,
        type: account.type,
        parentId: account.parentId,
        level: account.level,
        isFolder: account.isFolder,
        isActive,
      } satisfies GlAccountInput),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "gl-accounts"] }),
  });
}

// DELETE /api/erp/gl/accounts/:id — server refuses if it has children or entries.
export function useDeleteGlAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ success: boolean; error?: string }>(`/erp/gl/accounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "gl-accounts"] }),
  });
}

// POST /api/erp/gl/accounts/:id/folder — flip the is_folder flag.
export function useToggleAccountFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isFolder }: { id: string; isFolder: boolean }) =>
      apiClient.post<{ success: boolean; id: string; isFolder: boolean; error?: string }>(
        `/erp/gl/accounts/${id}/folder`,
        { isFolder },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "gl-accounts"] }),
  });
}

// GET /api/erp/gl/account-ledger/:id → { ledger: [...] } recent movements.
export interface AccountLedgerLine {
  journalId: string;
  journalNumber: string;
  journalDate: string;
  referenceType: string;
  journalDesc?: string;
  entryDesc?: string;
  debit: number;
  credit: number;
  balance: number;
}
export function useAccountLedger(accountId: string | null) {
  return useQuery({
    queryKey: ["acc", "account-ledger", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const res = await apiClient.get<{
        success?: boolean;
        error?: string;
        ledger?: AccountLedgerLine[];
      }>(`/erp/gl/account-ledger/${accountId}`);
      return unwrap(res).ledger ?? [];
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// E1 — Journal Entries (القيود اليومية)  ·  /api/erp/gl/journals
// ════════════════════════════════════════════════════════════════════════════

export type JournalStatus = "draft" | "approved" | "posted";

export interface JournalLine {
  id?: string;
  accountId: string | null;
  accountCode: string;
  accountName: string;
  accountType?: string;
  debit: number;
  credit: number;
  description: string;
  costCenterId: string | null;
  costCenterName?: string;
}

export interface Journal {
  id: string;
  journalNumber: string;
  journalDate: string;
  referenceType: string;
  referenceId: string;
  description: string;
  notes: string;
  totalDebit: number;
  totalCredit: number;
  status: JournalStatus;
  createdBy: string;
  approvedBy: string;
  postedBy: string;
  attachment: string | null;
  brandId: string | null;
  brandName?: string;
  branchId: string | null;
  branchName?: string;
  projectId: string | null;
  projectName?: string;
  costCenterId: string | null;
  costCenterName?: string;
  reversedByJournalId: string | null;
  reversesJournalId: string | null;
  entries: JournalLine[];
}

export interface JournalFilters {
  startDate?: string;
  endDate?: string;
  status?: string;
  q?: string;
  referenceType?: string;
  brandId?: string;
  branchId?: string;
  projectId?: string;
  costCenterId?: string;
}

// GET /api/erp/gl/journals (LIMIT 500, server-side filters) → Journal[].
export function useJournals(filters: JournalFilters) {
  return useQuery({
    queryKey: ["acc", "journals", filters],
    queryFn: async () => {
      const res = await apiClient.get<Journal[] | { success?: boolean; error?: string }>(
        "/erp/gl/journals",
        { params: { ...filters } },
      );
      if (Array.isArray(res)) return res;
      throw new Error((res as { error?: string })?.error || "تعذّر تحميل القيود");
    },
  });
}

// The write payload — identical for create (POST) and edit (PUT).
export interface JournalInput {
  journalDate: string;
  referenceType?: string; // 'manual' | 'opening'
  referenceId?: string;
  description: string;
  notes?: string;
  attachment?: string | null;
  isOpening?: boolean;
  brandId?: string | null;
  branchId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
  costCenterName?: string;
  entries: Array<{
    accountId: string | null;
    accountCode: string;
    accountName: string;
    debit: number;
    credit: number;
    description?: string;
    costCenterId?: string | null;
    costCenterName?: string;
  }>;
}

export function useCreateJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: JournalInput) =>
      apiClient.post<{ success: boolean; id: string; journalNumber: string; error?: string }>(
        "/erp/gl/journals",
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "journals"] }),
  });
}

export function useUpdateJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: JournalInput }) =>
      apiClient.put<{ success: boolean; journalNumber: string; reposted?: boolean; error?: string }>(
        `/erp/gl/journals/${id}`,
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "journals"] }),
  });
}

// POST /:id/approve then /:id/post — a draft must be approved before posting,
// so "post a draft" chains both (matches legacy erpApproveJournal).
export function usePostJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (journal: { id: string; status: JournalStatus }) => {
      if (journal.status === "draft") {
        const a = await apiClient.post<{ success: boolean; error?: string }>(
          `/erp/gl/journals/${journal.id}/approve`,
          {},
        );
        if (a && a.success === false) throw new Error(a.error || "تعذّر اعتماد القيد");
      }
      const p = await apiClient.post<{ success: boolean; error?: string }>(
        `/erp/gl/journals/${journal.id}/post`,
        {},
      );
      if (p && p.success === false) throw new Error(p.error || "تعذّر ترحيل القيد");
      return p;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "journals"] }),
  });
}

// POST /:id/reverse — only a posted, not-yet-reversed journal; reason optional.
export function useReverseJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiClient.post<{
        success: boolean;
        newJournalId?: string;
        newJournalNumber?: string;
        error?: string;
      }>(`/erp/gl/journals/${id}/reverse`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "journals"] }),
  });
}

// ── Journal-line account picker — server-side searchable postable accounts ───
// GET /api/accounting/accounts/search?postingOnly=1 → active + LEAF accounts.
// Shape is structurally the SearchableEntityCombobox EntityFetcher/EntityPage,
// so a line row can pass `searchPostableAccounts` straight in as its fetcher.
export interface PostableAccount {
  id: string;
  code: string;
  name: string;
  nameEn?: string;
  type: GlAccountType | string;
  parentId?: string | null;
  active?: boolean;
}
export interface PostableAccountPage {
  items: PostableAccount[];
  nextPage: number | null;
  total: number;
}
export async function searchPostableAccounts(args: {
  q: string;
  page: number;
  signal?: AbortSignal;
  accountType?: GlAccountType;
}): Promise<PostableAccountPage> {
  const pageSize = 20;
  const res = await apiClient.get<{
    data: PostableAccount[];
    pagination?: { page: number; pageSize: number; total: number; totalPages?: number };
  }>("/accounting/accounts/search", {
    params: {
      q: args.q || undefined,
      postingOnly: "1",
      accountType: args.accountType || undefined,
      page: String(args.page),
      pageSize: String(pageSize),
    },
    signal: args.signal,
  });
  const items = res.data ?? [];
  const pg = res.pagination;
  const total = pg?.total ?? items.length;
  const hasMore = pg ? pg.page * pg.pageSize < total : false;
  return { items, nextPage: hasMore ? args.page + 1 : null, total };
}

// ── Header dimension lookups (optional; inherited by lines server-side) ──────
export interface DimOption {
  id: string;
  name: string;
}
function toDimOptions(rows: Array<Record<string, unknown>>): DimOption[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id ?? ""),
    name: String(r.nameAr ?? r.name ?? r.name_ar ?? r.code ?? r.id ?? ""),
  }));
}
export function useBrands() {
  return useQuery({
    queryKey: ["acc", "brands"],
    queryFn: async () =>
      toDimOptions(await apiClient.get<Array<Record<string, unknown>>>("/erp/brands-stats")),
  });
}
export function useBranches() {
  return useQuery({
    queryKey: ["acc", "branches"],
    queryFn: async () =>
      toDimOptions(await apiClient.get<Array<Record<string, unknown>>>("/erp/branches-full")),
  });
}
export function useWarehousesLookup() {
  return useQuery({
    queryKey: ["acc", "warehouses"],
    queryFn: async () =>
      toDimOptions(await apiClient.get<Array<Record<string, unknown>>>("/erp/warehouses-list")),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// A2 — Legacy-only report conversions (equity changes / profitability /
// inventory valuation / sales analytics). The four endpoints below are the
// PINNED contracts agreed with the backend stream — the server owns every
// number; these hooks only fetch, unwrap and type.
// ════════════════════════════════════════════════════════════════════════════

// ── Equity Changes — GET /api/erp/reports/equity-changes?from=&to= ──────────
export interface EquityAccountRow {
  id: string;
  code: string;
  name: string;
  opening: number;
  periodDebit: number;
  periodCredit: number;
  closing: number;
}
export interface EquityBucket {
  key: string;
  label: string;
  accounts: EquityAccountRow[];
  opening: number;
  closing: number;
}
/** A single statement line the server computes (net income / closing entries). */
export interface EquityStatementLine {
  label?: string;
  amount: number;
}
export interface EquityChangesResponse {
  success?: boolean;
  error?: string;
  from: string;
  to: string;
  buckets: EquityBucket[];
  netIncomeLine: EquityStatementLine | null;
  closingEntriesLine: EquityStatementLine | null;
  totals: { opening: number; closing: number };
  /** Server-side cross-check against the balance sheet's total equity. */
  reconciliation: { bsTotEq: number; matches: boolean };
}
export function useEquityChanges(range: DateRange | null) {
  return useQuery({
    queryKey: ["acc", "equity-changes", range?.from, range?.to],
    enabled: !!range,
    queryFn: async () =>
      unwrap(
        await apiClient.get<EquityChangesResponse>("/erp/reports/equity-changes", {
          params: { from: range!.from, to: range!.to },
        }),
      ),
  });
}

// ── Profitability by dimension — GET /api/erp/reports/profitability ─────────
export type ProfitabilityDimension = "brand" | "branch" | "cost_center";
export const PROFITABILITY_DIMENSIONS: ProfitabilityDimension[] = [
  "brand",
  "branch",
  "cost_center",
];
/** Profitability dimension → localized label; `t` is supplied by the caller. */
export function profitabilityDimLabel(t: TFunction, dim: ProfitabilityDimension): string {
  return t(`accounting.profitability.dimension.${dim}`);
}
export interface ProfitabilityRow {
  id: string | null;
  name: string;
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
}
export interface ProfitabilityResponse {
  success?: boolean;
  error?: string;
  dimension: string;
  rows: ProfitabilityRow[];
}
export interface ProfitabilityFilter extends DateRange {
  dimension: ProfitabilityDimension;
}
export function useProfitability(filter: ProfitabilityFilter | null) {
  return useQuery({
    queryKey: ["acc", "profitability", filter?.dimension, filter?.from, filter?.to],
    enabled: !!filter,
    queryFn: async () =>
      unwrap(
        await apiClient.get<ProfitabilityResponse>("/erp/reports/profitability", {
          params: { dimension: filter!.dimension, from: filter!.from, to: filter!.to },
        }),
      ),
  });
}

// ── Inventory valuation — GET /api/erp/reports/inventory-valuation ──────────
export interface ValuationItem {
  warehouseId: string;
  warehouseName: string;
  itemId: string;
  itemName: string;
  sku: string;
  unit: string;
  itemType: string;
  qty: number;
  avgCost: number;
  value: number;
}
export interface ValuationByWarehouse {
  warehouseId: string;
  warehouseName: string;
  itemCount: number;
  totalQty: number;
  totalValue: number;
}
export interface InventoryValuationResponse {
  success?: boolean;
  error?: string;
  items: ValuationItem[];
  byWarehouse: ValuationByWarehouse[];
  grand: { itemCount: number; totalQty: number; totalValue: number };
  /** Pinned to 'item_cost' — the recorded item cost, NOT a moving average. */
  costBasis: string;
  note: string;
}
export interface InventoryValuationFilter {
  /** Empty string = all warehouses. */
  warehouseId: string;
  /** Empty string = all brands. */
  brandId: string;
}
export function useInventoryValuation(filter: InventoryValuationFilter | null) {
  return useQuery({
    queryKey: ["acc", "inventory-valuation", filter?.warehouseId, filter?.brandId],
    enabled: !!filter,
    queryFn: async () =>
      unwrap(
        await apiClient.get<InventoryValuationResponse>("/erp/reports/inventory-valuation", {
          params: {
            warehouseId: filter!.warehouseId || undefined,
            brandId: filter!.brandId || undefined,
          },
        }),
      ),
  });
}

// ── Sales analytics — GET /api/erp/reports/sales-analytics ──────────────────
export interface SalesHeadline {
  invoiceCount: number;
  total: number;
  avgTicket: number;
}
export interface SalesRevenueSummary {
  invoiceCount: number;
  grossInclVat: number;
  net: number;
  vat: number;
  discounts: number;
  cost: number;
  profit: number;
  /** Invoices excluded from `net` because they carry no VAT breakdown. */
  netUnknownCount: number;
  /** Invoices excluded from `cost`/`profit` because their cost is unknown. */
  costUnknownCount: number;
}
export interface SalesByProductRow {
  name: string;
  qty: number;
  gross: number;
  net: number;
  vat: number;
  cost: number;
  profit: number;
  margin: number;
}
export interface SalesDailyRow {
  date: string;
  count: number;
  total: number;
}
export interface SalesByPaymentRow {
  method: string;
  count: number;
  total: number;
}
export interface SalesByCashierRow {
  cashier: string;
  count: number;
  total: number;
  avgTicket: number;
}
export interface SalesByHourRow {
  hour: number;
  count: number;
  total: number;
}
export interface SalesAnalyticsResponse {
  success?: boolean;
  error?: string;
  headline: SalesHeadline;
  revenue: SalesRevenueSummary;
  byProduct: SalesByProductRow[];
  daily: SalesDailyRow[];
  byPayment: SalesByPaymentRow[];
  byCashier: SalesByCashierRow[];
  byHour: SalesByHourRow[];
  channels: string[];
}
export interface SalesAnalyticsFilter extends DateRange {
  /** Empty string = all brands. */
  brandId: string;
  /** Empty string = all branches. */
  branchId: string;
}
export function useSalesAnalytics(filter: SalesAnalyticsFilter | null) {
  return useQuery({
    queryKey: ["acc", "sales-analytics", filter?.from, filter?.to, filter?.brandId, filter?.branchId],
    enabled: !!filter,
    queryFn: async () =>
      unwrap(
        await apiClient.get<SalesAnalyticsResponse>("/erp/reports/sales-analytics", {
          params: {
            from: filter!.from,
            to: filter!.to,
            brandId: filter!.brandId || undefined,
            branchId: filter!.branchId || undefined,
          },
        }),
      ),
  });
}

// ── Accounting periods (v4) ─────────────────────────────────────────────────
// Converted from the legacy-only `erpLoadPeriods` screen (public/js/erp.js).
// Three states, and the transitions are asymmetric on purpose:
//   open        → soft_closed (reversible) | closed
//   soft_closed → open | closed
//   closed      → open ONLY with force:true — the server reverses the closing
//                 journal entries rather than deleting them, so a hard reopen
//                 mutates the ledger and must be a deliberate act.
export type PeriodStatus = "open" | "soft_closed" | "closed";

export interface AccountingPeriod {
  id: string;
  periodName: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  closedBy: string;
  closedAt: string | null;
  notes: string;
}

export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = {
  open: "مفتوحة",
  soft_closed: "إقفال مبدئي",
  closed: "مُقفلة نهائيًا",
};

/** Which transitions a period in `status` allows. Mirrors the server's rules in
 *  routes/erp.js POST /periods/:id/lock — kept as data so it is unit-testable. */
export function allowedPeriodTransitions(status: PeriodStatus): Array<{ to: PeriodStatus; force: boolean }> {
  if (status === "open") return [{ to: "soft_closed", force: false }, { to: "closed", force: false }];
  if (status === "soft_closed") return [{ to: "open", force: false }, { to: "closed", force: false }];
  return [{ to: "open", force: true }];
}

export function usePeriods() {
  return useQuery({
    queryKey: ["acc", "periods"],
    queryFn: ({ signal }) => apiClient.get<AccountingPeriod[]>("/erp/periods", { signal }),
  });
}

export function useSavePeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id?: string; periodName: string; startDate: string; endDate: string; notes?: string }) => {
      const r = await apiClient.post<{ success: boolean; id?: string; error?: string }>("/erp/periods", input);
      // This endpoint answers 200 {success:false,error} instead of an HTTP error.
      if (r && r.success === false) throw new Error(r.error || "تعذّر حفظ الفترة");
      return r;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc", "periods"] }),
  });
}

export function useLockPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; status: PeriodStatus; force?: boolean }) => {
      const r = await apiClient.post<{ success: boolean; error?: string; closingResult?: unknown }>(
        `/erp/periods/${input.id}/lock`,
        { status: input.status, force: !!input.force },
      );
      if (r && r.success === false) throw new Error(r.error || "تعذّر تغيير حالة الفترة");
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["acc", "periods"] });
      // Closing/reopening posts or reverses closing entries → the ledger moved.
      qc.invalidateQueries({ queryKey: ["acc", "journals"] });
    },
  });
}
