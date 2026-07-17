// People / HR domain DTOs — the exact shapes returned by /api/hr/* and
// /api/custody/* (the legacy Express contracts the server owns). Kept minimal +
// permissive (optional where the backend may omit a column) since the server is
// the source of truth for every HR calculation.

// ── Employees ────────────────────────────────────────────────────────────────
export interface Employee {
  id: string;
  employeeNumber: string;
  fullName: string;
  firstName?: string;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  jobTitle?: string | null;
  departmentName?: string;
  branchName?: string;
  status: string; // active | suspended | terminated | on_leave
  hireDate?: string | null;
  basicSalary: number;
  housingAllowance?: number;
  transportAllowance?: number;
  otherAllowance?: number;
  totalAllowances: number;
  grossSalary: number;
  departmentId?: string | null;
  branchId?: string | null;
  brandId?: string | null;
  employmentType?: string;
  nationalId?: string | null;
  linkedUsername?: string | null;
  linkedRole?: string | null;
}

/** Full employee record (GET /hr/employees/:id) — adds the contract fields. */
export interface EmployeeDetail extends Employee {
  iqamaNumber?: string | null;
  passportNumber?: string | null;
  contractEndDate?: string | null;
  probationEndDate?: string | null;
  terminationDate?: string | null;
  terminationReason?: string | null;
  bankName?: string | null;
  bankIban?: string | null;
  workStart?: string | null;
  workEnd?: string | null;
  notes?: string | null;
}

/** The create/edit payload (POST /hr/employees, PUT /hr/employees/:id). */
export interface EmployeeInput {
  firstName: string;
  lastName?: string;
  nationalId?: string;
  phone?: string;
  email?: string;
  branchId?: string;
  departmentId?: string;
  jobTitle?: string;
  employmentType: string;
  basicSalary: number;
  housingAllowance: number;
  transportAllowance: number;
  otherAllowance: number;
  hireDate?: string;
  contractEndDate?: string;
  bankName?: string;
  bankIban?: string;
  notes?: string;
  createUser?: boolean;
}

// ── Departments / Job titles ─────────────────────────────────────────────────
export interface Department {
  id: string;
  name: string;
  nameEn?: string;
  code?: string;
  branchId?: string;
  branchName?: string;
  employeeCount: number;
  isActive: boolean;
}

export interface DepartmentInput {
  id?: string;
  name: string;
  code?: string;
  branchId?: string;
}

export interface JobTitle {
  id: string;
  code?: string;
  nameAr: string;
  nameEn?: string;
  rank: number;
  category?: string;
  defaultRole?: string;
  isActive: boolean;
}

// ── Attendance ───────────────────────────────────────────────────────────────
export interface AttendanceRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  attendanceDate: string;
  clockIn?: string | null;
  clockOut?: string | null;
  totalHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  status: string;
  source?: string;
}

// ── Shifts ───────────────────────────────────────────────────────────────────
export interface Shift {
  id: string;
  name: string;
  code?: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceLateMinutes: number;
  graceEarlyLeaveMinutes: number;
  allowOvertimeBefore: boolean;
  allowOvertimeAfter: boolean;
  workDays: string; // CSV of weekday indices 0..6
  isDefault: boolean;
}

export interface ShiftInput {
  id?: string;
  name: string;
  code?: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceLateMinutes: number;
  graceEarlyLeaveMinutes: number;
  workDays: string;
  isDefault: boolean;
}

// ── Overtime ─────────────────────────────────────────────────────────────────
export interface OvertimeEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  entryDate: string;
  minutes: number;
  multiplier: number;
  amount: number;
  status: string;
  ruleName?: string;
}

export interface OvertimeRule {
  id: string;
  name: string;
  dayType: string;
  multiplier: number;
  minMinutes: number;
  requireApproval: boolean;
}

// ── Exceptions ───────────────────────────────────────────────────────────────
export interface HrException {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  type: string;
  startDate: string;
  endDate: string;
  reason?: string;
  approvedBy?: string;
  createdAt?: string;
}

// ── Holidays ─────────────────────────────────────────────────────────────────
export interface Holiday {
  id: string;
  name: string;
  nameEn?: string;
  startDate: string;
  endDate: string;
  scope: string;
  isPaid: boolean;
  overtimeMultiplier: number;
  isRecurring: boolean;
  isActive: boolean;
  notes?: string;
}

// ── Weekly off ───────────────────────────────────────────────────────────────
export interface WeeklyOffEmployee {
  id: string;
  name: string;
  branchName: string;
  positionName: string;
  hasOverride: boolean;
  days: number[];
}

export interface WeeklyOffResponse {
  success: boolean;
  orgDefault: number[];
  employees: WeeklyOffEmployee[];
}

// ── Leave ────────────────────────────────────────────────────────────────────
export interface LeaveType {
  id: string;
  name: string;
  nameEn?: string | null;
  defaultDays: number;
  isPaid: boolean;
  isActive: boolean;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  branchName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypePaid: boolean;
  startDate: string;
  endDate: string;
  daysCount: number;
  reason: string;
  status: string;
  createdAt?: string;
}

export interface LeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}

// ── Advances ─────────────────────────────────────────────────────────────────
export interface Advance {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  branchName: string;
  amount: number;
  remaining: number;
  paid: number;
  deductionMonths: number;
  monthlyDeduction: number;
  requestDate?: string;
  status: string;
  notes?: string;
}

// ── Custody ──────────────────────────────────────────────────────────────────
/** Row from GET /custody/users (admin) — the custodian directory. */
export interface CustodyUser {
  id: string;
  name: string;
  idNumber?: string;
  phone?: string;
  jobTitle?: string;
  notes?: string;
  isActive?: number | boolean;
  linkedUsername?: string;
}

export interface Custody {
  id: string;
  custodyNumber: string;
  userId: string;
  userName: string;
  createdDate?: string;
  balance: number;
  totalTopups: number;
  totalExpenses: number;
  status: string;
}

export interface CustodyExpense {
  id: string;
  custodyId?: string;
  custodyNumber?: string;
  userName?: string;
  expenseDate: string;
  description: string;
  amount: number;
  vatAmount: number;
  totalWithVat: number;
  status: string;
  glAccountName?: string;
  rejectionReason?: string;
  /** base64 data-URL (image/* or application/pdf) — column custody_expenses.invoice_image. */
  invoiceImage?: string | null;
  notes?: string;
  createdBy?: string;
  approvedBy?: string;
  hasVat?: number | boolean;
  vatRate?: number;
}

/** POST /custody/:id/expenses body — the exact field set routes/custody.js reads
 *  (expenseDate, description, amount, hasVat, vatRate, invoiceImage, notes,
 *  overrideBalance, glAccountId, glAccountName, costCenterId, costCenterName,
 *  preApproval). The creator comes from the JWT — no username field. */
export interface CustodyExpenseInput {
  expenseDate: string;
  description: string;
  amount: number;
  hasVat: boolean;
  vatRate: number;
  invoiceImage?: string;
  notes?: string;
  overrideBalance?: boolean;
  glAccountId?: string;
  glAccountName?: string;
  costCenterId?: string;
  costCenterName?: string;
}

/** POST /custody/:id/topup body (routes/custody.js:406). Actor from JWT. */
export interface CustodyTopupInput {
  amount: number;
  paymentMethod: "cash" | "transfer" | "other";
  glAccountId?: string;
  receiptImage?: string;
  notes?: string;
}

/** GET /custody/my-custody — the custody-holder portal bundle. */
export interface MyCustodyResponse {
  success?: boolean;
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
  topups?: { id: string; amount: number; paymentMethod?: string; notes?: string; createdAt?: string }[];
  /** GL expense accounts for the expense-type dropdown (id/code/name). */
  expenseAccounts?: { id: string; code: string; name: string }[];
  branchName?: string;
  companyName?: string;
}

/** GET /custody/my-history rows — previous custodies of the holder. */
export interface MyCustodyHistoryRow {
  id: string;
  custodyNumber: string;
  status: string;
  createdDate?: string;
  closeApprovedAt?: string | null;
  balance: number;
  totalTopups: number;
  totalExpenses: number;
}

/** GET /erp/gl/accounts row (subset needed by the topup picker). */
export interface GlAccountLite {
  id: string;
  code: string;
  nameAr: string;
  type?: string;
  isActive?: number | boolean;
}

/** GET /erp/cost-centers row (subset for the expense dialog). */
export interface CostCenterLite {
  id: string;
  code?: string;
  name: string;
}

// ── Self-service ─────────────────────────────────────────────────────────────
export interface MyProfile {
  id?: string;
  employee_number?: string;
  fullName?: string;
  departmentName?: string;
  branchName?: string;
  job_title?: string;
  status?: string;
  basic_salary?: number;
  hire_date?: string;
  [key: string]: unknown;
}

export interface MyAttendanceRow {
  id: string;
  attendance_date: string;
  clock_in?: string | null;
  clock_out?: string | null;
  total_hours?: number;
  late_minutes?: number;
  status?: string;
}

export interface MyLeaveBalance {
  id: string;
  leaveTypeName?: string;
  total_days?: number;
  used_days?: number;
  remaining_days?: number;
  is_paid?: number;
}

export interface MyLeaveRequestRow {
  id: string;
  leaveTypeName?: string;
  start_date: string;
  end_date: string;
  days_count?: number;
  status: string;
  reason?: string;
}

/** POST /hr/my-leave-request body — exact legacy shape (employee/app.js:1701).
 *  The employee is resolved from the JWT; `username` is legacy fidelity only. */
export interface MyLeaveRequestInput {
  username: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason?: string;
}

/** PARTIAL payload for PUT /workflow/org-tree/:id — only the keys present are
 *  written. `managerId: null` clears the manager; omitting it leaves it alone. */
export interface OrgEmployeeUpdate {
  managerId?: string | null;
  workflowLevel?: number;
  permissions?: Partial<{
    create: boolean; approve: boolean; reject: boolean;
    return: boolean; forward: boolean; close: boolean;
  }>;
}
