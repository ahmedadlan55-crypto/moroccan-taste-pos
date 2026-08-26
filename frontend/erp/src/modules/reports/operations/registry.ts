// /reports/operations — three read-only, printable control reports.
//
// WHAT THIS REPLACED
//   Four links OUT of /reports: the POS shifts admin screen, a duplicate jump
//   into the Sales Analytics Hub, the inventory dashboard (whose reports
//   already live under /reports/inventory), and `/workflow/action-log` — a stub
//   page whose entire content was a button pointing at /administration/audit-log.
//   The user-actions report below is that stub's real destination, brought into
//   /reports as an actual report instead of a redirect wearing a card.
//
// EVERY REPORT BELOW IS BACKED BY A REAL ENDPOINT
//   shift variance    GET /shifts/            (theoretical vs counted, per shift)
//   user actions      GET /erp/audit-logs     (the audit_logs table)
//   transaction log   GET /workflow/reports/transaction-log
//
// WHAT IS DELIBERATELY ABSENT
//   A SIGN-IN / SESSION report ("who logged in, when, from where") is not here
//   and cannot be built today. Nothing writes a login or logout row: every
//   `INSERT INTO audit_logs` in the codebase records a business action, there is
//   no `login_history` / `user_sessions` table, and `last_login` is not stored.
//   The audit-log screen's own action list offers `login`/`logout` filters that
//   can never match a row. Building the report would produce a permanently
//   empty sheet that reads as "nobody signed in" — the failure mode this
//   catalogue exists to remove. It needs an auth-side audit write first.
//
// CAPABILITIES ARE BORROWED, NEVER INVENTED
//   `pos.shifts.view` already gates shift data. The audit report uses
//   `administration.audit` — the capability on the screen that reads this very
//   endpoint — which is STRICTER than the `workflow.audit.view` the deleted
//   action-log card carried; nothing was widened.
import { Clock, ScrollText, Workflow } from "lucide-react";
import { apiClient } from "@/shared/api";
import { asRows, num, str, type ReportResult, type ReportSectionDef } from "../engine";

const TXN_STATUS = {
  draft: "operationalReports.txnStatus.draft",
  pending: "operationalReports.txnStatus.pending",
  in_progress: "operationalReports.txnStatus.in_progress",
  approved: "operationalReports.txnStatus.approved",
  rejected: "operationalReports.txnStatus.rejected",
  completed: "operationalReports.txnStatus.completed",
  cancelled: "operationalReports.txnStatus.cancelled",
} as const;

const IMPORTANCE = {
  critical: "operationalReports.importance.critical",
  high: "operationalReports.importance.high",
  medium: "operationalReports.importance.medium",
  low: "operationalReports.importance.low",
} as const;

const SHIFT_STATUS = {
  OPEN: "people.status.open",
  CLOSED: "people.status.closed",
  open: "people.status.open",
  closed: "people.status.closed",
} as const;

const YES_NO = {
  "1": "common.yes",
  "0": "common.no",
} as const;

// ── loaders ─────────────────────────────────────────────────────────────────

async function loadShiftVariance(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const shifts = asRows(
    await apiClient.get<unknown>("/shifts/", {
      params: { report: 1, startDate: filters.from, endDate: filters.to, status: filters.status },
      signal,
    }),
  );
  return {
    rows: shifts.map((shift) => ({
      id: str(shift.id),
      cashier: str(shift.displayName) || str(shift.username),
      shiftStart: str(shift.startTime),
      shiftEnd: str(shift.endTime),
      status: str(shift.status),
      openingFloat: num(shift.openingFloat),
      expectedCash: num(shift.theoreticalCash),
      actualCash: num(shift.actualCash),
      cashVariance: num(shift.diffCash),
      expectedCard: num(shift.theoreticalCard),
      actualCard: num(shift.actualCard),
      cardVariance: num(shift.diffCard),
      totalVariance: num(shift.varianceTotal),
    })),
  };
}

async function loadUserActions(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const entries = asRows(
    await apiClient.get<unknown>("/erp/audit-logs", {
      params: { report: 1, from: filters.from, to: filters.to },
      signal,
    }),
  );
  return {
    rows: entries.map((entry, index) => ({
      // audit_logs ids are unique, but the endpoint has been seen to answer
      // rows without one; the index keeps row identity stable either way.
      id: str(entry.id) || `audit-${index}`,
      at: str(entry.createdAt),
      user: str(entry.username),
      action: str(entry.action),
      entity: str(entry.entityType),
      reference: str(entry.entityId),
      details: str(entry.details),
      ip: str(entry.ipAddress),
    })),
  };
}

async function loadTransactionLog(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const transactions = asRows(
    await apiClient.get<unknown>("/workflow/reports/transaction-log", {
      params: { startDate: filters.from, endDate: filters.to, status: filters.status },
      signal,
    }),
  );
  return {
    rows: transactions.map((transaction) => ({
      id: str(transaction.id),
      txnNumber: str(transaction.txnNumber),
      txnType: str(transaction.typeName),
      subject: str(transaction.subject),
      createdBy: str(transaction.createdBy),
      assignee: str(transaction.currentAssignee),
      importance: str(transaction.importance),
      status: str(transaction.status),
      createdAt: str(transaction.createdAt),
      dueDate: str(transaction.dueDate),
      overdue: transaction.isOverdue ? "1" : "0",
    })),
  };
}

// ── the section ─────────────────────────────────────────────────────────────
export const OPERATIONS_REPORTS_SECTION: ReportSectionDef = {
  path: "/reports/operations",
  titleKey: "misc.reports.sections.operations.title",
  subtitleKey: "misc.reports.sections.operations.subtitle",
  eyebrowKey: "misc.reports.eyebrow",
  groups: [
    {
      id: "posControl",
      titleKey: "operationalReports.groups.posControl.title",
      descriptionKey: "operationalReports.groups.posControl.description",
      icon: Clock,
    },
    {
      id: "governance",
      titleKey: "operationalReports.groups.governance.title",
      descriptionKey: "operationalReports.groups.governance.description",
      icon: ScrollText,
    },
  ],
  reports: [
    {
      id: "shift-variance",
      groupId: "posControl",
      labelKey: "operationalReports.reports.shiftVariance.label",
      descriptionKey: "operationalReports.reports.shiftVariance.description",
      icon: Clock,
      tone: "blue",
      cap: "pos.shifts.view",
      csvName: "shift-variance",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
        {
          id: "status",
          labelKey: "operationalReports.filter.status",
          kind: "select",
          options: [
            { value: "", labelKey: "common.all" },
            { value: "CLOSED", labelKey: "people.status.closed" },
            { value: "OPEN", labelKey: "people.status.open" },
          ],
        },
      ],
      columns: [
        { key: "cashier", labelKey: "operationalReports.col.cashier" },
        { key: "shiftStart", labelKey: "operationalReports.col.shiftStart", format: "datetime" },
        { key: "shiftEnd", labelKey: "operationalReports.col.shiftEnd", format: "datetime" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: SHIFT_STATUS },
        { key: "openingFloat", labelKey: "operationalReports.col.openingFloat", format: "money" },
        { key: "expectedCash", labelKey: "operationalReports.col.expectedCash", format: "money" },
        { key: "actualCash", labelKey: "operationalReports.col.actualCash", format: "money" },
        { key: "cashVariance", labelKey: "operationalReports.col.cashVariance", format: "money" },
        { key: "expectedCard", labelKey: "operationalReports.col.expectedCard", format: "money" },
        { key: "actualCard", labelKey: "operationalReports.col.actualCard", format: "money" },
        { key: "cardVariance", labelKey: "operationalReports.col.cardVariance", format: "money" },
        { key: "totalVariance", labelKey: "operationalReports.col.totalVariance", format: "money" },
      ],
      load: loadShiftVariance,
    },
    {
      id: "user-actions",
      groupId: "governance",
      labelKey: "operationalReports.reports.userActions.label",
      descriptionKey: "operationalReports.reports.userActions.description",
      icon: ScrollText,
      tone: "violet",
      cap: "administration.audit",
      csvName: "user-actions",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
      ],
      columns: [
        { key: "at", labelKey: "operationalReports.col.at", format: "datetime" },
        { key: "user", labelKey: "operationalReports.col.user" },
        { key: "action", labelKey: "operationalReports.col.action" },
        { key: "entity", labelKey: "operationalReports.col.entity" },
        { key: "reference", labelKey: "operationalReports.col.reference", format: "code" },
        { key: "details", labelKey: "operationalReports.col.details" },
        { key: "ip", labelKey: "operationalReports.col.ip", format: "code" },
      ],
      load: loadUserActions,
    },
    {
      id: "transaction-log",
      groupId: "governance",
      labelKey: "operationalReports.reports.transactionLog.label",
      descriptionKey: "operationalReports.reports.transactionLog.description",
      icon: Workflow,
      tone: "teal",
      cap: "workflow.audit.view",
      csvName: "transaction-log",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
        {
          id: "status",
          labelKey: "operationalReports.filter.status",
          kind: "select",
          options: [
            { value: "", labelKey: "common.all" },
            { value: "pending", labelKey: "operationalReports.txnStatus.pending" },
            { value: "in_progress", labelKey: "operationalReports.txnStatus.in_progress" },
            { value: "approved", labelKey: "operationalReports.txnStatus.approved" },
            { value: "rejected", labelKey: "operationalReports.txnStatus.rejected" },
            { value: "completed", labelKey: "operationalReports.txnStatus.completed" },
          ],
        },
      ],
      columns: [
        { key: "txnNumber", labelKey: "operationalReports.col.txnNumber", format: "code" },
        { key: "txnType", labelKey: "operationalReports.col.txnType" },
        { key: "subject", labelKey: "operationalReports.col.subject" },
        { key: "createdBy", labelKey: "operationalReports.col.createdBy" },
        { key: "assignee", labelKey: "operationalReports.col.assignee" },
        { key: "importance", labelKey: "operationalReports.col.importance", format: "status", labels: IMPORTANCE },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: TXN_STATUS },
        { key: "createdAt", labelKey: "operationalReports.col.createdAt", format: "datetime" },
        { key: "dueDate", labelKey: "operationalReports.col.dueDate", format: "date" },
        { key: "overdue", labelKey: "operationalReports.col.overdue", format: "status", labels: YES_NO },
      ],
      load: loadTransactionLog,
    },
  ],
};
