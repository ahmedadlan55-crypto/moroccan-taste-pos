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
import { useTx } from "@/shared/ui/i18n";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta, weekdayLabels } from "../lib/labels";
import type { OvertimeEntry, OvertimeRule, Shift, ShiftInput } from "../lib/types";
import { ShiftForm } from "../components/ShiftForm";

type TabKey = "shifts" | "overtime" | "rules";

export function ShiftsPage() {
  const t = useTx();
  const [tab, setTab] = useState<TabKey>("shifts");
  const TABS = [
    { value: "shifts", label: t("people.shifts.tabs.shifts") },
    { value: "overtime", label: t("people.shifts.tabs.overtime") },
    { value: "rules", label: t("people.shifts.tabs.rules") },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.shifts.title")}
        subtitle={t("people.shifts.subtitle")}
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label={t("people.shifts.tabsAria")} />
      {tab === "shifts" && <ShiftsTab />}
      {tab === "overtime" && <OvertimeTab />}
      {tab === "rules" && <OvertimeRulesTab />}
    </div>
  );
}

function ShiftsTab() {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<{ open: boolean; shift: Shift | null }>({ open: false, shift: null });
  const [toDelete, setToDelete] = useState<Shift | null>(null);

  const query = useQuery({ queryKey: qk.shifts(), queryFn: ({ signal }) => peopleApi.listShifts(signal) });
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.shifts() });

  const save = useMutation({
    mutationFn: (body: ShiftInput) => peopleApi.saveShift(body),
    onSuccess: () => {
      toast({ title: t("people.toast.saved"), tone: "success" });
      setDrawer({ open: false, shift: null });
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.saveFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => peopleApi.deleteShift(id),
    onSuccess: () => {
      toast({ title: t("people.toast.deleted"), tone: "success" });
      setToDelete(null);
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.deleteFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const columns: ColumnDef<Shift>[] = [
    { id: "name", header: t("people.shifts.col.name"), accessor: (r) => r.name, sortable: true },
    { id: "code", header: t("people.field.code"), accessor: (r) => r.code || "—" },
    { id: "startTime", header: t("people.field.from"), accessor: (r) => (r.startTime || "").slice(0, 5) },
    { id: "endTime", header: t("people.field.to"), accessor: (r) => (r.endTime || "").slice(0, 5) },
    { id: "breakMinutes", header: t("people.shifts.col.break"), accessor: (r) => r.breakMinutes, numeric: true },
    { id: "workDays", header: t("people.shifts.col.workDays"), accessor: (r) => weekdayLabels(r.workDays, t) },
    {
      id: "isDefault",
      header: t("people.shifts.col.isDefault"),
      accessor: (r) => (r.isDefault ? t("people.bool.yes") : "—"),
      cell: (r) => (r.isDefault ? <Badge tone="teal">{t("people.shifts.col.defaultBadge")}</Badge> : <span className="text-slate-400">—</span>),
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
        emptyTitle={t("people.shifts.emptyTitle")}
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer({ open: true, shift: null })}>
            <Plus className="h-4 w-4" /> {t("people.shifts.newBtn")}
          </Button>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label={t("common.edit")} size="sm" variant="ghost" onClick={() => setDrawer({ open: true, shift: r })}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label={t("common.delete")} size="sm" variant="danger" onClick={() => setToDelete(r)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Drawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, shift: null })}
        title={drawer.shift ? t("people.shifts.editTitle", { name: drawer.shift.name }) : t("people.shifts.newBtn")}
        eyebrow={t("people.shifts.drawerEyebrow")}
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
        title={t("people.shifts.deleteTitle")}
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
  const t = useTx();
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
      toast({ title: t("people.toast.done"), tone: "success" });
      setConfirm(null);
      qc.invalidateQueries({ queryKey: [...qk.all, "overtime-entries"] });
    },
    onError: (e) => toast({ title: t("people.toast.actionFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const columns: ColumnDef<OvertimeEntry>[] = [
    { id: "employeeName", header: t("people.field.employee"), accessor: (r) => r.employeeName, sortable: true },
    { id: "entryDate", header: t("people.field.date"), accessor: (r) => r.entryDate, cell: (r) => formatDate(r.entryDate), sortable: true },
    { id: "minutes", header: t("people.overtime.col.minutes"), accessor: (r) => r.minutes, numeric: true, sortable: true },
    { id: "multiplier", header: t("people.overtime.col.multiplier"), accessor: (r) => r.multiplier, cell: (r) => `×${formatNumber(r.multiplier)}`, numeric: true },
    { id: "amount", header: t("people.field.amount"), accessor: (r) => r.amount, cell: (r) => formatCurrency(r.amount), numeric: true },
    { id: "ruleName", header: t("people.overtime.col.rule"), accessor: (r) => r.ruleName || "—" },
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
        emptyTitle={t("people.overtime.emptyTitle")}
        exportFilename="overtime.csv"
        filterBar={
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
            {t("common.status")}
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 min-w-36"
              options={[
                { value: "", label: t("common.all") },
                { value: "pending", label: t("people.overtime.filter.pending") },
                { value: "approved", label: t("people.overtime.filter.approved") },
                { value: "rejected", label: t("people.overtime.filter.rejected") },
              ]}
            />
          </label>
        }
        rowActions={(r) =>
          r.status === "pending" ? (
            <div className="flex items-center gap-1">
              <IconButton aria-label={t("people.advances.aria.approve")} size="sm" variant="ghost" onClick={() => setConfirm({ kind: "approve", entry: r })}>
                <Check className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label={t("people.advances.aria.reject")} size="sm" variant="danger" onClick={() => setConfirm({ kind: "reject", entry: r })}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "approve" ? t("people.overtime.confirm.approveTitle") : t("people.overtime.confirm.rejectTitle")}
        description={confirm ? confirm.entry.employeeName : ""}
        tone={confirm?.kind === "reject" ? "danger" : "primary"}
        requireReason={confirm?.kind === "reject"}
        reasonLabel={t("people.overtime.rejectReasonLabel")}
        processing={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && act.mutate({ kind: confirm.kind, id: confirm.entry.id, reason })}
      />
    </>
  );
}

function OvertimeRulesTab() {
  const t = useTx();
  const query = useQuery({ queryKey: qk.overtimeRules(), queryFn: ({ signal }) => peopleApi.listOvertimeRules(signal) });

  const columns: ColumnDef<OvertimeRule>[] = [
    { id: "name", header: t("people.overtimeRules.col.rule"), accessor: (r) => r.name, sortable: true },
    { id: "dayType", header: t("people.overtimeRules.col.dayType"), accessor: (r) => r.dayType },
    { id: "multiplier", header: t("people.overtime.col.multiplier"), accessor: (r) => r.multiplier, cell: (r) => `×${formatNumber(r.multiplier)}`, numeric: true },
    { id: "minMinutes", header: t("people.overtimeRules.col.minMinutes"), accessor: (r) => r.minMinutes, numeric: true },
    {
      id: "requireApproval",
      header: t("people.overtimeRules.col.requireApproval"),
      accessor: (r) => (r.requireApproval ? t("people.bool.yes") : t("common.no")),
      cell: (r) => <Badge tone={r.requireApproval ? "warning" : "neutral"}>{r.requireApproval ? t("people.bool.yes") : t("common.no")}</Badge>,
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
      emptyTitle={t("people.overtimeRules.emptyTitle")}
    />
  );
}
