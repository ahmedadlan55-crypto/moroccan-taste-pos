// ── Accounting domain API adapter + React Query hooks ───────────────────────
// A thin, typed layer over @/shared/api (apiClient). Every endpoint, request
// shape, and query param below is preserved EXACTLY as the legacy report
// loaders call them — these report screens are read-only, so the server owns
// all the math. We only fetch and render what the server returns.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

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
export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  "0-30": "0 – 30 يوم",
  "31-60": "31 – 60 يوم",
  "61-90": "61 – 90 يوم",
  "91-120": "91 – 120 يوم",
  "120+": "أكثر من 120 يوم",
};

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
