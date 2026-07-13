// Payroll (الرواتب) data layer — typed react-query hooks over the shared
// apiClient for the server-owned payroll engine (/hr/payroll-runs/*). Legacy
// endpoints answer HTTP 200 with `{ success:false, error }` on failure, so list
// fetchers normalize that into a thrown Error and mutations check it via ensureOk.
//
// This file is self-contained (per the payroll build brief): it does NOT reuse
// people/lib/api.ts nor any other module's api.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, getToken } from "@/shared/api";
import type { StatusTone } from "@/shared/ui";

// ── Types ────────────────────────────────────────────────────────────────────
export type PayrollStatus = "draft" | "calculated" | "approved" | "paid";

export interface PayrollRun {
  id: string;
  month: number;
  year: number;
  branchId: string | null;
  branchName: string | null;
  status: PayrollStatus;
  totalGross: number;
  totalNet: number;
  employeeCount: number;
  createdBy: string | null;
  approvedBy: string | null;
}

export interface PayrollItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  basicSalary: number;
  housingAllowance: number;
  transportAllowance: number;
  otherAllowance: number;
  overtimeAmount: number;
  overtimeHours: number;
  grossSalary: number;
  absenceDeduction: number;
  lateDeduction: number;
  advanceDeduction: number;
  totalDeductions: number;
  netSalary: number;
}

export interface Payslip extends PayrollItem {
  month: number;
  year: number;
  branchName: string | null;
  companyName: string | null;
}

export interface Option {
  id: string;
  label: string;
}

interface MutationResult {
  success?: boolean;
  error?: string;
}
export interface CreateRunResult extends MutationResult {
  id?: string;
}
export interface ApproveResult extends MutationResult {
  glWarning?: string;
  accrualJournal?: string;
  deductionsJournal?: string;
}

// ── Defensive coercion ───────────────────────────────────────────────────────
type Raw = Record<string, unknown>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}
/** First non-null/undefined value among the candidate keys. */
function pick(o: Raw, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
function strOrNull(o: Raw, ...keys: string[]): string | null {
  const v = pick(o, ...keys);
  return v === undefined || v === "" ? null : String(v);
}
function asRows(data: unknown): Raw[] {
  if (Array.isArray(data)) return data as Raw[];
  if (data && typeof data === "object") {
    const d = data as Raw;
    if (d.success === false) throw new Error(str(d.error) || "تعذّر تحميل البيانات");
    // Some legacy list endpoints wrap the array under a data/rows/items key.
    for (const k of ["data", "rows", "items", "runs", "list"]) {
      if (Array.isArray(d[k])) return d[k] as Raw[];
    }
  }
  return [];
}

function mapRun(r: Raw): PayrollRun {
  return {
    id: str(pick(r, "id", "runId", "run_id")),
    month: num(pick(r, "month")),
    year: num(pick(r, "year")),
    branchId: strOrNull(r, "branchId", "branch_id"),
    branchName: strOrNull(r, "branchName", "branch_name"),
    status: (str(pick(r, "status")) || "draft") as PayrollStatus,
    totalGross: num(pick(r, "totalGross", "total_gross")),
    totalNet: num(pick(r, "totalNet", "total_net")),
    employeeCount: num(pick(r, "employeeCount", "employee_count", "employeesCount")),
    createdBy: strOrNull(r, "createdBy", "created_by"),
    approvedBy: strOrNull(r, "approvedBy", "approved_by"),
  };
}

function mapItem(r: Raw): PayrollItem {
  return {
    id: str(pick(r, "id", "itemId", "item_id")),
    employeeId: str(pick(r, "employeeId", "employee_id")),
    employeeName: str(pick(r, "employeeName", "employee_name", "name")),
    employeeNumber: str(pick(r, "employeeNumber", "employee_number", "empNumber")),
    basicSalary: num(pick(r, "basicSalary", "basic_salary", "basic")),
    housingAllowance: num(pick(r, "housingAllowance", "housing_allowance")),
    transportAllowance: num(pick(r, "transportAllowance", "transport_allowance")),
    otherAllowance: num(pick(r, "otherAllowance", "other_allowance")),
    overtimeAmount: num(pick(r, "overtimeAmount", "overtime_amount")),
    overtimeHours: num(pick(r, "overtimeHours", "overtime_hours")),
    grossSalary: num(pick(r, "grossSalary", "gross_salary", "gross")),
    absenceDeduction: num(pick(r, "absenceDeduction", "absence_deduction")),
    lateDeduction: num(pick(r, "lateDeduction", "late_deduction")),
    advanceDeduction: num(pick(r, "advanceDeduction", "advance_deduction")),
    totalDeductions: num(pick(r, "totalDeductions", "total_deductions")),
    netSalary: num(pick(r, "netSalary", "net_salary", "net")),
  };
}

function mapPayslip(data: unknown): Payslip {
  // Payslip may arrive bare or wrapped under `payslip`/`data`.
  let r: Raw = {};
  if (data && typeof data === "object") {
    const d = data as Raw;
    if (d.success === false) throw new Error(str(d.error) || "تعذّر تحميل القسيمة");
    const inner = pick(d, "payslip", "data", "item");
    r = (inner && typeof inner === "object" ? (inner as Raw) : d) ?? {};
  }
  return {
    ...mapItem(r),
    month: num(pick(r, "month")),
    year: num(pick(r, "year")),
    branchName: strOrNull(r, "branchName", "branch_name"),
    companyName: strOrNull(r, "companyName", "company_name", "company"),
  };
}

function mapOptions(data: unknown, ...labelKeys: string[]): Option[] {
  return asRows(data).map((r) => ({
    id: str(pick(r, "id")),
    label: str(pick(r, ...labelKeys, "id")) || "—",
  }));
}

function ensureOk<T extends MutationResult>(d: T): T {
  if (d && d.success === false) throw new Error(str(d.error) || "تعذّر تنفيذ العملية");
  return d;
}

// ── Display helpers ──────────────────────────────────────────────────────────
const MONTHS_AR = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];
export function monthName(m: number): string {
  return MONTHS_AR[(num(m) || 1) - 1] ?? String(m);
}
export function periodLabel(run: { month: number; year: number }): string {
  return `${monthName(run.month)} ${run.year}`;
}

export const PAYROLL_STATUS: Record<PayrollStatus, { label: string; tone: StatusTone }> = {
  draft: { label: "مسودة", tone: "neutral" },
  calculated: { label: "محسوبة", tone: "info" },
  approved: { label: "معتمدة", tone: "warning" },
  paid: { label: "مدفوعة", tone: "success" },
};
export function payrollStatusMeta(status: string): { label: string; tone: StatusTone } {
  return PAYROLL_STATUS[status as PayrollStatus] ?? { label: status || "—", tone: "neutral" };
}

const _money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Plain grouped 2-decimal number (no currency) — English digits per policy. */
export function money(v: number | null | undefined): string {
  return _money.format(num(v));
}

// ── Query keys ───────────────────────────────────────────────────────────────
const KEY = ["people", "payroll"] as const;

// ── Queries ──────────────────────────────────────────────────────────────────
export function usePayrollRuns() {
  return useQuery({
    queryKey: [...KEY, "runs"],
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/hr/payroll-runs", { signal }).then((d) => asRows(d).map(mapRun)),
  });
}

export function usePayrollItems(runId: string | null) {
  return useQuery({
    queryKey: [...KEY, "items", runId],
    enabled: !!runId,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`/hr/payroll-runs/${runId}/items`, { signal }).then((d) => asRows(d).map(mapItem)),
  });
}

export function usePayslip(runId: string | null, empId: string | null) {
  return useQuery({
    queryKey: [...KEY, "payslip", runId, empId],
    enabled: !!runId && !!empId,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`/hr/payroll-runs/${runId}/payslip/${empId}`, { signal }).then(mapPayslip),
  });
}

export function useBankAccounts() {
  return useQuery({
    queryKey: [...KEY, "bank-accounts"],
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/cash/bank-accounts", { signal }).then((d) => mapOptions(d, "name", "bankName", "accountName")),
  });
}

export function useBranches() {
  return useQuery({
    queryKey: [...KEY, "branches"],
    // Optional — the create dialog degrades gracefully to "all branches" if this fails.
    retry: false,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>("/erp/branches-full", { signal }).then((d) => mapOptions(d, "nameAr", "name", "branchName", "code")),
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────
export function useCreatePayrollRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { month: number; year: number; branchId?: string | null }) =>
      apiClient
        .post<CreateRunResult>("/hr/payroll-runs", {
          month: body.month,
          year: body.year,
          ...(body.branchId ? { branchId: body.branchId } : {}),
        })
        .then(ensureOk),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "runs"] }),
  });
}

export function useCalculatePayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiClient.post<MutationResult>(`/hr/payroll-runs/${runId}/calculate`, {}).then(ensureOk),
    onSuccess: (_res, runId) => {
      qc.invalidateQueries({ queryKey: [...KEY, "runs"] });
      qc.invalidateQueries({ queryKey: [...KEY, "items", runId] });
    },
  });
}

export function useApprovePayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiClient.post<ApproveResult>(`/hr/payroll-runs/${runId}/approve`, {}).then(ensureOk),
    onSuccess: (_res, runId) => {
      qc.invalidateQueries({ queryKey: [...KEY, "runs"] });
      qc.invalidateQueries({ queryKey: [...KEY, "items", runId] });
    },
  });
}

export function usePayPayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string; bankAccountId: string }) =>
      apiClient
        .post<MutationResult>(`/hr/payroll-runs/${v.runId}/pay`, { bankAccountId: v.bankAccountId })
        .then(ensureOk),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: [...KEY, "runs"] });
      qc.invalidateQueries({ queryKey: [...KEY, "items", v.runId] });
    },
  });
}

// ── CSV export (raw fetch → blob download; apiClient returns JSON) ────────────
export async function downloadPayrollCsv(run: PayrollRun): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/hr/payroll-runs/${run.id}/export`, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: "text/csv" } : { Accept: "text/csv" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error("تعذّر تصدير الملف");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `payroll-${run.year}-${String(run.month).padStart(2, "0")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
