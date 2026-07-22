import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, Card, DetailStat, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta } from "../lib/labels";
import { ClockCard } from "../components/ClockCard";
import { MyLeaveRequestDialog } from "../components/MyLeaveRequestDialog";
import type { MyAttendanceRow, MyLeaveBalance, MyLeaveRequestRow } from "../lib/types";

export function SelfServicePage() {
  const t = useTx();
  const [leaveDialog, setLeaveDialog] = useState(false);
  const profile = useQuery({ queryKey: qk.myProfile(), queryFn: ({ signal }) => peopleApi.myProfile(signal) });
  const balances = useQuery({
    queryKey: qk.myLeaveBalances(),
    queryFn: ({ signal }) => peopleApi.myLeaveBalances(signal),
  });
  const attendance = useQuery({
    queryKey: qk.myAttendance({}),
    queryFn: ({ signal }) => peopleApi.myAttendance({}, signal),
  });
  const requests = useQuery({
    queryKey: qk.myLeaveRequests(),
    queryFn: ({ signal }) => peopleApi.myLeaveRequests(signal),
  });

  const attendanceColumns: ColumnDef<MyAttendanceRow>[] = [
    { id: "attendance_date", header: t("people.field.date"), accessor: (r) => r.attendance_date, cell: (r) => formatDate(r.attendance_date), sortable: true },
    { id: "clock_in", header: t("people.selfService.col.clockIn"), accessor: (r) => (r.clock_in ? String(r.clock_in).slice(11, 16) || String(r.clock_in) : "—") },
    { id: "clock_out", header: t("people.selfService.col.clockOut"), accessor: (r) => (r.clock_out ? String(r.clock_out).slice(11, 16) || String(r.clock_out) : "—") },
    { id: "total_hours", header: t("people.selfService.col.hours"), accessor: (r) => r.total_hours ?? 0, cell: (r) => formatNumber(r.total_hours ?? 0), numeric: true },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status ?? "",
      cell: (r) => {
        const m = statusMeta(r.status, t);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  const requestColumns: ColumnDef<MyLeaveRequestRow>[] = [
    { id: "leaveTypeName", header: t("people.field.type"), accessor: (r) => r.leaveTypeName || "—" },
    { id: "start_date", header: t("people.field.from"), accessor: (r) => r.start_date, cell: (r) => formatDate(r.start_date), sortable: true },
    { id: "end_date", header: t("people.field.to"), accessor: (r) => r.end_date, cell: (r) => formatDate(r.end_date) },
    { id: "days_count", header: t("people.field.days"), accessor: (r) => r.days_count ?? 0, numeric: true },
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
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.selfService.title")}
        subtitle={t("people.selfService.subtitle")}
      />

      {/* حضور/انصراف — the legacy PWA clock, now a first-class card here. */}
      <ClockCard rows={attendance.data ?? []} />

      {profile.isLoading && <LoadingState rows={2} />}
      {profile.error && <ErrorState error={profile.error} onRetry={() => profile.refetch()} />}

      {profile.data && (
        <Card className="p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DetailStat label={t("people.field.name")} value={String(profile.data.fullName ?? "—")} />
            <DetailStat label={t("people.field.empNumber")} value={String(profile.data.employee_number ?? "—")} />
            <DetailStat label={t("people.field.department")} value={String(profile.data.departmentName ?? "—")} />
            <DetailStat label={t("people.field.branch")} value={String(profile.data.branchName ?? "—")} />
            <DetailStat label={t("people.field.jobTitle")} value={String(profile.data.job_title ?? "—")} />
            <DetailStat label={t("common.status")} value={statusMeta(profile.data.status as string, t).label} />
            <DetailStat label={t("people.field.hireDate")} value={formatDate(profile.data.hire_date as string)} />
            <DetailStat label={t("people.field.basicSalary")} value={formatCurrency(Number(profile.data.basic_salary) || 0)} />
          </div>
        </Card>
      )}

      {balances.data && balances.data.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-extrabold text-slate-900">{t("people.selfService.balancesTitle")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {balances.data.map((b: MyLeaveBalance) => (
              <Card key={b.id} className="p-4 text-center">
                <div className="text-xs font-bold text-slate-500">{b.leaveTypeName || t("people.selfService.leaveFallback")}</div>
                <div className="mt-1 text-2xl font-extrabold tabular-nums text-teal-700">{formatNumber(b.remaining_days ?? 0)}</div>
                <div className="text-[11px] font-medium text-slate-400">{t("people.selfService.balanceOf", { total: formatNumber(b.total_days ?? 0) })}</div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-base font-extrabold text-slate-900">{t("people.selfService.attendanceTitle")}</h2>
        <DataTable
          columns={attendanceColumns}
          rows={attendance.data ?? []}
          getRowId={(r) => r.id}
          loading={attendance.isLoading}
          error={attendance.error}
          onRetry={() => attendance.refetch()}
          tableId="people.myAttendance"
          initialPageSize={10}
          emptyTitle={t("people.selfService.attendanceEmpty")}
        />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-extrabold text-slate-900">{t("people.selfService.requestsTitle")}</h2>
          <Button variant="primary" size="sm" onClick={() => setLeaveDialog(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("people.selfService.requestBtn")}
          </Button>
        </div>
        <DataTable
          columns={requestColumns}
          rows={requests.data ?? []}
          getRowId={(r) => r.id}
          loading={requests.isLoading}
          error={requests.error}
          onRetry={() => requests.refetch()}
          tableId="people.myLeaveRequests"
          initialPageSize={10}
          emptyTitle={t("people.selfService.requestsEmpty")}
        />
      </section>

      <MyLeaveRequestDialog open={leaveDialog} onClose={() => setLeaveDialog(false)} />
    </div>
  );
}
