import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, DatePicker, PageHeader, StatusBadge, Tabs } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate, formatNumber } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { exceptionTypeLabel, statusMeta, weekdayLabels } from "../lib/labels";
import type { AttendanceRow, Holiday, HrException, WeeklyOffEmployee } from "../lib/types";

type TabKey = "attendance" | "exceptions" | "weekly-off" | "holidays";

function clockLabel(value?: string | null): string {
  if (!value) return "—";
  const s = String(value);
  const t = s.includes("T") ? s.split("T")[1] : s;
  return t.slice(0, 5) || "—";
}

export function AttendancePage() {
  const t = useTx();
  const [tab, setTab] = useState<TabKey>("attendance");
  const TABS = [
    { value: "attendance", label: t("people.attendance.tabs.attendance") },
    { value: "exceptions", label: t("people.attendance.tabs.exceptions") },
    { value: "weekly-off", label: t("people.attendance.tabs.weeklyOff") },
    { value: "holidays", label: t("people.attendance.tabs.holidays") },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.attendance.title")}
        subtitle={t("people.attendance.subtitle")}
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label={t("people.attendance.tabsAria")} />
      {tab === "attendance" && <AttendanceTab />}
      {tab === "exceptions" && <ExceptionsTab />}
      {tab === "weekly-off" && <WeeklyOffTab />}
      {tab === "holidays" && <HolidaysTab />}
    </div>
  );
}

function AttendanceTab() {
  const t = useTx();
  const [date, setDate] = useState("");
  const params = useMemo(() => (date ? { date } : {}), [date]);
  const query = useQuery({
    queryKey: qk.attendance(params),
    queryFn: ({ signal }) => peopleApi.listAttendance(params, signal),
  });

  const columns: ColumnDef<AttendanceRow>[] = [
    { id: "employeeName", header: t("people.field.employee"), accessor: (r) => r.employeeName, sortable: true },
    { id: "employeeNumber", header: t("people.field.number"), accessor: (r) => r.employeeNumber || "—" },
    {
      id: "attendanceDate",
      header: t("people.field.date"),
      accessor: (r) => r.attendanceDate,
      cell: (r) => formatDate(r.attendanceDate),
      sortable: true,
    },
    { id: "clockIn", header: t("people.attendance.col.clockIn"), accessor: (r) => r.clockIn ?? "", cell: (r) => clockLabel(r.clockIn) },
    { id: "clockOut", header: t("people.attendance.col.clockOut"), accessor: (r) => r.clockOut ?? "", cell: (r) => clockLabel(r.clockOut) },
    {
      id: "totalHours",
      header: t("people.attendance.col.hours"),
      accessor: (r) => r.totalHours,
      cell: (r) => formatNumber(r.totalHours),
      numeric: true,
      sortable: true,
    },
    {
      id: "lateMinutes",
      header: t("people.attendance.col.late"),
      accessor: (r) => r.lateMinutes,
      numeric: true,
      defaultHidden: true,
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status, t);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={query.data ?? []}
      getRowId={(r) => r.id}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => query.refetch()}
      tableId="people.attendance"
      searchable
      searchPlaceholder={t("people.attendance.searchPlaceholder")}
      emptyTitle={t("people.attendance.emptyTitle")}
      exportFilename="attendance.csv"
      filterBar={
        <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
          {t("people.field.date")}
          <DatePicker value={date} onChange={setDate} className="h-10" />
        </label>
      }
    />
  );
}

function ExceptionsTab() {
  const t = useTx();
  const query = useQuery({
    queryKey: qk.exceptions({}),
    queryFn: ({ signal }) => peopleApi.listExceptions({}, signal),
  });

  const columns: ColumnDef<HrException>[] = [
    { id: "employeeName", header: t("people.field.employee"), accessor: (r) => r.employeeName, sortable: true },
    {
      id: "type",
      header: t("people.field.type"),
      accessor: (r) => exceptionTypeLabel(r.type, t),
      cell: (r) => <Badge tone="info">{exceptionTypeLabel(r.type, t)}</Badge>,
    },
    { id: "startDate", header: t("people.field.from"), accessor: (r) => r.startDate, cell: (r) => formatDate(r.startDate), sortable: true },
    { id: "endDate", header: t("people.field.to"), accessor: (r) => r.endDate, cell: (r) => formatDate(r.endDate) },
    { id: "reason", header: t("people.field.reason"), accessor: (r) => r.reason || "—" },
  ];

  return (
    <DataTable
      columns={columns}
      rows={query.data ?? []}
      getRowId={(r) => r.id}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => query.refetch()}
      tableId="people.exceptions"
      searchable
      emptyTitle={t("people.exceptions.emptyTitle")}
    />
  );
}

function WeeklyOffTab() {
  const t = useTx();
  const query = useQuery({
    queryKey: qk.weeklyOff(),
    queryFn: ({ signal }) => peopleApi.weeklyOffEmployees(signal),
  });

  const columns: ColumnDef<WeeklyOffEmployee>[] = [
    { id: "name", header: t("people.field.employee"), accessor: (r) => r.name, sortable: true },
    { id: "branchName", header: t("people.field.branch"), accessor: (r) => r.branchName || "—" },
    { id: "positionName", header: t("people.weeklyOff.col.position"), accessor: (r) => r.positionName || "—" },
    { id: "days", header: t("people.weeklyOff.col.offDays"), accessor: (r) => weekdayLabels(r.days, t) },
    {
      id: "hasOverride",
      header: t("people.weeklyOff.col.custom"),
      accessor: (r) => (r.hasOverride ? t("people.bool.yes") : t("people.bool.default")),
      cell: (r) => <Badge tone={r.hasOverride ? "teal" : "neutral"}>{r.hasOverride ? t("people.bool.custom") : t("people.bool.default")}</Badge>,
    },
  ];

  return (
    <div className="space-y-3">
      {query.data && (
        <p className="text-xs font-bold text-slate-500">
          {t("people.weeklyOff.orgDefault", { days: weekdayLabels(query.data.orgDefault, t) })}
        </p>
      )}
      <DataTable
        columns={columns}
        rows={query.data?.employees ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.weeklyOff"
        searchable
        emptyTitle={t("people.weeklyOff.emptyTitle")}
      />
    </div>
  );
}

function HolidaysTab() {
  const t = useTx();
  const year = new Date().getFullYear();
  const query = useQuery({
    queryKey: qk.holidays(year),
    queryFn: ({ signal }) => peopleApi.listHolidays(year, signal),
  });

  const columns: ColumnDef<Holiday>[] = [
    { id: "name", header: t("people.holidays.col.occasion"), accessor: (r) => r.name, sortable: true },
    { id: "startDate", header: t("people.field.from"), accessor: (r) => r.startDate, cell: (r) => formatDate(r.startDate), sortable: true },
    { id: "endDate", header: t("people.field.to"), accessor: (r) => r.endDate, cell: (r) => formatDate(r.endDate) },
    { id: "scope", header: t("people.holidays.col.scope"), accessor: (r) => r.scope || "—" },
    {
      id: "isPaid",
      header: t("people.holidays.col.paid"),
      accessor: (r) => (r.isPaid ? t("people.bool.yes") : t("common.no")),
      cell: (r) => <StatusBadge tone={r.isPaid ? "success" : "neutral"}>{r.isPaid ? t("people.bool.paid") : t("people.bool.unpaid")}</StatusBadge>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={query.data ?? []}
      getRowId={(r) => r.id}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => query.refetch()}
      tableId="people.holidays"
      searchable
      emptyTitle={t("people.holidays.emptyTitle", { year })}
    />
  );
}
