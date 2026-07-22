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
import { useTx } from "@/shared/ui/i18n";
import { useAuth } from "@/app/providers";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { statusMeta } from "../lib/labels";
import type { LeaveRequest, LeaveType } from "../lib/types";
import { LeaveRequestForm, type LeaveFormValues } from "../components/LeaveRequestForm";

type TabKey = "requests" | "types";

export function LeavesPage() {
  const t = useTx();
  const [tab, setTab] = useState<TabKey>("requests");
  const TABS = [
    { value: "requests", label: t("people.leaves.tabs.requests") },
    { value: "types", label: t("people.leaves.tabs.types") },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.leaves.title")}
        subtitle={t("people.leaves.subtitle")}
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label={t("people.leaves.tabsAria")} />
      {tab === "requests" && <RequestsTab />}
      {tab === "types" && <TypesTab />}
    </div>
  );
}

type Confirm = { kind: "approve" | "reject"; req: LeaveRequest } | null;

function RequestsTab() {
  const t = useTx();
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
        title: t("people.leaves.sent"),
        description: res.warning || undefined,
        tone: res.warning ? "warning" : "success",
      });
      setDrawer(false);
      invalidate();
    },
    onError: (e) => toast({ title: t("people.leaves.sendFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const act = useMutation({
    mutationFn: (v: { kind: NonNullable<Confirm>["kind"]; id: string; reason: string }) =>
      v.kind === "approve"
        ? peopleApi.approveLeave(v.id, user?.username ?? "", "hr")
        : peopleApi.rejectLeave(v.id, user?.username ?? "", v.reason),
    onSuccess: () => {
      toast({ title: t("people.toast.done"), tone: "success" });
      setConfirm(null);
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.actionFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const columns: ColumnDef<LeaveRequest>[] = [
    { id: "employeeName", header: t("people.field.employee"), accessor: (r) => r.employeeName, sortable: true },
    { id: "leaveTypeName", header: t("people.field.type"), accessor: (r) => r.leaveTypeName || "—" },
    { id: "startDate", header: t("people.field.from"), accessor: (r) => r.startDate, cell: (r) => formatDate(r.startDate), sortable: true },
    { id: "endDate", header: t("people.field.to"), accessor: (r) => r.endDate, cell: (r) => formatDate(r.endDate) },
    { id: "daysCount", header: t("people.field.days"), accessor: (r) => r.daysCount, numeric: true, sortable: true },
    {
      id: "leaveTypePaid",
      header: t("people.leaves.col.paid"),
      accessor: (r) => (r.leaveTypePaid ? t("people.bool.yes") : t("common.no")),
      cell: (r) => <Badge tone={r.leaveTypePaid ? "success" : "neutral"}>{r.leaveTypePaid ? t("people.bool.paid") : t("people.bool.unpaid")}</Badge>,
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
        searchPlaceholder={t("people.leaves.searchPlaceholder")}
        emptyTitle={t("people.leaves.emptyTitle")}
        exportFilename="leave-requests.csv"
        filterBar={
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
            {t("common.status")}
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 min-w-36"
              options={[
                { value: "", label: t("common.all") },
                { value: "pending", label: t("people.leaves.filter.pending") },
                { value: "hr_approved", label: t("people.leaves.filter.approved") },
                { value: "rejected", label: t("people.leaves.filter.rejected") },
              ]}
            />
          </label>
        }
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer(true)}>
            <Plus className="h-4 w-4" /> {t("people.leaves.newBtn")}
          </Button>
        }
        rowActions={(r) =>
          pending(r) ? (
            <div className="flex items-center gap-1">
              <IconButton aria-label={t("people.advances.aria.approve")} size="sm" variant="ghost" onClick={() => setConfirm({ kind: "approve", req: r })}>
                <Check className="h-4 w-4" />
              </IconButton>
              <IconButton aria-label={t("people.advances.aria.reject")} size="sm" variant="danger" onClick={() => setConfirm({ kind: "reject", req: r })}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          ) : null
        }
      />

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={t("people.leaves.newDrawerTitle")} eyebrow={t("people.leaves.drawerEyebrow")}>
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
        title={confirm?.kind === "approve" ? t("people.leaves.confirm.approveTitle") : t("people.leaves.confirm.rejectTitle")}
        description={confirm ? t("people.leaves.confirm.desc", { name: confirm.req.employeeName, days: confirm.req.daysCount }) : ""}
        tone={confirm?.kind === "reject" ? "danger" : "primary"}
        requireReason={confirm?.kind === "reject"}
        reasonLabel={t("people.leaves.rejectReasonLabel")}
        processing={act.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && act.mutate({ kind: confirm.kind, id: confirm.req.id, reason })}
      />
    </>
  );
}

function TypesTab() {
  const t = useTx();
  const query = useQuery({ queryKey: qk.leaveTypes(), queryFn: ({ signal }) => peopleApi.listLeaveTypes(signal) });

  const columns: ColumnDef<LeaveType>[] = [
    { id: "name", header: t("people.field.type"), accessor: (r) => r.name, sortable: true },
    { id: "nameEn", header: t("people.field.nameEn"), accessor: (r) => r.nameEn || "—" },
    { id: "defaultDays", header: t("people.leaveTypes.col.defaultDays"), accessor: (r) => r.defaultDays, numeric: true, sortable: true },
    {
      id: "isPaid",
      header: t("people.leaves.col.paid"),
      accessor: (r) => (r.isPaid ? t("people.bool.yes") : t("common.no")),
      cell: (r) => <StatusBadge tone={r.isPaid ? "success" : "neutral"}>{r.isPaid ? t("people.bool.paid") : t("people.bool.unpaid")}</StatusBadge>,
    },
    {
      id: "isActive",
      header: t("common.status"),
      accessor: (r) => (r.isActive ? t("people.bool.enabled") : t("people.bool.disabled")),
      cell: (r) => <Badge tone={r.isActive ? "teal" : "neutral"}>{r.isActive ? t("people.bool.enabled") : t("people.bool.disabled")}</Badge>,
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
      emptyTitle={t("people.leaveTypes.emptyTitle")}
    />
  );
}
