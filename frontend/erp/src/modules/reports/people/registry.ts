// /reports/people — six read-only, printable workforce reports.
//
// WHAT THIS REPLACED
//   The section used to be six links OUT of /reports: the employee list, the
//   org tree, the custody workspace, the attendance editor, the leaves screen
//   and the payroll runs screen. Every one of them is a CRUD workspace, none of
//   them answers a question over a period, and clicking any of them left the
//   reports section. They are gone.
//
// EVERY REPORT BELOW IS BACKED BY A REAL ENDPOINT
//   payroll register     GET /hr/payroll-runs  +  /hr/payroll-runs/:id/items
//   wage structure       GET /hr/employees
//   staff advances       GET /hr/advances
//   attendance summary   GET /hr/attendance/summary
//   leave register       GET /hr/leave-requests
//   open custody         GET /custody/list
//
// WHAT IS DELIBERATELY ABSENT
//   "أرصدة الإجازات" (company-wide leave balances) is NOT here. The only
//   balance endpoint is GET /hr/leave-balances/:employeeId — one employee per
//   request. A company-wide balances report would therefore be N requests fired
//   from a report page, and the alternative (showing one employee at a time)
//   is a lookup, not a report. The leave REGISTER below is the question that
//   the data can actually answer today; the balances report needs a server-side
//   aggregate endpoint first.
//
// CAPABILITIES ARE BORROWED, NEVER INVENTED
//   Each report carries the capability that already gates the same data
//   elsewhere in the product. Salary figures — the register, the wage structure
//   and the advances (which are salary deductions) — are all `people.payroll.view`.
import {
  Banknote,
  BriefcaseBusiness,
  CalendarCheck,
  HandCoins,
  Plane,
  Receipt,
  Users,
  Wallet,
} from "lucide-react";
import { apiClient } from "@/shared/api";
import { asRows, num, str, type ReportOption, type ReportResult, type ReportSectionDef } from "../engine";

const PEOPLE_STATUS = {
  active: "people.status.active",
  suspended: "people.status.suspended",
  terminated: "people.status.terminated",
  on_leave: "people.status.on_leave",
  pending: "people.status.pending",
  branch_approved: "people.status.branch_approved",
  hr_approved: "people.status.hr_approved",
  approved: "people.status.approved",
  rejected: "people.status.rejected",
  paid: "people.status.paid",
  partially_paid: "people.status.partially_paid",
  open: "people.status.open",
  closed: "people.status.closed",
  close_pending: "people.status.close_pending",
} as const;

// ── loaders ─────────────────────────────────────────────────────────────────

/** The payroll RUNS list doubles as the report's period picker. */
async function loadPayrollRunOptions(signal?: AbortSignal): Promise<ReportOption[]> {
  const runs = asRows(await apiClient.get<unknown>("/hr/payroll-runs", { signal }));
  return runs.map((run) => ({
    value: str(run.id),
    // English digits by policy; the month NAME is added by the printed period
    // line, which is the localized half of this label.
    label: `${str(run.runNumber) || str(run.id)} — ${num(run.month)}/${num(run.year)}`,
  }));
}

async function loadPayrollRegister(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const runId = filters.run;
  if (!runId) return { rows: [] };
  const [runs, items] = await Promise.all([
    apiClient.get<unknown>("/hr/payroll-runs", { signal }).then(asRows),
    apiClient.get<unknown>(`/hr/payroll-runs/${encodeURIComponent(runId)}/items`, { signal }).then(asRows),
  ]);
  // The header row carries the totals the payroll ENGINE computed when the run
  // was calculated. They are printed as-is: re-adding the item column here
  // would produce a second figure that silently disagrees the day an item is
  // excluded server-side.
  const run = runs.find((candidate) => str(candidate.id) === runId);
  return {
    rows: items.map((item) => ({
      id: str(item.id),
      employeeNumber: str(item.employeeNumber),
      employeeName: str(item.employeeName),
      basicSalary: num(item.basicSalary),
      housingAllowance: num(item.housingAllowance),
      transportAllowance: num(item.transportAllowance),
      otherAllowance: num(item.otherAllowance),
      overtimeAmount: num(item.overtimeAmount),
      grossSalary: num(item.grossSalary),
      absenceDeduction: num(item.absenceDeduction),
      lateDeduction: num(item.lateDeduction),
      advanceDeduction: num(item.advanceDeduction),
      otherDeduction: num(item.otherDeduction),
      totalDeductions: num(item.totalDeductions),
      netSalary: num(item.netSalary),
      actualDays: num(item.actualDays),
      absentDays: num(item.absentDays),
      leaveDays: num(item.leaveDays),
    })),
    totals: run
      ? [
          { labelKey: "operationalReports.total.employees", value: num(run.employeeCount), format: "count" },
          { labelKey: "operationalReports.total.gross", value: num(run.totalGross), format: "money" },
          { labelKey: "operationalReports.total.deductions", value: num(run.totalDeductions), format: "money" },
          { labelKey: "operationalReports.total.net", value: num(run.totalNet), format: "money" },
        ]
      : undefined,
  };
}

async function loadWageStructure(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const employees = asRows(
    await apiClient.get<unknown>("/hr/employees", { params: { status: filters.status }, signal }),
  );
  return {
    rows: employees.map((employee) => ({
      id: str(employee.id),
      employeeNumber: str(employee.employeeNumber),
      employeeName: str(employee.fullName),
      department: str(employee.departmentName),
      branch: str(employee.branchName),
      jobTitle: str(employee.jobTitle),
      basicSalary: num(employee.basicSalary),
      totalAllowances: num(employee.totalAllowances),
      grossSalary: num(employee.grossSalary),
      status: str(employee.status),
    })),
  };
}

async function loadAdvances(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const advances = asRows(
    await apiClient.get<unknown>("/hr/advances", { params: { status: filters.status }, signal }),
  );
  return {
    rows: advances.map((advance) => ({
      id: str(advance.id),
      employeeNumber: str(advance.employeeNumber),
      employeeName: str(advance.employeeName),
      department: str(advance.deptName),
      branch: str(advance.branchName),
      requestDate: str(advance.requestDate),
      advanceAmount: num(advance.amount),
      advancePaid: num(advance.paid),
      advanceRemaining: num(advance.remaining),
      monthlyDeduction: num(advance.monthlyDeduction),
      deductionMonths: num(advance.deductionMonths),
      status: str(advance.status),
    })),
  };
}

async function loadAttendanceSummary(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const summary = asRows(
    await apiClient.get<unknown>("/hr/attendance/summary", {
      params: { month: filters.month, year: filters.year },
      signal,
    }),
  );
  return {
    rows: summary.map((row) => ({
      id: str(row.employeeId),
      employeeNumber: str(row.employeeNumber),
      employeeName: str(row.employeeName),
      workingDays: num(row.workingDaysInMonth),
      presentDays: num(row.presentDays),
      absentDays: num(row.absentDays),
      lateDays: num(row.lateDays),
      lateMinutes: num(row.totalLateMinutes),
      overtimeMinutes: num(row.totalOvertimeMinutes),
    })),
  };
}

async function loadLeaveRegister(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const requests = asRows(
    await apiClient.get<unknown>("/hr/leave-requests", { params: { status: filters.status }, signal }),
  );
  return {
    rows: requests.map((request) => ({
      id: str(request.id),
      employeeNumber: str(request.employeeNumber),
      employeeName: str(request.employeeName),
      branch: str(request.branchName),
      leaveType: str(request.leaveTypeName),
      startDate: str(request.startDate),
      endDate: str(request.endDate),
      days: num(request.daysCount),
      status: str(request.status),
      approvedBy: str(request.hrApprovedBy) || str(request.branchApprovedBy),
    })),
  };
}

async function loadOpenCustody(
  _filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const custodies = asRows(await apiClient.get<unknown>("/custody/list", { signal }));
  return {
    rows: custodies.map((custody) => ({
      id: str(custody.id),
      custodyNumber: str(custody.custodyNumber),
      custodian: str(custody.userName),
      openedOn: str(custody.createdDate),
      topups: num(custody.totalTopups),
      spent: num(custody.totalExpenses),
      balance: num(custody.balance),
      status: str(custody.status),
    })),
  };
}

// ── the section ─────────────────────────────────────────────────────────────
export const PEOPLE_REPORTS_SECTION: ReportSectionDef = {
  path: "/reports/people",
  titleKey: "misc.reports.sections.people.title",
  subtitleKey: "misc.reports.sections.people.subtitle",
  eyebrowKey: "misc.reports.eyebrow",
  groups: [
    {
      id: "payroll",
      titleKey: "operationalReports.groups.payroll.title",
      descriptionKey: "operationalReports.groups.payroll.description",
      icon: Banknote,
    },
    {
      id: "timeAttendance",
      titleKey: "operationalReports.groups.timeAttendance.title",
      descriptionKey: "operationalReports.groups.timeAttendance.description",
      icon: CalendarCheck,
    },
    {
      id: "custody",
      titleKey: "operationalReports.groups.custody.title",
      descriptionKey: "operationalReports.groups.custody.description",
      icon: BriefcaseBusiness,
    },
  ],
  reports: [
    {
      id: "payroll-register",
      groupId: "payroll",
      labelKey: "operationalReports.reports.payrollRegister.label",
      descriptionKey: "operationalReports.reports.payrollRegister.description",
      icon: Receipt,
      tone: "lime",
      cap: "people.payroll.view",
      csvName: "payroll-register",
      filters: [
        {
          id: "run",
          labelKey: "operationalReports.filter.payrollRun",
          kind: "remote",
          loadOptions: loadPayrollRunOptions,
          optionsKey: ["reports", "people", "payroll-runs"],
        },
      ],
      columns: [
        { key: "employeeNumber", labelKey: "operationalReports.col.employeeNumber", format: "code" },
        { key: "employeeName", labelKey: "operationalReports.col.employeeName" },
        { key: "basicSalary", labelKey: "operationalReports.col.basicSalary", format: "money" },
        { key: "housingAllowance", labelKey: "operationalReports.col.housingAllowance", format: "money" },
        { key: "transportAllowance", labelKey: "operationalReports.col.transportAllowance", format: "money" },
        { key: "otherAllowance", labelKey: "operationalReports.col.otherAllowance", format: "money" },
        { key: "overtimeAmount", labelKey: "operationalReports.col.overtimeAmount", format: "money" },
        { key: "grossSalary", labelKey: "operationalReports.col.grossSalary", format: "money" },
        { key: "absenceDeduction", labelKey: "operationalReports.col.absenceDeduction", format: "money" },
        { key: "lateDeduction", labelKey: "operationalReports.col.lateDeduction", format: "money" },
        { key: "advanceDeduction", labelKey: "operationalReports.col.advanceDeduction", format: "money" },
        { key: "otherDeduction", labelKey: "operationalReports.col.otherDeduction", format: "money" },
        { key: "totalDeductions", labelKey: "operationalReports.col.totalDeductions", format: "money" },
        { key: "netSalary", labelKey: "operationalReports.col.netSalary", format: "money" },
        { key: "actualDays", labelKey: "operationalReports.col.actualDays", format: "count" },
        { key: "absentDays", labelKey: "operationalReports.col.absentDays", format: "count" },
        { key: "leaveDays", labelKey: "operationalReports.col.leaveDays", format: "count" },
      ],
      load: loadPayrollRegister,
    },
    {
      id: "wage-structure",
      groupId: "payroll",
      labelKey: "operationalReports.reports.wageStructure.label",
      descriptionKey: "operationalReports.reports.wageStructure.description",
      icon: Wallet,
      tone: "teal",
      cap: "people.payroll.view",
      csvName: "wage-structure",
      filters: [
        {
          id: "status",
          labelKey: "operationalReports.filter.employmentStatus",
          kind: "select",
          options: [
            { value: "active", labelKey: "people.status.active" },
            { value: "suspended", labelKey: "people.status.suspended" },
            { value: "terminated", labelKey: "people.status.terminated" },
            { value: "", labelKey: "common.all" },
          ],
        },
      ],
      columns: [
        { key: "employeeNumber", labelKey: "operationalReports.col.employeeNumber", format: "code" },
        { key: "employeeName", labelKey: "operationalReports.col.employeeName" },
        { key: "department", labelKey: "operationalReports.col.department" },
        { key: "branch", labelKey: "operationalReports.col.branch" },
        { key: "jobTitle", labelKey: "operationalReports.col.jobTitle" },
        { key: "basicSalary", labelKey: "operationalReports.col.basicSalary", format: "money" },
        { key: "totalAllowances", labelKey: "operationalReports.col.totalAllowances", format: "money" },
        { key: "grossSalary", labelKey: "operationalReports.col.grossSalary", format: "money" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: PEOPLE_STATUS },
      ],
      load: loadWageStructure,
    },
    {
      id: "staff-advances",
      groupId: "payroll",
      labelKey: "operationalReports.reports.staffAdvances.label",
      descriptionKey: "operationalReports.reports.staffAdvances.description",
      icon: HandCoins,
      tone: "amber",
      cap: "people.payroll.view",
      csvName: "staff-advances",
      filters: [
        {
          id: "status",
          labelKey: "operationalReports.filter.status",
          kind: "select",
          options: [
            { value: "approved", labelKey: "people.status.approved" },
            { value: "pending", labelKey: "people.status.pending" },
            { value: "rejected", labelKey: "people.status.rejected" },
            { value: "", labelKey: "common.all" },
          ],
        },
      ],
      columns: [
        { key: "employeeNumber", labelKey: "operationalReports.col.employeeNumber", format: "code" },
        { key: "employeeName", labelKey: "operationalReports.col.employeeName" },
        { key: "department", labelKey: "operationalReports.col.department" },
        { key: "branch", labelKey: "operationalReports.col.branch" },
        { key: "requestDate", labelKey: "operationalReports.col.requestDate", format: "date" },
        { key: "advanceAmount", labelKey: "operationalReports.col.advanceAmount", format: "money" },
        { key: "advancePaid", labelKey: "operationalReports.col.advancePaid", format: "money" },
        { key: "advanceRemaining", labelKey: "operationalReports.col.advanceRemaining", format: "money" },
        { key: "monthlyDeduction", labelKey: "operationalReports.col.monthlyDeduction", format: "money" },
        { key: "deductionMonths", labelKey: "operationalReports.col.deductionMonths", format: "count" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: PEOPLE_STATUS },
      ],
      load: loadAdvances,
    },
    {
      id: "attendance-summary",
      groupId: "timeAttendance",
      labelKey: "operationalReports.reports.attendanceSummary.label",
      descriptionKey: "operationalReports.reports.attendanceSummary.description",
      icon: CalendarCheck,
      tone: "blue",
      cap: "people.attendance.view",
      csvName: "attendance-summary",
      filters: [
        { id: "month", labelKey: "operationalReports.filter.month", kind: "month" },
        { id: "year", labelKey: "operationalReports.filter.year", kind: "year" },
      ],
      columns: [
        { key: "employeeNumber", labelKey: "operationalReports.col.employeeNumber", format: "code" },
        { key: "employeeName", labelKey: "operationalReports.col.employeeName" },
        { key: "workingDays", labelKey: "operationalReports.col.workingDays", format: "count" },
        { key: "presentDays", labelKey: "operationalReports.col.presentDays", format: "count" },
        { key: "absentDays", labelKey: "operationalReports.col.absentDays", format: "count" },
        { key: "lateDays", labelKey: "operationalReports.col.lateDays", format: "count" },
        { key: "lateMinutes", labelKey: "operationalReports.col.lateMinutes", format: "count" },
        { key: "overtimeMinutes", labelKey: "operationalReports.col.overtimeMinutes", format: "count" },
      ],
      load: loadAttendanceSummary,
    },
    {
      id: "leave-register",
      groupId: "timeAttendance",
      labelKey: "operationalReports.reports.leaveRegister.label",
      descriptionKey: "operationalReports.reports.leaveRegister.description",
      icon: Plane,
      tone: "violet",
      cap: "people.leaves.view",
      csvName: "leave-register",
      filters: [
        {
          id: "status",
          labelKey: "operationalReports.filter.status",
          kind: "select",
          options: [
            { value: "", labelKey: "common.all" },
            { value: "pending", labelKey: "people.status.pending" },
            { value: "branch_approved", labelKey: "people.status.branch_approved" },
            { value: "hr_approved", labelKey: "people.status.hr_approved" },
            { value: "rejected", labelKey: "people.status.rejected" },
          ],
        },
      ],
      columns: [
        { key: "employeeNumber", labelKey: "operationalReports.col.employeeNumber", format: "code" },
        { key: "employeeName", labelKey: "operationalReports.col.employeeName" },
        { key: "branch", labelKey: "operationalReports.col.branch" },
        { key: "leaveType", labelKey: "operationalReports.col.leaveType" },
        { key: "startDate", labelKey: "operationalReports.col.startDate", format: "date" },
        { key: "endDate", labelKey: "operationalReports.col.endDate", format: "date" },
        { key: "days", labelKey: "operationalReports.col.days", format: "count" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: PEOPLE_STATUS },
        { key: "approvedBy", labelKey: "operationalReports.col.approvedBy" },
      ],
      load: loadLeaveRegister,
    },
    {
      id: "open-custody",
      groupId: "custody",
      labelKey: "operationalReports.reports.openCustody.label",
      descriptionKey: "operationalReports.reports.openCustody.description",
      icon: Users,
      tone: "rose",
      cap: "people.custody.view",
      csvName: "open-custody",
      filters: [],
      columns: [
        { key: "custodyNumber", labelKey: "operationalReports.col.custodyNumber", format: "code" },
        { key: "custodian", labelKey: "operationalReports.col.custodian" },
        { key: "openedOn", labelKey: "operationalReports.col.openedOn", format: "date" },
        { key: "topups", labelKey: "operationalReports.col.topups", format: "money" },
        { key: "spent", labelKey: "operationalReports.col.spent", format: "money" },
        { key: "balance", labelKey: "operationalReports.col.balance", format: "money" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: PEOPLE_STATUS },
      ],
      load: loadOpenCustody,
    },
  ],
};
