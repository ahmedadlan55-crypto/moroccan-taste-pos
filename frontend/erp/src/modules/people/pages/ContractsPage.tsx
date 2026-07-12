import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DetailStat, Drawer, LoadingState, PageHeader, StatusBadge, ErrorState } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { EMPLOYMENT_TYPE_LABEL, statusMeta } from "../lib/labels";
import type { Employee } from "../lib/types";

export function ContractsPage() {
  const [detailId, setDetailId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: qk.employees({ view: "contracts" }),
    queryFn: ({ signal }) => peopleApi.listEmployees({}, signal),
  });

  const columns: ColumnDef<Employee>[] = [
    { id: "employeeNumber", header: "الرقم", accessor: (r) => r.employeeNumber, sortable: true },
    { id: "fullName", header: "الموظف", accessor: (r) => r.fullName, sortable: true },
    { id: "jobTitle", header: "المسمى", accessor: (r) => r.jobTitle || "—" },
    {
      id: "employmentType",
      header: "نوع التوظيف",
      accessor: (r) => (r.employmentType ? EMPLOYMENT_TYPE_LABEL[r.employmentType] ?? r.employmentType : "—"),
    },
    { id: "hireDate", header: "تاريخ التعيين", accessor: (r) => r.hireDate ?? "", cell: (r) => formatDate(r.hireDate), sortable: true },
    {
      id: "grossSalary",
      header: "الإجمالي",
      accessor: (r) => r.grossSalary,
      cell: (r) => formatCurrency(r.grossSalary),
      numeric: true,
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
    <div className="space-y-6">
      <PageHeader
        eyebrow="الموارد البشرية"
        title="العقود"
        subtitle="عقود الموظفين وتواريخ التعيين ونهاية العقد. اضغط على أي صف لعرض تفاصيل العقد."
      />
      <DataTable
        columns={columns}
        rows={query.data ?? []}
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => query.refetch()}
        tableId="people.contracts"
        searchable
        searchPlaceholder="بحث باسم الموظف…"
        emptyTitle="لا توجد عقود"
        onRowClick={(r) => setDetailId(r.id)}
      />
      <ContractDetailDrawer id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function ContractDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useQuery({
    queryKey: qk.employee(id ?? ""),
    queryFn: ({ signal }) => peopleApi.getEmployee(id ?? "", signal),
    enabled: !!id,
  });
  const emp = query.data;

  return (
    <Drawer open={!!id} onClose={onClose} title={emp ? emp.fullName : "تفاصيل العقد"} eyebrow="العقود">
      {query.isLoading && <LoadingState rows={2} />}
      {query.error && <ErrorState error={query.error} onRetry={() => query.refetch()} />}
      {emp && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <DetailStat label="الرقم الوظيفي" value={emp.employeeNumber || "—"} />
            <DetailStat label="المسمى" value={emp.jobTitle || "—"} />
            <DetailStat
              label="نوع التوظيف"
              value={emp.employmentType ? EMPLOYMENT_TYPE_LABEL[emp.employmentType] ?? emp.employmentType : "—"}
            />
            <DetailStat label="الحالة" value={statusMeta(emp.status).label} />
            <DetailStat label="تاريخ التعيين" value={formatDate(emp.hireDate)} />
            <DetailStat label="نهاية العقد" value={formatDate(emp.contractEndDate)} />
            <DetailStat label="نهاية التجربة" value={formatDate(emp.probationEndDate)} />
            <DetailStat label="الراتب الأساسي" value={formatCurrency(emp.basicSalary)} />
            <DetailStat label="رقم الهوية" value={emp.nationalId || "—"} />
            <DetailStat label="رقم الإقامة" value={emp.iqamaNumber || "—"} />
            <DetailStat label="القسم" value={emp.departmentName || "—"} />
            <DetailStat label="الفرع" value={emp.branchName || "—"} />
          </div>
          {(emp.bankName || emp.bankIban) && (
            <div className="grid grid-cols-2 gap-3">
              <DetailStat label="البنك" value={emp.bankName || "—"} />
              <DetailStat label="الآيبان" value={emp.bankIban || "—"} />
            </div>
          )}
          {emp.status === "terminated" && (
            <div className="grid grid-cols-2 gap-3">
              <DetailStat label="تاريخ إنهاء الخدمة" value={formatDate(emp.terminationDate)} />
              <DetailStat label="سبب الإنهاء" value={emp.terminationReason || "—"} />
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
