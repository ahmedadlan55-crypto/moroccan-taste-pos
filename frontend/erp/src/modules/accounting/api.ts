// ── Accounting domain API adapter + React Query hooks ───────────────────────
// A thin, typed layer over @/shared/api (apiClient). Every endpoint, request
// shape, and query param below is preserved EXACTLY as the legacy report
// loaders call them — these report screens are read-only, so the server owns
// all the math. We only fetch and render what the server returns.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { TFunction } from "@/i18n";

// Tier A.2 corrective gate — todayISO()/startOfYearISO() moved to
// @/shared/lib/dates (local-time components, not toISOString()'s UTC
// calendar date); re-exported here so every existing `from "../api"`
// import in this module keeps working unchanged.
//
// Release integration — BOTH sides of this conflict are kept deliberately.
// The i18n sprint still carried the old local definitions, which use
// new Date().toISOString().slice(0,10) — that is the UTC calendar date, while
// db/connection.js pins every MySQL session to +03:00. Between 00:00 and 02:59
// Riyadh the default "today" therefore resolved to YESTERDAY. Taking the
// sprint side here would reinstate that bug and orphan shared/lib/dates.ts for
// this module, while banking/api.ts and purchasing/requisitions/api.ts (merged
// clean) keep using the shared helper — three modules disagreeing about what
// day it is, which is precisely what dates.ts exists to prevent. A re-export
// creates no local binding, so the sprint's TFunction import is unaffected.
export { todayISO, startOfYearISO } from "@/shared/lib";

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
// Tier A.1 corrective gate: these types now mirror lib/reports/trialBalance.js
// in full (openDebit/openCredit/closeDebit/closeCredit/abnormalSign/isFolder/
// isPostingLeaf/isActive/diagnostics/isClean) — the PAGE that consumes this
// must read totals/isClean/diagnostics from the response, never recompute
// them client-side (see TrialBalance.tsx).
export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  type: string;
  parentId: string | null;
  level: number;
  hasChildren: boolean;
  isFolder: boolean;
  isPostingLeaf: boolean;
  isActive: boolean;
  isCycleMember: boolean;
  opening: number;
  openDebit: number;
  openCredit: number;
  periodDebit: number;
  periodCredit: number;
  net: number;
  closing: number;
  closeDebit: number;
  closeCredit: number;
  abnormalSign: boolean;
  /** Distinct journals touching this account in the period (COUNT(DISTINCT journal_id), not a GL line count). */
  journalCount: number;
}
export interface TrialBalanceTotals {
  openDebit: number;
  openCredit: number;
  opening: number;
  periodDebit: number;
  periodCredit: number;
  closing: number;
  closeDebit: number;
  closeCredit: number;
  isOpeningBalanced: boolean;
  isPeriodBalanced: boolean;
  isClosingBalanced: boolean;
  isBalanced: boolean;
  abnormalCount: number;
}
// Tier A.2 corrective gate — mirrors lib/reports/trialBalance.js exactly.
// nullAccountEntries/nullAccountDebit/nullAccountCredit (Period-only, Tier
// A.1) split into nullAccountOpening/nullAccountPeriod so an anomaly dated
// before `from` is no longer invisible to the report. orphanAccounts,
// unbalancedJournals, headerLineMismatches, and grossHistoricalMovement are
// new; every diagnostic field here (except grossHistoricalMovement, which
// is informational only) contributes to isClean.
export interface TrialBalanceDiagnosticBucket { count: number; debit: number; credit: number }
export interface TrialBalanceUnbalancedJournal { id: string; journalNumber: string; journalDate: string; totalDebit: number; totalCredit: number }
export interface TrialBalanceHeaderLineMismatch { id: string; journalNumber: string; journalDate: string; headerDebit: number; headerCredit: number; lineDebit: number; lineCredit: number }
export interface TrialBalanceDiagnostics {
  nullAccountOpening: TrialBalanceDiagnosticBucket;
  nullAccountPeriod: TrialBalanceDiagnosticBucket;
  /** Tier A.3 — a NON-NULL gl_entries.account_id matching no gl_accounts row at all (distinct from the NULL-account buckets above). */
  danglingAccountOpening: TrialBalanceDiagnosticBucket;
  danglingAccountPeriod: TrialBalanceDiagnosticBucket;
  futureDatedOpeningJournals: { count: number; debit: number; credit: number };
  /** Raw gross historical turnover before `from` — diagnostic only, NEVER the opening balance (that's totals.openDebit/openCredit). */
  grossHistoricalMovement: { debit: number; credit: number };
  orphanAccounts: Array<{ code: string; nameAr: string; parentId: string }>;
  nonLeafPostingActivity: Array<{ code: string; nameAr: string; isFolder: boolean; hasChildren: boolean; openDebit: number; openCredit: number; periodDebit: number; periodCredit: number }>;
  cycleAccounts: Array<{ code: string; nameAr: string }>;
  levelMismatches: Array<{ code: string; nameAr: string; storedLevel: number; computedLevel: number }>;
  unbalancedJournals: TrialBalanceUnbalancedJournal[];
  headerLineMismatches: TrialBalanceHeaderLineMismatch[];
  note: string;
}
export interface TrialBalanceResponse {
  success?: boolean;
  error?: string;
  code?: string;
  isClean?: boolean;
  /** Fixed at 'CO-MAIN' — this report has no company/ledger isolation (gl_accounts has no company_id). */
  ledgerScope?: string;
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
  diagnostics?: TrialBalanceDiagnostics;
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

// ── Income Statement (IAS 1) — GET /api/erp/reports/income ──────────────────
//
// WHY THIS EXISTS NEXT TO usePnl
//   /reports/pnl answers with two flat lists — `revenue` and `expenses` — and
//   nothing else. From those two lists there is no COGS, therefore no gross
//   profit, therefore no operating income: the three subtotals that make a P&L
//   a STATEMENT rather than a two-column list of accounts. They cannot be
//   derived on the client either; the only honest source for "is this account
//   cost of sales" is gl_accounts.report_section, which is exactly what
//   lib/coa/classify.js reads and what routes/erp/reports/income.js already
//   buckets by. So the statement reads the statement endpoint.
//
//   Both routes are gated on the SAME capability (finance.reports.view), so
//   moving between them widens nothing.
//
//   `usePnl` is kept: it answers a different question (movement by account,
//   groupable by brand / branch / cost centre) and nothing about it changed.
export interface IncomeLine {
  id: string;
  code: string;
  name: string;
  balance: number;
  level: number;
  /**
   * The same account's figure in the comparison period.
   *
   * `null` means one of two things and the difference matters: no comparison was
   * requested, or this account has no figure in that period. Neither is zero,
   * and rendering either as 0 would invent a fact.
   */
  prior?: number | null;
}

/**
 * The comparison period's ladder. Present only when BOTH compareStart and
 * compareEnd were supplied — a half-specified range is refused server-side
 * rather than quietly widened to "everything since the books opened".
 */
export interface IncomeComparison {
  from: string;
  to: string;
  totalRevenue: number;
  totalCOGS: number;
  totalOpex: number;
  totalGAndA: number;
  totalOtherInc: number;
  totalOtherExp: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
}
export interface IncomeStatementResponse {
  error?: string;
  revenue: IncomeLine[];
  totalRevenue: number;
  cogs: IncomeLine[];
  totalCOGS: number;
  grossProfit: number;
  opex: IncomeLine[];
  totalOpex: number;
  gAndA: IncomeLine[];
  totalGAndA: number;
  operatingIncome: number;
  otherIncome: IncomeLine[];
  totalOtherInc: number;
  otherExpense: IncomeLine[];
  totalOtherExp: number;
  netIncome: number;
  /** null when no comparison was requested — never an empty object. */
  comparison?: IncomeComparison | null;
  period?: { startDate: string | null; endDate: string | null };
  /**
   * The route's catch block answers HTTP 200 with every figure zeroed and this
   * flag set. A statement of zeros is indistinguishable from a company that
   * traded nothing, so it must NEVER reach the screen as data — `unwrap` alone
   * would pass it through, which is how an all-zero balance sheet once shipped
   * unnoticed. The hook turns it into an error below.
   */
  degraded?: boolean;
}
/**
 * `compare` is opt-in and needs BOTH edges. It is part of the query key, so
 * turning comparison on refetches rather than rendering the previous answer with
 * an empty second column.
 */
export function useIncomeStatement(range: DateRange | null, compare?: DateRange | null) {
  const comparing = !!(compare && compare.from && compare.to);
  return useQuery({
    queryKey: [
      "acc", "income-statement", range?.from, range?.to,
      comparing ? compare!.from : null, comparing ? compare!.to : null,
    ],
    enabled: !!range,
    queryFn: async () => {
      const data = unwrap(
        await apiClient.get<IncomeStatementResponse>("/erp/reports/income", {
          params: {
            startDate: range!.from,
            endDate: range!.to,
            ...(comparing ? { compareStart: compare!.from, compareEnd: compare!.to } : {}),
          },
        }),
      );
      if (data.degraded) throw new Error("تعذّر تحميل قائمة الدخل");
      return data;
    },
  });
}

// ── Balance Sheet (IAS 1) — GET /api/erp/reports/balance-sheet-ifrs ─────────
export interface BsFlatItem {
  id: string;
  code: string;
  name: string;
  balance: number;
  level: number;
  /**
   * The same account at the comparison date, signed by the SAME rule that
   * produced `balance` — the server applies the row's own transformation
   * rather than re-deriving contra from a different source.
   *
   * `null` = no comparison requested, or the account had no figure then.
   * Neither is zero.
   */
  prior?: number | null;
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
  /**
   * Period-over-period deltas, present only when `compareDate` was supplied.
   *
   * `abs` is (current − prior), computed server-side. The page recovers a prior
   * TOTAL by rearranging that rather than summing a column itself — the same
   * discipline that keeps every other figure on this statement the server's.
   *
   * Server-side those prior totals are summed from the prior COLUMN, so the
   * footer cannot disagree with the lines above it.
   */
  change?: {
    totalAssets: { abs: number; pct: number | null };
    totalLiabilities: { abs: number; pct: number | null };
    totEq: { abs: number; pct: number | null };
    netIncome: { abs: number; pct: number | null };
    sectionTotals?: Record<string, number>;
  } | null;
  asOfDate: string;
}
export function useBalanceSheet(asOfDate: string | null, compareDate?: string | null) {
  const comparing = !!compareDate;
  return useQuery({
    // compareDate is part of the key: turning comparison on must refetch, not
    // re-render the previous answer with an empty second column.
    queryKey: ["acc", "balance-sheet", asOfDate, comparing ? compareDate : null],
    enabled: !!asOfDate,
    queryFn: async () =>
      unwrap(
        await apiClient.get<BalanceSheetResponse>("/erp/reports/balance-sheet-ifrs", {
          params: { asOfDate: asOfDate!, ...(comparing ? { compareDate: compareDate! } : {}) },
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
  createdAt?: string;
  addedBy: string;
  description: string;
  referenceType: string;
  referenceId: string;
  debit: number;
  credit: number;
  runningBalance: number;
  source?: { type: string | null; id: string | null };
  drilldown?: { type: "journal"; id: string; number: string };
}
export interface GlSection {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
  level: number;
  parentId: string | null;
  reportSection: string | null;
  normalBalance: "debit" | "credit" | null;
  isContra: boolean;
  cashFlowActivity: string | null;
  accountStatus: string | null;
  isActive: boolean;
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
  filters?: {
    from: string;
    to: string;
    status: "posted";
    scope: string;
    accType: GlAccountKind;
    addedBy?: string | null;
  };
  pagination?: { bounded: boolean; maxAccounts: number; maxLines: number };
  generatedAt?: string;
}
/** main = a control/folder account · sub = a posting leaf · both = no filter. */
export type GlAccountKind = "both" | "main" | "sub";

/**
 * `accType` was hardcoded to "both" here, so the account-category filter the
 * SERVER has always honoured (routes/erp/reports/gl-ledger.js reads `accType`
 * and applies `isMain`) was unreachable from the UI. It is a real parameter
 * now, and it is part of the query key so switching category refetches.
 */
export function useGlLedger(
  range: DateRange | null,
  scope: string,
  accType: GlAccountKind = "both",
  addedBy = "",
  accountId = "",
  parentId = "",
) {
  const selectedAccount = accountId.trim();
  const selectedParent = parentId.trim();
  return useQuery({
    queryKey: [
      "acc",
      "gl-ledger",
      range?.from,
      range?.to,
      scope,
      accType,
      addedBy.trim(),
      selectedAccount,
      selectedParent,
    ],
    enabled: !!range,
    queryFn: async () =>
      unwrap(
        await apiClient.get<GlLedgerResponse>("/erp/reports/gl-ledger-multi", {
          params: {
            from: range!.from,
            to: range!.to,
            scope,
            accType,
            ...(addedBy.trim() ? { addedBy: addedBy.trim() } : {}),
            ...(selectedAccount ? { accounts: selectedAccount } : {}),
            ...(selectedParent ? { parent: selectedParent } : {}),
          },
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

export type GlAccountStatus = "active" | "blocked" | "archived";

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

  // ── Package H — migration 0028 (`0028_coa_metadata.sql`) columns ──────────
  // OPTIONAL on purpose. The columns exist in the database, but the row mapper
  // in routes/erp.js hand-picks fields, so a given deployment may or may not
  // send them yet. `undefined` therefore means "this server has not surfaced
  // the column", which is a DIFFERENT statement from `false`, and the model
  // helpers in coa/coaModel.tsx branch on exactly that distinction (a chart
  // where NO row carries isSystemRoot falls back to the legacy code set; one
  // where any row carries it trusts the flag). Never widen these to
  // non-optional without also fixing that fallback.
  /** True for the five protected class roots. Replaces the hardcoded 1..5 set. */
  isSystemRoot?: boolean;
  /** Row is maintained by a subledger (customers/suppliers/banks) — not hand-editable. */
  systemManaged?: boolean;
  /** '1'..'5' — the accounting class of a root, independent of its numbering. */
  classCode?: string | null;
  /** Declared normal side. Seeded FROM TYPE, so it does NOT account for contra. */
  normalBalance?: "debit" | "credit" | null;
  /** Declared contra account (its natural side is the opposite of its type's). */
  isContra?: boolean;
  /** May journal entries be posted directly to this account? */
  isPostable?: boolean;
  /** Control (summary) account — a subledger reconciles to it. */
  isControl?: boolean;
  /** active | blocked | archived. Richer than the isActive boolean. */
  status?: GlAccountStatus | null;
  cashFlowActivity?: string | null;
  sourceEntityType?: string | null;
  version?: number | null;
}

// The list endpoint answers camelCase today, but every one of the 0028 columns
// is snake_case in the database and a straight `SELECT a.*` passthrough would
// deliver them that way. Reading BOTH spellings here is the cheap guard: an
// adapter that silently reads the wrong case does not throw, it returns
// `undefined` — which in this module reads as "the server has no such column"
// and quietly reinstates the very fallbacks these columns exist to remove.
type RawAccount = Record<string, unknown>;

function pickBool(raw: RawAccount, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  }
  return undefined;
}

function pickStr(raw: RawAccount, ...keys: string[]): string | null | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (v === undefined) continue;
    if (v === null) return null;
    return String(v);
  }
  return undefined;
}

/** Normalize one list row: keeps the legacy contract, adds the 0028 metadata. */
export function normalizeGlAccount(raw: RawAccount): GlAccount {
  const num = (v: unknown) => Number(v) || 0;
  const status = pickStr(raw, "status", "account_status");
  const normal = pickStr(raw, "normalBalance", "normal_balance");
  return {
    id: String(raw.id ?? ""),
    code: String(raw.code ?? ""),
    nameAr: String(raw.nameAr ?? raw.name_ar ?? ""),
    nameEn: String(raw.nameEn ?? raw.name_en ?? ""),
    type: (raw.type as GlAccountType) ?? "asset",
    parentId: (pickStr(raw, "parentId", "parent_id") as string | null | undefined) ?? null,
    level: Number(raw.level) || 1,
    isActive: pickBool(raw, "isActive", "is_active") ?? true,
    isFolder: pickBool(raw, "isFolder", "is_folder") ?? false,
    displayOrder:
      raw.displayOrder == null && raw.display_order == null
        ? null
        : Number(raw.displayOrder ?? raw.display_order),
    balance: num(raw.balance ?? raw.computed_balance),
    storedBalance: num(raw.storedBalance ?? raw.stored_balance),
    movementCount: num(raw.movementCount ?? raw.movement_count),
    accountClass: String(raw.accountClass ?? raw.account_class ?? "detail"),
    reportSection: (pickStr(raw, "reportSection", "report_section") as string | null | undefined) ?? null,
    taxNature: String(raw.taxNature ?? raw.tax_nature ?? "none"),
    isSystemRoot: pickBool(raw, "isSystemRoot", "is_system_root"),
    systemManaged: pickBool(raw, "systemManaged", "system_managed"),
    classCode: pickStr(raw, "classCode", "class_code") as string | null | undefined,
    normalBalance: normal === "debit" || normal === "credit" ? normal : normal === null ? null : undefined,
    isContra: pickBool(raw, "isContra", "is_contra"),
    isPostable: pickBool(raw, "isPostable", "is_postable"),
    isControl: pickBool(raw, "isControl", "is_control"),
    status:
      status === "active" || status === "blocked" || status === "archived"
        ? status
        : status === null
          ? null
          : undefined,
    cashFlowActivity: pickStr(raw, "cashFlowActivity", "cash_flow_activity") as string | null | undefined,
    sourceEntityType: pickStr(raw, "sourceEntityType", "source_entity_type") as string | null | undefined,
    version: raw.version == null ? undefined : Number(raw.version),
  };
}

export interface GlAccountInput {
  id?: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: GlAccountType;
  parentId: string | null;
  isFolder: boolean;
  isActive?: boolean;
  status?: "active" | "blocked" | "archived";
  reportSection?: string | null;
  cashFlowActivity?: "operating" | "investing" | "financing" | "non_cash" | null;
  /** Optimistic concurrency token returned by GET /erp/gl/accounts. */
  expectedVersion?: number;
}

export interface StatementSection {
  id: string;
  statement: "balance_sheet" | "income_statement" | "cash_flow" | "equity";
  group: string;
  nameAr: string;
  nameEn: string;
  normalBalance: "debit" | "credit";
  isContra: boolean;
  displayOrder: number;
  cashFlowBucket: string | null;
}

/** The same section catalog the financial-statement classifier validates. */
export function useStatementSections() {
  return useQuery({
    queryKey: ["acc", "statement-sections"],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const response = unwrap(
        await apiClient.get<{ success?: boolean; error?: string; sections?: StatementSection[] }>(
          "/erp/gl/statement-sections",
        ),
      );
      return Array.isArray(response.sections) ? response.sections : [];
    },
  });
}

/** What GET /erp/gl/accounts returned, plus whether the as-of date was honored. */
export interface GlAccountsResult {
  accounts: GlAccount[];
  /** The date the SERVER says these balances are stated at, when it says so. */
  asOf: string | null;
  /** True when an as-of date was requested and the server did not confirm it. */
  asOfIgnored: boolean;
}

// GET /api/erp/gl/accounts → flat GlAccount[] (server owns balances).
//
// `asOf` is forwarded as a query param. The route does not read it TODAY, so
// the response is a bare array and the balances are current. That is exactly
// why the result carries `asOfIgnored`: a date picker whose value silently has
// no effect is worse than no picker, so the screen shows the discrepancy
// instead of implying the numbers moved. When the backend starts honoring it
// (answering `{ asOf, accounts }`), this hook needs no change — it already
// reads that shape.
export function useGlAccounts(asOf?: string | null) {
  const wanted = asOf && asOf.trim() ? asOf.trim() : null;
  return useQuery({
    queryKey: ["acc", "gl-accounts", wanted ?? "current"],
    queryFn: async (): Promise<GlAccountsResult> => {
      const path = wanted
        ? `/erp/gl/accounts?asOf=${encodeURIComponent(wanted)}`
        : "/erp/gl/accounts";
      const res = await apiClient.get<unknown>(path);
      if (Array.isArray(res)) {
        return {
          accounts: res.map((r) => normalizeGlAccount(r as RawAccount)),
          asOf: null,
          asOfIgnored: !!wanted,
        };
      }
      const obj = (res ?? {}) as { accounts?: unknown; rows?: unknown; asOf?: unknown; error?: string; success?: boolean };
      unwrap(obj as { success?: boolean; error?: string });
      const list = Array.isArray(obj.accounts) ? obj.accounts : Array.isArray(obj.rows) ? obj.rows : [];
      const serverAsOf = typeof obj.asOf === "string" ? obj.asOf : null;
      return {
        accounts: list.map((r) => normalizeGlAccount(r as RawAccount)),
        asOf: serverAsOf,
        asOfIgnored: !!wanted && serverAsOf !== wanted,
      };
    },
  });
}

// POST /api/erp/gl/accounts (upsert). isActive is honored by the E1 backend
// gap-fix; omitting it leaves the flag untouched (legacy behavior).
export function useSaveGlAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GlAccountInput) =>
      apiClient.post<{ success: boolean; id: string; error?: string; code?: string }>("/erp/gl/accounts", input),
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
        isFolder: account.isFolder,
        isActive,
        expectedVersion: account.version ?? undefined,
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

// POST /api/erp/gl/accounts/:id/move — audited reparenting with stable account
// codes. Answers 4xx + { error } on a cycle / class mismatch / root move,
// so this one CAN reject via HTTP rather than the 200-with-success:false shape.
export interface MoveAccountInput {
  id: string;
  parentId: string | null;
  /** Codes are stable business identifiers; normal UI moves never renumber. */
  autoRenumber?: false;
  expectedVersion?: number;
}
export interface MoveAccountResult {
  success: boolean;
  error?: string;
  code?: string;
  oldCode?: string;
  newCode?: string;
  newParentId?: string | null;
  levelsUpdated?: number;
  renumbered?: Array<{ id: string; oldCode: string; newCode: string }>;
}
export function useMoveGlAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parentId, expectedVersion }: MoveAccountInput) =>
      apiClient.post<MoveAccountResult>(`/erp/gl/accounts/${id}/move`, {
        parentId,
        autoRenumber: false,
        expectedVersion,
      }),
    // A move rewrites codes across the subtree AND gl_entries.account_code, so
    // every accounting query that keys off a code is stale — not just the tree.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc"] }),
  });
}

// POST /api/erp/gl/accounts/import — additive bulk import. Replacement and
// deletion are retired; structural changes use their audited routes.
export interface CoaImportRow {
  id?: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  type?: string;
  parentCode?: string;
  level?: number;
  kind?: string;
  displayOrder?: number | null;
}
export interface CoaImportResult {
  success: boolean;
  error?: string;
  inserted?: number;
  updated?: number;
  skipped?: number;
  deleted?: number;
  codeChanges?: number;
  parentChanges?: number;
  errors?: string[];
  skippedDeletes?: Array<{ id?: string; code?: string; reason?: string }>;
}
export function useImportGlAccounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rows, mode }: { rows: CoaImportRow[]; mode: "update" }) =>
      apiClient.post<CoaImportResult>("/erp/gl/accounts/import", { rows, mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acc"] }),
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

// ── Sales analytics ─────────────────────────────────────────────────────────
// The accounting sales-analytics page and its hook/DTOs were RETIRED with the
// Unified Sales Analytics Hub (/reports/sales/*) — the hub's engine
// (POST /api/analytics/query, modules/reports/sales/lib/api.ts) replaces them.

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
