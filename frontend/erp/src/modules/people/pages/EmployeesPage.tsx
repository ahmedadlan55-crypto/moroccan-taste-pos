import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, PauseCircle, PlayCircle, Plus, Trash2, UserX } from "lucide-react";
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
import { formatCurrency } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";
import type { TFunction } from "@/i18n";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { employmentTypeLabel, statusMeta } from "../lib/labels";
import type { Department, Employee, EmployeeDetail, EmployeeInput, JobTitle } from "../lib/types";
import { EmployeeForm } from "../components/EmployeeForm";
import { DepartmentForm } from "../components/DepartmentForm";
import { AdvancesTab } from "./tabs/AdvancesTab";

type TabKey = "employees" | "departments" | "job-titles" | "advances";

export function EmployeesPage() {
  const t = useTx();
  const [tab, setTab] = useState<TabKey>("employees");

  const TABS = [
    { value: "employees", label: t("people.employees.tabs.employees") },
    { value: "departments", label: t("people.employees.tabs.departments") },
    { value: "job-titles", label: t("people.employees.tabs.jobTitles") },
    { value: "advances", label: t("people.employees.tabs.advances") },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.employees.title")}
        subtitle={t("people.employees.subtitle")}
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label={t("people.employees.tabsAria")} />
      {tab === "employees" && <EmployeesTab />}
      {tab === "departments" && <DepartmentsTab />}
      {tab === "job-titles" && <JobTitlesTab />}
      {tab === "advances" && <AdvancesTab />}
    </div>
  );
}

// ── Employees tab ────────────────────────────────────────────────────────────
type Confirm = { kind: "suspend" | "activate" | "terminate" | "delete"; emp: Employee } | null;

function EmployeesTab() {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [drawer, setDrawer] = useState<{ open: boolean; employee: EmployeeDetail | null }>({
    open: false,
    employee: null,
  });
  const [confirm, setConfirm] = useState<Confirm>(null);

  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({
    queryKey: qk.employees(params),
    queryFn: ({ signal }) => peopleApi.listEmployees(params, signal),
  });
  const departments = useQuery({
    queryKey: qk.departments(),
    queryFn: ({ signal }) => peopleApi.listDepartments(signal),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: [...qk.all, "employees"] });

  const save = useMutation({
    mutationFn: (v: { id?: string; body: EmployeeInput }) =>
      v.id ? peopleApi.updateEmployee(v.id, v.body) : peopleApi.createEmployee(v.body),
    onSuccess: () => {
      toast({ title: t("people.toast.saved"), tone: "success" });
      setDrawer({ open: false, employee: null });
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.saveFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const lifecycle = useMutation({
    mutationFn: (v: { kind: NonNullable<Confirm>["kind"]; id: string; reason: string }) => {
      if (v.kind === "suspend") return peopleApi.suspendEmployee(v.id);
      if (v.kind === "activate") return peopleApi.activateEmployee(v.id);
      if (v.kind === "terminate") return peopleApi.terminateEmployee(v.id, v.reason);
      return peopleApi.deleteEmployee(v.id);
    },
    onSuccess: () => {
      toast({ title: t("people.toast.done"), tone: "success" });
      setConfirm(null);
      invalidate();
    },
    onError: (e) => toast({ title: t("people.toast.actionFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  async function openEdit(row: Employee) {
    try {
      const full = await peopleApi.getEmployee(row.id);
      setDrawer({ open: true, employee: full });
    } catch (e) {
      toast({ title: t("people.employees.loadFailed"), description: safeUserMessage(e, t), tone: "error" });
    }
  }

  const columns: ColumnDef<Employee>[] = [
    { id: "employeeNumber", header: t("people.field.number"), accessor: (r) => r.employeeNumber, sortable: true },
    { id: "fullName", header: t("people.field.name"), accessor: (r) => r.fullName, sortable: true },
    { id: "jobTitle", header: t("people.field.jobTitle"), accessor: (r) => r.jobTitle ?? "—" },
    { id: "departmentName", header: t("people.field.department"), accessor: (r) => r.departmentName || "—" },
    { id: "branchName", header: t("people.field.branch"), accessor: (r) => r.branchName || "—" },
    {
      id: "employmentType",
      header: t("people.field.employmentType"),
      accessor: (r) => (r.employmentType ? employmentTypeLabel(r.employmentType, t) : "—"),
      defaultHidden: true,
    },
    {
      id: "grossSalary",
      header: t("people.field.gross"),
      accessor: (r) => r.grossSalary,
      cell: (r) => formatCurrency(r.grossSalary),
      numeric: true,
      sortable: true,
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
    <>
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.employees"
        searchable
        searchPlaceholder={t("people.employees.searchPlaceholder")}
        emptyTitle={t("people.employees.emptyTitle")}
        emptyBody={t("people.employees.emptyBody")}
        exportFilename="employees.csv"
        mobileTitle={(r) => r.fullName}
        filterBar={
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
            {t("common.status")}
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 min-w-36"
              options={[
                { value: "", label: t("common.all") },
                { value: "active", label: t("people.status.active") },
                { value: "suspended", label: t("people.status.suspended") },
                { value: "on_leave", label: t("people.status.on_leave") },
                { value: "terminated", label: t("people.status.terminated") },
              ]}
            />
          </label>
        }
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer({ open: true, employee: null })}>
            <Plus className="h-4 w-4" /> {t("people.employees.newBtn")}
          </Button>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label={t("common.edit")} size="sm" variant="ghost" onClick={() => openEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            {r.status === "active" ? (
              <>
                <IconButton
                  aria-label={t("people.employees.aria.suspend")}
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirm({ kind: "suspend", emp: r })}
                >
                  <PauseCircle className="h-4 w-4" />
                </IconButton>
                <IconButton
                  aria-label={t("people.employees.aria.terminate")}
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirm({ kind: "terminate", emp: r })}
                >
                  <UserX className="h-4 w-4" />
                </IconButton>
              </>
            ) : (
              <IconButton
                aria-label={t("people.employees.aria.activate")}
                size="sm"
                variant="ghost"
                onClick={() => setConfirm({ kind: "activate", emp: r })}
              >
                <PlayCircle className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton aria-label={t("common.delete")} size="sm" variant="danger" onClick={() => setConfirm({ kind: "delete", emp: r })}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Drawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, employee: null })}
        title={drawer.employee ? t("people.employees.editTitle", { name: drawer.employee.fullName }) : t("people.employees.newBtn")}
        eyebrow={t("people.employees.drawerEyebrow")}
      >
        <EmployeeForm
          employee={drawer.employee}
          departments={departments.data ?? []}
          submitting={save.isPending}
          onCancel={() => setDrawer({ open: false, employee: null })}
          onSubmit={(body) => save.mutate({ id: drawer.employee?.id, body })}
        />
      </Drawer>

      <ConfirmDialog
        open={!!confirm}
        title={confirmTitle(confirm, t)}
        description={confirm ? t("people.employees.confirmEmp", { name: confirm.emp.fullName }) : ""}
        tone={confirm?.kind === "delete" || confirm?.kind === "terminate" ? "danger" : "primary"}
        requireReason={confirm?.kind === "terminate"}
        reasonLabel={t("people.employees.terminateReasonLabel")}
        confirmLabel={t("common.confirm")}
        processing={lifecycle.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && lifecycle.mutate({ kind: confirm.kind, id: confirm.emp.id, reason })}
      />
    </>
  );
}

function confirmTitle(c: Confirm, t: TFunction): string {
  if (!c) return "";
  return t(`people.employees.confirm.${c.kind}`);
}

// ── Departments tab ──────────────────────────────────────────────────────────
function DepartmentsTab() {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<{ open: boolean; dept: Department | null }>({ open: false, dept: null });

  const query = useQuery({
    queryKey: qk.departments(),
    queryFn: ({ signal }) => peopleApi.listDepartments(signal),
  });

  const save = useMutation({
    mutationFn: peopleApi.saveDepartment,
    onSuccess: () => {
      toast({ title: t("people.toast.saved"), tone: "success" });
      setDrawer({ open: false, dept: null });
      qc.invalidateQueries({ queryKey: qk.departments() });
    },
    onError: (e) => toast({ title: t("people.toast.saveFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  const columns: ColumnDef<Department>[] = [
    { id: "name", header: t("people.departments.col.name"), accessor: (r) => r.name, sortable: true },
    { id: "code", header: t("people.field.code"), accessor: (r) => r.code || "—" },
    { id: "branchName", header: t("people.field.branch"), accessor: (r) => r.branchName || "—" },
    {
      id: "employeeCount",
      header: t("people.departments.col.employeeCount"),
      accessor: (r) => r.employeeCount,
      cell: (r) => <Badge tone="teal">{r.employeeCount}</Badge>,
      numeric: true,
      sortable: true,
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
        tableId="people.departments"
        searchable
        emptyTitle={t("people.departments.emptyTitle")}
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer({ open: true, dept: null })}>
            <Plus className="h-4 w-4" /> {t("people.departments.newBtn")}
          </Button>
        }
        rowActions={(r) => (
          <IconButton aria-label={t("common.edit")} size="sm" variant="ghost" onClick={() => setDrawer({ open: true, dept: r })}>
            <Pencil className="h-4 w-4" />
          </IconButton>
        )}
      />
      <Drawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, dept: null })}
        title={drawer.dept ? t("people.departments.editTitle", { name: drawer.dept.name }) : t("people.departments.newBtn")}
        eyebrow={t("people.departments.drawerEyebrow")}
      >
        <DepartmentForm
          department={drawer.dept}
          submitting={save.isPending}
          onCancel={() => setDrawer({ open: false, dept: null })}
          onSubmit={(body) => save.mutate(body)}
        />
      </Drawer>
    </>
  );
}

// ── Job titles tab (read-only) ───────────────────────────────────────────────
function JobTitlesTab() {
  const t = useTx();
  const query = useQuery({
    queryKey: qk.jobTitles(),
    queryFn: ({ signal }) => peopleApi.listJobTitles(signal),
  });

  const columns: ColumnDef<JobTitle>[] = [
    { id: "rank", header: t("people.jobTitles.col.rank"), accessor: (r) => r.rank, numeric: true, sortable: true },
    { id: "nameAr", header: t("people.field.jobTitle"), accessor: (r) => r.nameAr, sortable: true },
    { id: "nameEn", header: t("people.field.nameEn"), accessor: (r) => r.nameEn || "—" },
    { id: "code", header: t("people.field.code"), accessor: (r) => r.code || "—" },
    { id: "category", header: t("people.field.category"), accessor: (r) => r.category || "—" },
    {
      id: "isActive",
      header: t("common.status"),
      accessor: (r) => (r.isActive ? t("people.bool.enabled") : t("people.bool.disabled")),
      cell: (r) => (
        <StatusBadge tone={r.isActive ? "success" : "neutral"}>
          {r.isActive ? t("people.bool.enabled") : t("people.bool.disabled")}
        </StatusBadge>
      ),
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
      tableId="people.jobTitles"
      searchable
      emptyTitle={t("people.jobTitles.emptyTitle")}
    />
  );
}
