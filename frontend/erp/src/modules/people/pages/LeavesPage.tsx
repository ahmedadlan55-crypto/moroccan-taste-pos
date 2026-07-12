import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  IconButton,
  PageHeader,
  Select,
  StatusBadge,
  Tabs,
  safeUserMessage,
  useToast,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatDate } from "@/shared/lib";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta } from "../lib/labels";
import type { LeaveRequest, LeaveType } from "../lib/types";
import { LeaveRequestForm, type LeaveFormValues } from "../components/LeaveRequestForm";

type TabKey = "requests" | "types";

const TABS = [
  { value: "requests", label: "طلبات الإجازة" },
  { value: "types", label: "أنواع الإجازات" },
];

export function LeavesPage() {
  const [tab, setTab] = useState<TabKey>("requests");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الإجازات"
        subtitle="طلبات الإجازة واعتمادها وأنواع الإجازات المعتمدة."
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label="أقسام الإجازات" />
      {tab === "requests" && <RequestsTab />}
      {tab === "types" && <TypesTab />}
    </div>
  );
}

type Confirm = { kind: "approve" | "reject"; req: LeaveRequest } | null;

function RequestsTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({
    queryKey: qk.leaveRequests(params),
    queryFn: ({ signal }) => peopleApi.listLeaveRequests(params, signal),
  });
  const employees = useQuery({
    queryKey: qk.employees({ status: "active" }),
    queryFn: ({ signal }) => peopleApi.listEmployees({ status: "active" }, signal),
    enabled: drawer,
  });
  const leaveTypes = useQuery({
    queryKey: qk.leaveTypes(),
    queryFn: ({ signal }) => peopleApi.listLeaveTypes(signal),
    enabled: drawer,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: [...qk.all, "leave-requests"] });

  const create = useMutation({
    mutationFn: (v: LeaveFormValues) =>
      peopleApi.createLeaveRequest({
        employeeId: v.employeeId,
        leaveTypeId: v.leaveTypeId,
        startDate: v.startDate,
        endDate: v.endDate,
        reason: v.reason,
      }),
    onSuccess: (res) => {
      toast({
        title: "تم إرسال الطلب",
        description: res.warning || undefined,
        tone: res.warning ? "warning" : "success",
      });
      setDrawer(false);
      invalidate();
    },
    onError: (e) => toast({ title: "تعذّر إرسال الطلب", description: safeUserMessage(e), tone: "error" }),
  });

  const act = useMutation({
    mutationFn: (v: { kind: NonNullable<Confirm>["kind"]; id: string; reason: string }) =>
      v.kind === "approve"
        ? peopleApi.approveLeave(v.id, user?.username ?? "", "hr")
        : peopleApi.rejectLeave(v.id, user?.username ?? "", v.reason),
    onSuccess: () => {
      toast({ title: "تم تنفيذ العملية", tone: "success" });
      setConfirm(null);
      invalidate();
    },
    onError: (e) => toast({ title: "تعذّر تنفيذ العملية", description: safeUserMessage(e), tone: "error" }),
  });

  const columns: ColumnDef<LeaveRequest>[] = [
    { id: "employeeName", header: "الموظف", accessor: (r) => r.employeeName, sortable: true },
    { id: "leaveTypeName", header: "النوع", accessor: (r) => r.leaveTypeName || "—" },
    { id: "startDate", header: "من", accessor: (r) => r.startDate, cell: (r) => formatDate(r.startDate), sortable: true },
    { id: "endDate", header: "إلى", accessor: (r) => r.endDate, cell: (r) => formatDate(r.endDate) },
    { id: "daysCount", header: "الأيام", accessor: (r) => r.daysCount, numeric: true, sortable: true },
    {
      id: "leaveTypePaid",
      header: "مدفوعة",
      accessor: (r) => (r.leaveTypePaid ? "نعم" : "لا"),
      cell: (r) => <Badge tone={r.leaveTypePaid ? "success" : "neutral"}>{r.leaveTypePaid ? "مدفوعة" : "غير مدفوعة"}</Badge>,
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

  const pending = (r: LeaveRequest) => r.status === "pending" || r.status === "branch_approved";

  return (
    <>
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.leaveRequests"
        searchable
        searchPlaceholder="بحث باسم الموظف…"
        emptyTitle="لا توجد طلبات إجازة"
        exportFilename="leave-requests.csv"
        filterBar={
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
            الحالة
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 min-w-36"
              options={[
                { value: "", label: "الكل" },
                { value: "pending", label: "قيد الاعتماد" },
                { value: "hr_approved", label: "معتمدة" },
                { value: "rejected", label: "مرفوضة" },
              ]}
            />
          </label>
        }
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer(true)}>
            <Plus className="h-4 w-4" /> طلب إجازة
          </Button>
        }
        rowActions={(r) =>
          pending(r) ? (
            <div className="flex items-center gap-1">
              <IconButton aria-label="اعتماد" size="sm" variant="ghost" onClick={() => setConfirm({ kind: "approve", req: r })}>
                <Check className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label="رفض" size="sm" variant="danger" onClick={() => setConfirm({ kind: "reject", req: r })}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          ) : null
        }
      />

      <Drawer open={drawer} onClose={() => setDrawer(false)} title="طلب إجازة جديد" eyebrow="الإجازات">
        <LeaveRequestForm
          employees={employees.data ?? []}
          leaveTypes={leaveTypes.data ?? []}
          submitting={create.isPending}
          onCancel={() => setDrawer(false)}
          onSubmit={(v) => create.mutate(v)}
        />
      </Drawer>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "approve" ? "اعتماد طلب الإجازة؟" : "رفض طلب الإجازة؟"}
        description={confirm ? `${confirm.req.employeeName} — ${confirm.req.daysCount} يوم` : ""}
        tone={confirm?.kind === "reject" ? "danger" : "primary"}
        requireReason={confirm?.kind === "reject"}
        reasonLabel="سبب الرفض"
        processing={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && act.mutate({ kind: confirm.kind, id: confirm.req.id, reason })}
      />
    </>
  );
}

function TypesTab() {
  const query = useQuery({ queryKey: qk.leaveTypes(), queryFn: ({ signal }) => peopleApi.listLeaveTypes(signal) });

  const columns: ColumnDef<LeaveType>[] = [
    { id: "name", header: "النوع", accessor: (r) => r.name, sortable: true },
    { id: "nameEn", header: "بالإنجليزية", accessor: (r) => r.nameEn || "—" },
    { id: "defaultDays", header: "الأيام الافتراضية", accessor: (r) => r.defaultDays, numeric: true, sortable: true },
    {
      id: "isPaid",
      header: "مدفوعة",
      accessor: (r) => (r.isPaid ? "نعم" : "لا"),
      cell: (r) => <StatusBadge tone={r.isPaid ? "success" : "neutral"}>{r.isPaid ? "مدفوعة" : "غير مدفوعة"}</StatusBadge>,
    },
    {
      id: "isActive",
      header: "الحالة",
      accessor: (r) => (r.isActive ? "فعّال" : "معطّل"),
      cell: (r) => <Badge tone={r.isActive ? "teal" : "neutral"}>{r.isActive ? "فعّال" : "معطّل"}</Badge>,
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
      tableId="people.leaveTypes"
      emptyTitle="لا توجد أنواع إجازات"
    />
  );
}
