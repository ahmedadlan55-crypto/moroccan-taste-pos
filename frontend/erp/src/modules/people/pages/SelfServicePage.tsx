import { useQuery } from "@tanstack/react-query";
import { Card, DetailStat, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta } from "../lib/labels";
import type { MyAttendanceRow, MyLeaveBalance, MyLeaveRequestRow } from "../lib/types";

export function SelfServicePage() {
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
    { id: "attendance_date", header: "التاريخ", accessor: (r) => r.attendance_date, cell: (r) => formatDate(r.attendance_date), sortable: true },
    { id: "clock_in", header: "الدخول", accessor: (r) => (r.clock_in ? String(r.clock_in).slice(11, 16) || String(r.clock_in) : "—") },
    { id: "clock_out", header: "الخروج", accessor: (r) => (r.clock_out ? String(r.clock_out).slice(11, 16) || String(r.clock_out) : "—") },
    { id: "total_hours", header: "الساعات", accessor: (r) => r.total_hours ?? 0, cell: (r) => formatNumber(r.total_hours ?? 0), numeric: true },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status ?? "",
      cell: (r) => {
        const m = statusMeta(r.status);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
  ];

  const requestColumns: ColumnDef<MyLeaveRequestRow>[] = [
    { id: "leaveTypeName", header: "النوع", accessor: (r) => r.leaveTypeName || "—" },
    { id: "start_date", header: "من", accessor: (r) => r.start_date, cell: (r) => formatDate(r.start_date), sortable: true },
    { id: "end_date", header: "إلى", accessor: (r) => r.end_date, cell: (r) => formatDate(r.end_date) },
    { id: "days_count", header: "الأيام", accessor: (r) => r.days_count ?? 0, numeric: true },
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
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الخدمة الذاتية"
        subtitle="ملفك الوظيفي وأرصدة إجازاتك وسجل حضورك (عرض فقط)."
      />

      {profile.isLoading && <LoadingState rows={2} />}
      {profile.error && <ErrorState error={profile.error} onRetry={() => profile.refetch()} />}

      {profile.data && (
        <Card className="p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DetailStat label="الاسم" value={String(profile.data.fullName ?? "—")} />
            <DetailStat label="الرقم الوظيفي" value={String(profile.data.employee_number ?? "—")} />
            <DetailStat label="القسم" value={String(profile.data.departmentName ?? "—")} />
            <DetailStat label="الفرع" value={String(profile.data.branchName ?? "—")} />
            <DetailStat label="المسمى" value={String(profile.data.job_title ?? "—")} />
            <DetailStat label="الحالة" value={statusMeta(profile.data.status as string).label} />
            <DetailStat label="تاريخ التعيين" value={formatDate(profile.data.hire_date as string)} />
            <DetailStat label="الراتب الأساسي" value={formatCurrency(Number(profile.data.basic_salary) || 0)} />
          </div>
        </Card>
      )}

      {balances.data && balances.data.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-extrabold text-slate-900">أرصدة الإجازات</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {balances.data.map((b: MyLeaveBalance) => (
              <Card key={b.id} className="p-4 text-center">
                <div className="text-xs font-bold text-slate-500">{b.leaveTypeName || "إجازة"}</div>
                <div className="mt-1 text-2xl font-extrabold tabular-nums text-teal-700">{formatNumber(b.remaining_days ?? 0)}</div>
                <div className="text-[11px] font-medium text-slate-400">من {formatNumber(b.total_days ?? 0)} يوم</div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-base font-extrabold text-slate-900">حضوري هذا الشهر</h2>
        <DataTable
          columns={attendanceColumns}
          rows={attendance.data ?? []}
          getRowId={(r) => r.id}
          loading={attendance.isLoading}
          error={attendance.error}
          onRetry={() => attendance.refetch()}
          tableId="people.myAttendance"
          initialPageSize={10}
          emptyTitle="لا توجد سجلات حضور هذا الشهر"
        />
      </section>

      <section>
        <h2 className="mb-3 text-base font-extrabold text-slate-900">طلبات إجازتي</h2>
        <DataTable
          columns={requestColumns}
          rows={requests.data ?? []}
          getRowId={(r) => r.id}
          loading={requests.isLoading}
          error={requests.error}
          onRetry={() => requests.refetch()}
          tableId="people.myLeaveRequests"
          initialPageSize={10}
          emptyTitle="لا توجد طلبات إجازة"
        />
      </section>
    </div>
  );
}
