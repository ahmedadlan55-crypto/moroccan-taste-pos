// Response shapes of the HR self-service endpoints the portal consumes.
// Every one of these routes was already live and unchanged when the original
// PWA was deleted (routes/hr.js) — the portal is a front-end restoration, not
// a new contract. Field names below mirror the server's JSON exactly.

// ─── GET /api/hr/my-profile ──────────────────────────────────────────────────
export interface MyProfile {
  id?: number | string;
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  job_title?: string;
  department_name?: string;
  branch_name?: string;
  hire_date?: string;
  basic_salary?: number;
  salary_type?: string;
  work_start?: string;
  work_end?: string;
  phone?: string;
  email?: string;
  national_id?: string;
  [k: string]: unknown;
}

// ─── GET /api/hr/my-attendance ───────────────────────────────────────────────
export interface MyAttendanceRow {
  id?: number | string;
  attendance_date: string;
  clock_in?: string | null;
  clock_out?: string | null;
  total_hours?: number | null;
  late_minutes?: number | null;
  overtime_minutes?: number | null;
  status?: string | null;
}

// ─── GET /api/hr/my-leave-balances ───────────────────────────────────────────
export interface MyLeaveBalance {
  leave_type_id?: number | string;
  leaveTypeName?: string;
  name?: string;
  entitled_days?: number;
  used_days?: number;
  remaining_days?: number;
}

// ─── GET /api/hr/my-leave-requests ───────────────────────────────────────────
export interface MyLeaveRequestRow {
  id: number | string;
  leave_type_id?: number | string;
  leaveTypeName?: string;
  start_date: string;
  end_date: string;
  days_count?: number;
  reason?: string;
  status?: string;
  created_at?: string;
}

// ─── GET /api/hr/leave-types ─────────────────────────────────────────────────
export interface LeaveType {
  id: number | string;
  name: string;
  name_en?: string;
  max_days?: number;
}

// ─── GET /api/hr/my-hours-summary ────────────────────────────────────────────
// The screen the retired PWA called «ساعاتي». Nothing in the product has
// consumed this endpoint since the PWA was deleted, so every field below was
// read off the handler (routes/hr.js:3208) rather than an existing caller.
export interface HoursDayRow {
  date: string | null;
  clockIn: string | null;
  clockOut: string | null;
  totalHours: number;
  lateMinutes: number;
  lateHours: number;
  /** SAR deducted for being late. */
  lateValue: number;
  overtimeMinutes: number;
  overtimeHours: number;
  /** SAR earned in overtime. */
  overtimeValue: number;
  earlyLeaveMinutes: number;
  earlyLeaveHours: number;
  earlyLeaveValue: number;
  /** overtimeValue − lateValue − earlyLeaveValue. */
  netImpact: number;
  status: string | null;
}

export interface HoursTotals {
  days: number;
  lateMinutes: number;
  lateHours: number;
  lateValue: number;
  overtimeMinutes: number;
  overtimeHours: number;
  overtimeValue: number;
  earlyLeaveMinutes: number;
  earlyLeaveHours: number;
  earlyLeaveValue: number;
  totalHours: number;
  netImpact: number;
  lateDays: number;
  overtimeDays: number;
}

export interface HoursSummary {
  success: true;
  employee: {
    id: number | string;
    name: string;
    employeeNumber?: string;
    branchName?: string;
    departmentName?: string;
    salaryType?: string;
    basicSalary: number;
    hourlyRate: number;
    workStart?: string;
    workEnd?: string;
  };
  period: { from: string; to: string; rangeDays: number; prevFrom: string; prevTo: string };
  multipliers: { overtime: number; lateDeduction: number };
  rows: HoursDayRow[];
  totals: HoursTotals;
  previous?: Partial<HoursTotals>;
  deltas?: { lateHours: number; overtimeHours: number; lateValue: number; overtimeValue: number };
}

// ─── GET /api/hr/my-payslips ─────────────────────────────────────────────────
// `SELECT pi.*` — the payroll-item columns vary by schema generation, so the
// interface names the ones the screen reads and stays open for the rest.
export interface Payslip {
  id: number | string;
  run_id?: number | string;
  run_number?: string;
  month?: number;
  year?: number;
  basic_salary?: number;
  allowances?: number;
  overtime_amount?: number;
  deductions?: number;
  gross_salary?: number;
  net_salary?: number;
  status?: string;
  [k: string]: unknown;
}

// ─── GET /api/hr/my-salary-projection ────────────────────────────────────────
// lib/payroll-engine.js → computeMonthlyProjection. Returns `{ error }` (HTTP
// 200) when the account has no linked employee record.
export interface SalaryProjection {
  isProjection?: true;
  asOfDate?: string;
  error?: string;
  period?: {
    year: number;
    month: number;
    label: string;
    startDate: string;
    endDate: string;
    daysInMonth: number;
    workDaysExpected: number;
    shiftHours: number;
  };
  basic?: { monthlySalary: number; dailyRate: number; hourlyRate: number };
  allowances?: {
    housing: number;
    transport: number;
    communication: number;
    education: number;
    nature: number;
    food: number;
    other: number;
    total: number;
    proRataApplied?: boolean;
  };
  attendance?: {
    workDaysExpected: number;
    presentDays: number;
    partialDays: number;
    absentDays: number;
    leaveDays: number;
    holidayDays: number;
    weekendDays: number;
    pendingDays: number;
    totalWorkHours: number;
    totalLateMinutes: number;
    totalOvertimeMinutes: number;
    holidayWorkedHours: number;
  };
  earnings?: {
    basicEarned: number;
    allowancesEarned: number;
    overtimePay: number;
    holidayBonus: number;
    gross: number;
    [k: string]: unknown;
  };
  deductions?: Record<string, unknown> & { total?: number };
  net?: number;
  [k: string]: unknown;
}

// ─── GET /api/custody/my-custody ─────────────────────────────────────────────
// The standalone «بوابة العهدة» that was deleted alongside the employee PWA.
// Note the route is mounted behind requireRole('admin','manager','custody')
// in server.js — the `custody_portal` flag alone does NOT open it, and the
// portal must not pretend otherwise. `{ error, noCustody:true }` (HTTP 200) is
// the handler's answer for an account that holds no custody.
export interface CustodyExpense {
  id: string;
  expenseDate?: string;
  description?: string;
  amount: number;
  hasVat?: number | boolean;
  vatRate?: number;
  vatAmount?: number;
  totalWithVat?: number;
  invoiceImage?: string | null;
  notes?: string | null;
  status?: string;
  rejectionReason?: string | null;
  glAccountId?: string | null;
  glAccountName?: string | null;
}

export interface CustodyTopup {
  id: string;
  amount: number;
  paymentMethod?: string;
  notes?: string | null;
  createdAt?: string;
}

export interface MyCustody {
  success?: true;
  /** Present INSTEAD of the payload when the account holds no custody. */
  error?: string;
  noCustody?: boolean;
  user?: { id: string; name: string; idNumber?: string; phone?: string; jobTitle?: string };
  custody?: {
    id: string;
    custodyNumber: string;
    userName: string;
    createdDate?: string;
    balance: number;
    totalTopups: number;
    totalExpenses: number;
    status: string;
  };
  expenses?: CustodyExpense[];
  topups?: CustodyTopup[];
  expenseAccounts?: { id: string; code: string; name: string }[];
  branchName?: string;
  companyName?: string;
}
