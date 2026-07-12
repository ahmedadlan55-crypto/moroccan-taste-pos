import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
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
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta, weekdayLabels } from "../lib/labels";
import type { OvertimeEntry, OvertimeRule, Shift, ShiftInput } from "../lib/types";
import { ShiftForm } from "../components/ShiftForm";

type TabKey = "shifts" | "overtime" | "rules";

const TABS = [
  { value: "shifts", label: "الورديات" },
  { value: "overtime", label: "ساعات العمل الإضافي" },
  { value: "rules", label: "قواعد الإضافي" },
];

export function ShiftsPage() {
  const [tab, setTab] = useState<TabKey>("shifts");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الورديات"
        subtitle="ورديات الدوام وساعات العمل الإضافي وقواعد احتسابه."
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label="أقسام الورديات" />
      {tab === "shifts" && <ShiftsTab />}
      {tab === "overtime" && <OvertimeTab />}
      {tab === "rules" && <OvertimeRulesTab />}
    </div>
  );
}

function ShiftsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<{ open: boolean; shift: Shift | null }>({ open: false, shift: null });
  const [toDelete, setToDelete] = useState<Shift | null>(null);

  const query = useQuery({ queryKey: qk.shifts(), queryFn: ({ signal }) => peopleApi.listShifts(signal) });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.shifts() });

  const save = useMutation({
    mutationFn: (body: ShiftInput) => peopleApi.saveShift(body),
    onSuccess: () => {
      toast({ title: "تم الحفظ", tone: "success" });
      setDrawer({ open: false, shift: null });
      invalidate();
    },
    onError: (e) => toast({ title: "تعذّر الحفظ", description: safeUserMessage(e), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => peopleApi.deleteShift(id),
    onSuccess: () => {
      toast({ title: "تم الحذف", tone: "success" });
      setToDelete(null);
      invalidate();
    },
    onError: (e) => toast({ title: "تعذّر الحذف", description: safeUserMessage(e), tone: "error" }),
  });

  const columns: ColumnDef<Shift>[] = [
    { id: "name", header: "الوردية", accessor: (r) => r.name, sortable: true },
    { id: "code", header: "الرمز", accessor: (r) => r.code || "—" },
    { id: "startTime", header: "من", accessor: (r) => (r.startTime || "").slice(0, 5) },
    { id: "endTime", header: "إلى", accessor: (r) => (r.endTime || "").slice(0, 5) },
    { id: "breakMinutes", header: "راحة (د)", accessor: (r) => r.breakMinutes, numeric: true },
    { id: "workDays", header: "أيام العمل", accessor: (r) => weekdayLabels(r.workDays) },
    {
      id: "isDefault",
      header: "الافتراضية",
      accessor: (r) => (r.isDefault ? "نعم" : "—"),
      cell: (r) => (r.isDefault ? <Badge tone="teal">افتراضية</Badge> : <span className="text-slate-400">—</span>),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.shifts"
        searchable
        emptyTitle="لا توجد ورديات"
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer({ open: true, shift: null })}>
            <Plus className="h-4 w-4" /> وردية جديدة
          </Button>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label="تعديل" size="sm" variant="ghost" onClick={() => setDrawer({ open: true, shift: r })}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label="حذف" size="sm" variant="danger" onClick={() => setToDelete(r)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Drawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, shift: null })}
        title={drawer.shift ? `تعديل: ${drawer.shift.name}` : "وردية جديدة"}
        eyebrow="الورديات"
      >
        <ShiftForm
          shift={drawer.shift}
          submitting={save.isPending}
          onCancel={() => setDrawer({ open: false, shift: null })}
          onSubmit={(body) => save.mutate(body)}
        />
      </Drawer>

      <ConfirmDialog
        open={!!toDelete}
        title="حذف الوردية؟"
        description={toDelete ? toDelete.name : ""}
        tone="danger"
        processing={remove.isPending}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </>
  );
}

type Confirm = { kind: "approve" | "reject"; entry: OvertimeEntry } | null;

function OvertimeTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);

  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({
    queryKey: qk.overtimeEntries(params),
    queryFn: ({ signal }) => peopleApi.listOvertimeEntries(params, signal),
  });

  const act = useMutation({
    mutationFn: (v: { kind: NonNullable<Confirm>["kind"]; id: string; reason: string }) =>
      v.kind === "approve"
        ? peopleApi.approveOvertime(v.id, user?.username ?? "")
        : peopleApi.rejectOvertime(v.id, user?.username ?? "", v.reason),
    onSuccess: () => {
      toast({ title: "تم تنفيذ العملية", tone: "success" });
      setConfirm(null);
      qc.invalidateQueries({ queryKey: [...qk.all, "overtime-entries"] });
    },
    onError: (e) => toast({ title: "تعذّر تنفيذ العملية", description: safeUserMessage(e), tone: "error" }),
  });

  const columns: ColumnDef<OvertimeEntry>[] = [
    { id: "employeeName", header: "الموظف", accessor: (r) => r.employeeName, sortable: true },
    { id: "entryDate", header: "التاريخ", accessor: (r) => r.entryDate, cell: (r) => formatDate(r.entryDate), sortable: true },
    { id: "minutes", header: "الدقائق", accessor: (r) => r.minutes, numeric: true, sortable: true },
    { id: "multiplier", header: "المعامل", accessor: (r) => r.multiplier, cell: (r) => `×${formatNumber(r.multiplier)}`, numeric: true },
    { id: "amount", header: "المبلغ", accessor: (r) => r.amount, cell: (r) => formatCurrency(r.amount), numeric: true },
    { id: "ruleName", header: "القاعدة", accessor: (r) => r.ruleName || "—" },
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
    <>
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.overtime"
        searchable
        emptyTitle="لا توجد ساعات إضافية"
        exportFilename="overtime.csv"
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
                { value: "approved", label: "معتمدة" },
                { value: "rejected", label: "مرفوضة" },
              ]}
            />
          </label>
        }
        rowActions={(r) =>
          r.status === "pending" ? (
            <div className="flex items-center gap-1">
              <IconButton aria-label="اعتماد" size="sm" variant="ghost" onClick={() => setConfirm({ kind: "approve", entry: r })}>
                <Check className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label="رفض" size="sm" variant="danger" onClick={() => setConfirm({ kind: "reject", entry: r })}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "approve" ? "اعتماد ساعات الإضافي؟" : "رفض ساعات الإضافي؟"}
        description={confirm ? confirm.entry.employeeName : ""}
        tone={confirm?.kind === "reject" ? "danger" : "primary"}
        requireReason={confirm?.kind === "reject"}
        reasonLabel="سبب الرفض"
        processing={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && act.mutate({ kind: confirm.kind, id: confirm.entry.id, reason })}
      />
    </>
  );
}

function OvertimeRulesTab() {
  const query = useQuery({ queryKey: qk.overtimeRules(), queryFn: ({ signal }) => peopleApi.listOvertimeRules(signal) });

  const columns: ColumnDef<OvertimeRule>[] = [
    { id: "name", header: "القاعدة", accessor: (r) => r.name, sortable: true },
    { id: "dayType", header: "نوع اليوم", accessor: (r) => r.dayType },
    { id: "multiplier", header: "المعامل", accessor: (r) => r.multiplier, cell: (r) => `×${formatNumber(r.multiplier)}`, numeric: true },
    { id: "minMinutes", header: "أدنى دقائق", accessor: (r) => r.minMinutes, numeric: true },
    {
      id: "requireApproval",
      header: "يتطلب اعتماد",
      accessor: (r) => (r.requireApproval ? "نعم" : "لا"),
      cell: (r) => <Badge tone={r.requireApproval ? "warning" : "neutral"}>{r.requireApproval ? "نعم" : "لا"}</Badge>,
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
      tableId="people.overtimeRules"
      emptyTitle="لا توجد قواعد إضافي"
    />
  );
}
