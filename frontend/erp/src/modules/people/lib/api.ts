// Thin, typed fetchers over the shared apiClient for the People / HR domain.
// Paths are BARE (the "/api" prefix is added by the client). Every list endpoint
// returns a raw JSON array on success but a `{ success:false, error }` object
// (HTTP 200) on failure, so `ensureArray` converts that into a thrown Error which
// react-query surfaces through <ErrorState>.

import { apiClient } from "@/shared/api";
import type { OrgEmployee } from "./orgTree";
import type { ClockResponse, MyClockPayload } from "./selfService";
import type {
  Advance,
  AttendanceRow,
  CostCenterLite,
  Custody,
  CustodyExpense,
  CustodyExpenseInput,
  CustodyTopupInput,
  CustodyUser,
  CustodyUserInput,
  Department,
  DepartmentInput,
  Employee,
  EmployeeDetail,
  EmployeeInput,
  GlAccountLite,
  Holiday,
  HrException,
  JobTitle,
  LeaveRequest,
  LoginAccount,
  LeaveRequestInput,
  LeaveType,
  MyAttendanceRow,
  MyCustodyHistoryRow,
  MyCustodyResponse,
  MyLeaveBalance,
  MyLeaveRequestInput,
  MyLeaveRequestRow,
  MyProfile,
  OrgEmployeeUpdate,
  OvertimeEntry,
  OvertimeRule,
  Shift,
  ShiftInput,
  WeeklyOffResponse,
} from "./types";

interface Failure {
  success: false;
  error?: string;
}

function isFailure(data: unknown): data is Failure {
  return !!data && typeof data === "object" && (data as { success?: unknown }).success === false;
}

/** Normalize a list endpoint: array → array, `{success:false}` → throw. */
function ensureArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (isFailure(data)) throw new Error(data.error || "تعذّر تحميل البيانات");
  return [];
}

/** Normalize a mutation response: throw on `{success:false}`. */
function ensureOk<T extends { success?: boolean }>(data: T): T {
  if (isFailure(data)) throw new Error(data.error || "تعذّر تنفيذ العملية");
  return data;
}

type Params = Record<string, string | number | boolean | undefined | null>;

// ── Employees ────────────────────────────────────────────────────────────────
export const peopleApi = {
  listEmployees: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/employees", { params, signal }).then(ensureArray<Employee>),

  getEmployee: (id: string, signal?: AbortSignal) =>
    apiClient.get<EmployeeDetail>(`/hr/employees/${id}`, { signal }),

  createEmployee: (body: EmployeeInput) =>
    apiClient.post<{ success: boolean; employeeNumber?: string; error?: string }>("/hr/employees", body).then(ensureOk),

  updateEmployee: (id: string, body: EmployeeInput) =>
    apiClient.put<{ success: boolean; error?: string }>(`/hr/employees/${id}`, body).then(ensureOk),

  suspendEmployee: (id: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/employees/${id}/suspend`, {}).then(ensureOk),

  activateEmployee: (id: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/employees/${id}/activate`, {}).then(ensureOk),

  terminateEmployee: (id: string, terminationReason: string) =>
    apiClient
      .post<{ success: boolean; error?: string }>(`/hr/employees/${id}/terminate`, {
        terminationReason,
        terminationDate: new Date().toISOString().slice(0, 10),
      })
      .then(ensureOk),

  deleteEmployee: (id: string) =>
    apiClient.delete<{ success: boolean; error?: string }>(`/hr/employees/${id}`).then(ensureOk),

  // ── Departments / job titles ──
  listDepartments: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/departments", { signal }).then(ensureArray<Department>),

  saveDepartment: (body: DepartmentInput) =>
    apiClient.post<{ success: boolean; error?: string }>("/hr/departments", body).then(ensureOk),

  listJobTitles: (signal?: AbortSignal) =>
    apiClient
      .get<{ success?: boolean; jobTitles?: JobTitle[]; error?: string }>("/hr/job-titles", {
        params: { includeInactive: 1 },
        signal,
      })
      .then((d) => {
        if (isFailure(d)) throw new Error(d.error || "تعذّر تحميل المسميات الوظيفية");
        return d.jobTitles ?? [];
      }),

  // ── Attendance / exceptions / holidays / weekly-off ──
  listAttendance: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/attendance", { params, signal }).then(ensureArray<AttendanceRow>),

  listExceptions: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/exceptions", { params, signal }).then(ensureArray<HrException>),

  listHolidays: (year: number, signal?: AbortSignal) =>
    apiClient
      .get<unknown>("/hr/holidays", { params: { year, includeInactive: 1 }, signal })
      .then(ensureArray<Holiday>),

  weeklyOffEmployees: (signal?: AbortSignal) =>
    apiClient.get<WeeklyOffResponse>("/hr/weekly-off/employees", { signal }).then((d) => {
      if (isFailure(d)) throw new Error(d.error || "تعذّر تحميل الإجازات الأسبوعية");
      return d;
    }),

  // ── Shifts / overtime ──
  listShifts: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/shifts", { signal }).then(ensureArray<Shift>),

  saveShift: (body: ShiftInput) =>
    apiClient.post<{ success: boolean; error?: string }>("/hr/shifts", body).then(ensureOk),

  deleteShift: (id: string) =>
    apiClient.delete<{ success: boolean; error?: string }>(`/hr/shifts/${id}`).then(ensureOk),

  listOvertimeEntries: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/overtime-entries", { params, signal }).then(ensureArray<OvertimeEntry>),

  listOvertimeRules: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/overtime-rules", { signal }).then(ensureArray<OvertimeRule>),

  approveOvertime: (id: string, username: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/overtime-entries/${id}/approve`, { username }).then(ensureOk),

  rejectOvertime: (id: string, username: string, note: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/overtime-entries/${id}/reject`, { username, note }).then(ensureOk),

  // ── Leave ──
  listLeaveRequests: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/leave-requests", { params, signal }).then(ensureArray<LeaveRequest>),

  createLeaveRequest: (body: LeaveRequestInput) =>
    apiClient
      .post<{ success: boolean; requestNumber?: string; warning?: string; error?: string }>("/hr/leave-requests", body)
      .then(ensureOk),

  approveLeave: (id: string, username: string, level: "branch" | "hr") =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/leave-requests/${id}/approve`, { username, level }).then(ensureOk),

  rejectLeave: (id: string, username: string, reason: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/leave-requests/${id}/reject`, { username, reason }).then(ensureOk),

  listLeaveTypes: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/leave-types", { signal }).then((d) => {
      const rows = ensureArray<Record<string, unknown>>(d);
      return rows.map(
        (r): LeaveType => ({
          id: String(r.id),
          name: String(r.name ?? ""),
          nameEn: (r.name_en as string) ?? null,
          defaultDays: Number(r.default_days) || 0,
          isPaid: r.is_paid !== 0 && r.is_paid !== false,
          isActive: r.is_active !== 0 && r.is_active !== false,
        }),
      );
    }),

  // ── Advances ──
  listAdvances: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/advances", { params, signal }).then(ensureArray<Advance>),

  approveAdvance: (id: string, username: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/advances/${id}/approve`, { username }).then(ensureOk),

  rejectAdvance: (id: string, username: string, reason: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/hr/advances/${id}/reject`, { username, reason }).then(ensureOk),

  // ── Custody — reads ──
  listCustodies: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/custody/list", { signal }).then(ensureArray<Custody>),

  listCustodyExpenses: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/custody/expenses/all", { params, signal }).then(ensureArray<CustodyExpense>),

  custodyExpensesFor: (id: string, signal?: AbortSignal) =>
    apiClient.get<unknown>(`/custody/${id}/expenses`, { signal }).then(ensureArray<CustodyExpense>),

  /** Admin/manager: the custodian directory (picker for إنشاء عهدة). */
  listCustodyUsers: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/custody/users", { signal }).then(ensureArray<CustodyUser>),

  /** Admin/manager: expenses awaiting a decision (pending/approved/override_pending/returned). */
  listCustodyPending: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/custody/approval/pending", { signal }).then(ensureArray<CustodyExpense>),

  /** Custody holder: my active custody bundle (stats + expenses + expense-type accounts). */
  myCustody: (signal?: AbortSignal) =>
    apiClient.get<MyCustodyResponse>("/custody/my-custody", { signal }),

  /** Custody holder: my previous custodies (legacy loadHistory, custody/app.js:627). */
  myCustodyHistory: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/custody/my-history", { signal }).then(ensureArray<MyCustodyHistoryRow>),

  // ── Custody — writes (routes/custody.js; actor ALWAYS from the JWT) ──
  /** Legacy createCustodyFn (public/js/custody.js:160) → POST /custody/create. */
  createCustody: (body: { userId: string; userName: string }) =>
    apiClient
      .post<{ success: boolean; id?: string; custodyNumber?: string; error?: string }>("/custody/create", body)
      .then(ensureOk),

  /** Legacy submitTopup (public/js/custody.js:249) → POST /custody/:id/topup. */
  topupCustody: (custodyId: string, body: CustodyTopupInput) =>
    apiClient
      .post<{ success: boolean; id?: string; error?: string }>(`/custody/${custodyId}/topup`, body)
      .then(ensureOk),

  /** Legacy submitExpense (custody/app.js:456) → POST /custody/:id/expenses.
   *  NOT ensureOk-wrapped: the { needsOverride } refusal is a real flow the
   *  caller must branch on (override confirm → resend with overrideBalance). */
  addCustodyExpense: (custodyId: string, body: CustodyExpenseInput) =>
    apiClient.post<{ success: boolean; id?: string; status?: string; needsOverride?: boolean; error?: string }>(
      `/custody/${custodyId}/expenses`,
      body,
    ),

  /** Legacy approveCustodyExpFn (public/js/custody.js:446). */
  approveCustodyExpense: (expId: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/custody/expenses/${expId}/approve`, {}).then(ensureOk),

  /** Legacy rejectCustodyExpFn (public/js/custody.js:451). */
  rejectCustodyExpense: (expId: string, reason: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/custody/expenses/${expId}/reject`, { reason }).then(ensureOk),

  /** Legacy approveOverrideFn (public/js/custody.js:468) — moves override_pending → pending. */
  approveOverrideExpense: (expId: string) =>
    apiClient
      .post<{ success: boolean; error?: string }>(`/custody/expenses/${expId}/approve-override`, {})
      .then(ensureOk),

  /** Legacy confirmClose (custody/app.js:516) → POST /custody/:id/close-request. */
  requestCloseCustody: (custodyId: string, notes: string) =>
    apiClient
      .post<{ success: boolean; balance?: number; error?: string }>(`/custody/${custodyId}/close-request`, { notes })
      .then(ensureOk),

  /** Legacy approveCloseCustodyFn (public/js/custody.js:473). */
  approveCloseCustody: (custodyId: string) =>
    apiClient
      .post<{ success: boolean; balance?: number; error?: string }>(`/custody/${custodyId}/close-approve`, {})
      .then(ensureOk),

  /** Legacy rejectCloseCustodyFn (public/js/custody.js:478). */
  rejectCloseCustody: (custodyId: string, reason: string) =>
    apiClient
      .post<{ success: boolean; error?: string }>(`/custody/${custodyId}/close-reject`, { reason })
      .then(ensureOk),

  // ── Custody officers (مسؤولو العهدة) — admin/manager CRUD over custody_users ──
  /** Create (no id) or update (id present) a custodian. A 409 { code:'DUPLICATE_LINK' }
   *  comes back as an ApiError when linkedUsername is already taken by another
   *  active custodian — the caller surfaces it as a field-level message. */
  saveCustodyUser: (body: CustodyUserInput) =>
    apiClient
      .post<{ success: boolean; id?: string; error?: string; code?: string }>("/custody/users", body)
      .then(ensureOk),

  /** Flip a custodian active ⇄ inactive. */
  toggleCustodyUser: (id: string) =>
    apiClient.post<{ success: boolean; error?: string }>(`/custody/users/${id}/toggle`, {}).then(ensureOk),

  /** Remove a custodian (server refuses when they still hold an active custody). */
  deleteCustodyUser: (id: string) =>
    apiClient.delete<{ success: boolean; error?: string }>(`/custody/users/${id}`).then(ensureOk),

  /** Lightweight login-account directory for the "ربط بحساب دخول" picker. */
  listLoginAccounts: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/auth/users-list", { signal }).then(ensureArray<LoginAccount>),

  // ── Pickers backing the custody dialogs ──
  /** GL accounts for the topup cash/bank picker — same endpoint the legacy admin
   *  used (api-bridge getGLAccounts → GET /erp/gl/accounts, finance.gl.view). */
  listGlAccounts: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/erp/gl/accounts", { signal }).then(ensureArray<GlAccountLite>),

  /** Cost centers for the expense dialog (legacy getCostCenters → /erp/cost-centers). */
  listCostCenters: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/erp/cost-centers", { signal }).then(ensureArray<CostCenterLite>),

  // ── Self-service ──
  myProfile: (signal?: AbortSignal) =>
    apiClient.get<{ success?: boolean; employee?: MyProfile; error?: string }>("/hr/my-profile", { signal }).then((d) => {
      if (isFailure(d)) throw new Error(d.error || "لا يوجد ملف موظف مرتبط بحسابك");
      return d.employee ?? null;
    }),

  myAttendance: (params: Params, signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/my-attendance", { params, signal }).then(ensureArray<MyAttendanceRow>),

  myLeaveBalances: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/my-leave-balances", { signal }).then(ensureArray<MyLeaveBalance>),

  myLeaveRequests: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/hr/my-leave-requests", { signal }).then(ensureArray<MyLeaveRequestRow>),

  // ── Self-service — writes ──
  /** Legacy sendClock (employee/app.js:1418) → POST /hr/my-clock. The response
   *  is NOT ensureOk-wrapped: geofence refusals come back as
   *  { success:false, code:'outside_fence', distance, radius } and the caller
   *  renders the exact legacy distance message. */
  myClock: (body: MyClockPayload) => apiClient.post<ClockResponse>("/hr/my-clock", body),

  /** Legacy submitLeave (employee/app.js:1700) → POST /hr/my-leave-request. */
  submitMyLeaveRequest: (body: MyLeaveRequestInput) =>
    apiClient
      .post<{ success: boolean; id?: string; requestNumber?: string; message?: string; error?: string }>(
        "/hr/my-leave-request",
        body,
      )
      .then(ensureOk),
};

// ── Org chart (v4) ───────────────────────────────────────────────────────────
// GET/PUT /workflow/org-tree. These live under /workflow because the manager
// chain and the can_*_txn flags are the workflow engine's routing inputs — but
// the screen is a People screen, so the hooks live here.
//
// Guarded since v4 (workflow.view / workflow.manage). Before that the endpoint
// was unauthenticated: a tokenless GET returned the whole staff directory.
export const orgTreeApi = {
  /** NOTE: answers a BARE ARRAY — no {success} envelope, unlike the PUT beside it. */
  list: (signal?: AbortSignal) =>
    apiClient.get<unknown>("/workflow/org-tree", { signal }).then(ensureArray<OrgEmployee>),

  /** PARTIAL update — send only what changed; the server sets only the keys present. */
  update: (employeeId: string, body: OrgEmployeeUpdate) =>
    apiClient
      .put<{ success: boolean; error?: string }>(`/workflow/org-tree/${employeeId}`, body)
      .then(ensureOk),
};
