import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Input, PageHeader, StatusBadge, Tabs } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate, formatNumber } from "@/shared/lib";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { EXCEPTION_TYPE_LABEL, statusMeta, weekdayLabels } from "../lib/labels";
import type { AttendanceRow, Holiday, HrException, WeeklyOffEmployee } from "../lib/types";

type TabKey = "attendance" | "exceptions" | "weekly-off" | "holidays";

const TABS = [
  { value: "attendance", label: "سجل الحضور" },
  { value: "exceptions", label: "الاستثناءات" },
  { value: "weekly-off", label: "الإجازات الأسبوعية" },
  { value: "holidays", label: "العطل الرسمية" },
];

function clockLabel(value?: string | null): string {
  if (!value) return "—";
  const s = String(value);
  const t = s.includes("T") ? s.split("T")[1] : s;
  return t.slice(0, 5) || "—";
}

export function AttendancePage() {
  const [tab, setTab] = useState<TabKey>("attendance");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الحضور والانصراف"
        subtitle="سجل الحضور اليومي والاستثناءات والإجازات الأسبوعية والعطل الرسمية."
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label="أقسام الحضور" />
      {tab === "attendance" && <AttendanceTab />}
      {tab === "exceptions" && <ExceptionsTab />}
      {tab === "weekly-off" && <WeeklyOffTab />}
      {tab === "holidays" && <HolidaysTab />}
    </div>
  );
}

function AttendanceTab() {
  const [date, setDate] = useState("");
  const params = useMemo(() => (date ? { date } : {}), [date]);
  const query = useQuery({
    queryKey: qk.attendance(params),
    queryFn: ({ signal }) => peopleApi.listAttendance(params, signal),
  });

  const columns: ColumnDef<AttendanceRow>[] = [
    { id: "employeeName", header: "الموظف", accessor: (r) => r.employeeName, sortable: true },
    { id: "employeeNumber", header: "الرقم", accessor: (r) => r.employeeNumber || "—" },
    {
      id: "attendanceDate",
      header: "التاريخ",
      accessor: (r) => r.attendanceDate,
      cell: (r) => formatDate(r.attendanceDate),
      sortable: true,
    },
    { id: "clockIn", header: "الدخول", accessor: (r) => r.clockIn ?? "", cell: (r) => clockLabel(r.clockIn) },
    { id: "clockOut", header: "الخروج", accessor: (r) => r.clockOut ?? "", cell: (r) => clockLabel(r.clockOut) },
    {
      id: "totalHours",
      header: "الساعات",
      accessor: (r) => r.totalHours,
      cell: (r) => formatNumber(r.totalHours),
      numeric: true,
      sortable: true,
    },
    {
      id: "lateMinutes",
      header: "تأخير (د)",
      accessor: (r) => r.lateMinutes,
      numeric: true,
      defaultHidden: true,
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status,
      cell: (r) => {
        const m = statusMeta(r.status);
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
      searchPlaceholder="بحث باسم الموظف…"
      emptyTitle="لا توجد سجلات حضور"
      exportFilename="attendance.csv"
      filterBar={
        <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
          التاريخ
          <Input type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} className="h-10" />
        </label>
      }
    />
  );
}

function ExceptionsTab() {
  const query = useQuery({
    queryKey: qk.exceptions({}),
    queryFn: ({ signal }) => peopleApi.listExceptions({}, signal),
  });

  const columns: ColumnDef<HrException>[] = [
    { id: "employeeName", header: "الموظف", accessor: (r) => r.employeeName, sortable: true },
    {
      id: "type",
      header: "النوع",
      accessor: (r) => EXCEPTION_TYPE_LABEL[r.type] ?? r.type,
      cell: (r) => <Badge tone="info">{EXCEPTION_TYPE_LABEL[r.type] ?? r.type}</Badge>,
    },
    { id: "startDate", header: "من", accessor: (r) => r.startDate, cell: (r) => formatDate(r.startDate), sortable: true },
    { id: "endDate", header: "إلى", accessor: (r) => r.endDate, cell: (r) => formatDate(r.endDate) },
    { id: "reason", header: "السبب", accessor: (r) => r.reason || "—" },
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
      emptyTitle="لا توجد استثناءات"
    />
  );
}

function WeeklyOffTab() {
  const query = useQuery({
    queryKey: qk.weeklyOff(),
    queryFn: ({ signal }) => peopleApi.weeklyOffEmployees(signal),
  });

  const columns: ColumnDef<WeeklyOffEmployee>[] = [
    { id: "name", header: "الموظف", accessor: (r) => r.name, sortable: true },
    { id: "branchName", header: "الفرع", accessor: (r) => r.branchName || "—" },
    { id: "positionName", header: "المنصب", accessor: (r) => r.positionName || "—" },
    { id: "days", header: "أيام الإجازة", accessor: (r) => weekdayLabels(r.days) },
    {
      id: "hasOverride",
      header: "مخصّص",
      accessor: (r) => (r.hasOverride ? "نعم" : "الافتراضي"),
      cell: (r) => <Badge tone={r.hasOverride ? "teal" : "neutral"}>{r.hasOverride ? "مخصّص" : "الافتراضي"}</Badge>,
    },
  ];

  return (
    <div className="space-y-3">
      {query.data && (
        <p className="text-xs font-bold text-slate-500">
          الإجازة الأسبوعية الافتراضية للمؤسسة: {weekdayLabels(query.data.orgDefault)}
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
        emptyTitle="لا يوجد موظفون"
      />
    </div>
  );
}

function HolidaysTab() {
  const year = new Date().getFullYear();
  const query = useQuery({
    queryKey: qk.holidays(year),
    queryFn: ({ signal }) => peopleApi.listHolidays(year, signal),
  });

  const columns: ColumnDef<Holiday>[] = [
    { id: "name", header: "المناسبة", accessor: (r) => r.name, sortable: true },
    { id: "startDate", header: "من", accessor: (r) => r.startDate, cell: (r) => formatDate(r.startDate), sortable: true },
    { id: "endDate", header: "إلى", accessor: (r) => r.endDate, cell: (r) => formatDate(r.endDate) },
    { id: "scope", header: "النطاق", accessor: (r) => r.scope || "—" },
    {
      id: "isPaid",
      header: "مدفوعة",
      accessor: (r) => (r.isPaid ? "نعم" : "لا"),
      cell: (r) => <StatusBadge tone={r.isPaid ? "success" : "neutral"}>{r.isPaid ? "مدفوعة" : "غير مدفوعة"}</StatusBadge>,
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
      emptyTitle={`لا توجد عطل مسجّلة لعام ${year}`}
    />
  );
}
