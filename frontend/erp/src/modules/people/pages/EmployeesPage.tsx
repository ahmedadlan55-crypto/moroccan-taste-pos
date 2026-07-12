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
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { EMPLOYMENT_TYPE_LABEL, statusMeta } from "../lib/labels";
import type { Department, Employee, EmployeeDetail, EmployeeInput, JobTitle } from "../lib/types";
import { EmployeeForm } from "../components/EmployeeForm";
import { DepartmentForm } from "../components/DepartmentForm";
import { AdvancesTab } from "./tabs/AdvancesTab";

type TabKey = "employees" | "departments" | "job-titles" | "advances";

const TABS = [
  { value: "employees", label: "الموظفون" },
  { value: "departments", label: "الأقسام" },
  { value: "job-titles", label: "المسميات الوظيفية" },
  { value: "advances", label: "السُّلف" },
];

export function EmployeesPage() {
  const [tab, setTab] = useState<TabKey>("employees");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الموظفون"
        subtitle="سجل الموظفين والأقسام والمسميات الوظيفية والسُّلف."
      />
      <Tabs items={TABS} value={tab} onChange={(v) => setTab(v as TabKey)} aria-label="أقسام الموظفين" />
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
      toast({ title: "تم الحفظ", tone: "success" });
      setDrawer({ open: false, employee: null });
      invalidate();
    },
    onError: (e) => toast({ title: "تعذّر الحفظ", description: safeUserMessage(e), tone: "error" }),
  });

  const lifecycle = useMutation({
    mutationFn: (v: { kind: NonNullable<Confirm>["kind"]; id: string; reason: string }) => {
      if (v.kind === "suspend") return peopleApi.suspendEmployee(v.id);
      if (v.kind === "activate") return peopleApi.activateEmployee(v.id);
      if (v.kind === "terminate") return peopleApi.terminateEmployee(v.id, v.reason);
      return peopleApi.deleteEmployee(v.id);
    },
    onSuccess: () => {
      toast({ title: "تم تنفيذ العملية", tone: "success" });
      setConfirm(null);
      invalidate();
    },
    onError: (e) => toast({ title: "تعذّر تنفيذ العملية", description: safeUserMessage(e), tone: "error" }),
  });

  async function openEdit(row: Employee) {
    try {
      const full = await peopleApi.getEmployee(row.id);
      setDrawer({ open: true, employee: full });
    } catch (e) {
      toast({ title: "تعذّر تحميل بيانات الموظف", description: safeUserMessage(e), tone: "error" });
    }
  }

  const columns: ColumnDef<Employee>[] = [
    { id: "employeeNumber", header: "الرقم", accessor: (r) => r.employeeNumber, sortable: true },
    { id: "fullName", header: "الاسم", accessor: (r) => r.fullName, sortable: true },
    { id: "jobTitle", header: "المسمى", accessor: (r) => r.jobTitle ?? "—" },
    { id: "departmentName", header: "القسم", accessor: (r) => r.departmentName || "—" },
    { id: "branchName", header: "الفرع", accessor: (r) => r.branchName || "—" },
    {
      id: "employmentType",
      header: "نوع التوظيف",
      accessor: (r) => (r.employmentType ? EMPLOYMENT_TYPE_LABEL[r.employmentType] ?? r.employmentType : "—"),
      defaultHidden: true,
    },
    {
      id: "grossSalary",
      header: "الإجمالي",
      accessor: (r) => r.grossSalary,
      cell: (r) => formatCurrency(r.grossSalary),
      numeric: true,
      sortable: true,
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
        searchPlaceholder="بحث بالاسم أو الرقم…"
        emptyTitle="لا يوجد موظفون"
        emptyBody="ابدأ بإضافة أول موظف."
        exportFilename="employees.csv"
        mobileTitle={(r) => r.fullName}
        filterBar={
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500">
            الحالة
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 min-w-36"
              options={[
                { value: "", label: "الكل" },
                { value: "active", label: "نشط" },
                { value: "suspended", label: "مجمد" },
                { value: "on_leave", label: "في إجازة" },
                { value: "terminated", label: "منتهي الخدمة" },
              ]}
            />
          </label>
        }
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer({ open: true, employee: null })}>
            <Plus className="h-4 w-4" /> موظف جديد
          </Button>
        }
        rowActions={(r) => (
          <div className="flex items-center gap-1">
            <IconButton aria-label="تعديل" size="sm" variant="ghost" onClick={() => openEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            {r.status === "active" ? (
              <>
                <IconButton
                  aria-label="تجميد"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirm({ kind: "suspend", emp: r })}
                >
                  <PauseCircle className="h-4 w-4" />
                </IconButton>
                <IconButton
                  aria-label="إنهاء الخدمة"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirm({ kind: "terminate", emp: r })}
                >
                  <UserX className="h-4 w-4" />
                </IconButton>
              </>
            ) : (
              <IconButton
                aria-label="تنشيط"
                size="sm"
                variant="ghost"
                onClick={() => setConfirm({ kind: "activate", emp: r })}
              >
                <PlayCircle className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton aria-label="حذف" size="sm" variant="danger" onClick={() => setConfirm({ kind: "delete", emp: r })}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      />

      <Drawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, employee: null })}
        title={drawer.employee ? `تعديل: ${drawer.employee.fullName}` : "موظف جديد"}
        eyebrow="الموظفون"
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
        title={confirmTitle(confirm)}
        description={confirm ? `الموظف: ${confirm.emp.fullName}` : ""}
        tone={confirm?.kind === "delete" || confirm?.kind === "terminate" ? "danger" : "primary"}
        requireReason={confirm?.kind === "terminate"}
        reasonLabel="سبب إنهاء الخدمة"
        confirmLabel="تأكيد"
        processing={lifecycle.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && lifecycle.mutate({ kind: confirm.kind, id: confirm.emp.id, reason })}
      />
    </>
  );
}

function confirmTitle(c: Confirm): string {
  if (!c) return "";
  return {
    suspend: "تجميد الموظف؟",
    activate: "تنشيط الموظف؟",
    terminate: "إنهاء خدمة الموظف؟",
    delete: "حذف الموظف؟",
  }[c.kind];
}

// ── Departments tab ──────────────────────────────────────────────────────────
function DepartmentsTab() {
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
      toast({ title: "تم الحفظ", tone: "success" });
      setDrawer({ open: false, dept: null });
      qc.invalidateQueries({ queryKey: qk.departments() });
    },
    onError: (e) => toast({ title: "تعذّر الحفظ", description: safeUserMessage(e), tone: "error" }),
  });

  const columns: ColumnDef<Department>[] = [
    { id: "name", header: "القسم", accessor: (r) => r.name, sortable: true },
    { id: "code", header: "الرمز", accessor: (r) => r.code || "—" },
    { id: "branchName", header: "الفرع", accessor: (r) => r.branchName || "—" },
    {
      id: "employeeCount",
      header: "عدد الموظفين",
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
        emptyTitle="لا توجد أقسام"
        toolbarActions={
          <Button variant="primary" size="sm" onClick={() => setDrawer({ open: true, dept: null })}>
            <Plus className="h-4 w-4" /> قسم جديد
          </Button>
        }
        rowActions={(r) => (
          <IconButton aria-label="تعديل" size="sm" variant="ghost" onClick={() => setDrawer({ open: true, dept: r })}>
            <Pencil className="h-4 w-4" />
          </IconButton>
        )}
      />
      <Drawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, dept: null })}
        title={drawer.dept ? `تعديل: ${drawer.dept.name}` : "قسم جديد"}
        eyebrow="الأقسام"
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
  const query = useQuery({
    queryKey: qk.jobTitles(),
    queryFn: ({ signal }) => peopleApi.listJobTitles(signal),
  });

  const columns: ColumnDef<JobTitle>[] = [
    { id: "rank", header: "المستوى", accessor: (r) => r.rank, numeric: true, sortable: true },
    { id: "nameAr", header: "المسمى", accessor: (r) => r.nameAr, sortable: true },
    { id: "nameEn", header: "بالإنجليزية", accessor: (r) => r.nameEn || "—" },
    { id: "code", header: "الرمز", accessor: (r) => r.code || "—" },
    { id: "category", header: "الفئة", accessor: (r) => r.category || "—" },
    {
      id: "isActive",
      header: "الحالة",
      accessor: (r) => (r.isActive ? "فعّال" : "معطّل"),
      cell: (r) => <StatusBadge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "فعّال" : "معطّل"}</StatusBadge>,
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
      emptyTitle="لا توجد مسميات وظيفية"
    />
  );
}
