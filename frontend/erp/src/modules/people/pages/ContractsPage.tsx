import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DetailStat, Drawer, LoadingState, PageHeader, StatusBadge, ErrorState } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";
import { peopleApi } from "../lib/api";
import { qk } from "../lib/query-keys";
import { employmentTypeLabel, statusMeta } from "../lib/labels";
import type { Employee } from "../lib/types";

export function ContractsPage() {
  const t = useTx();
  const [detailId, setDetailId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: qk.employees({ view: "contracts" }),
    queryFn: ({ signal }) => peopleApi.listEmployees({}, signal),
  });

  const columns: ColumnDef<Employee>[] = [
    { id: "employeeNumber", header: t("people.field.number"), accessor: (r) => r.employeeNumber, sortable: true },
    { id: "fullName", header: t("people.field.employee"), accessor: (r) => r.fullName, sortable: true },
    { id: "jobTitle", header: t("people.field.jobTitle"), accessor: (r) => r.jobTitle || "—" },
    {
      id: "employmentType",
      header: t("people.field.employmentType"),
      accessor: (r) => (r.employmentType ? employmentTypeLabel(r.employmentType, t) : "—"),
    },
    { id: "hireDate", header: t("people.field.hireDate"), accessor: (r) => r.hireDate ?? "", cell: (r) => formatDate(r.hireDate), sortable: true },
    {
      id: "grossSalary",
      header: t("people.field.gross"),
      accessor: (r) => r.grossSalary,
      cell: (r) => formatCurrency(r.grossSalary),
      numeric: true,
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
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.contracts.title")}
        subtitle={t("people.contracts.subtitle")}
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
        searchPlaceholder={t("people.contracts.searchPlaceholder")}
        emptyTitle={t("people.contracts.emptyTitle")}
        onRowClick={(r) => setDetailId(r.id)}
      />
      <ContractDetailDrawer id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function ContractDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTx();
  const query = useQuery({
    queryKey: qk.employee(id ?? ""),
    queryFn: ({ signal }) => peopleApi.getEmployee(id ?? "", signal),
    enabled: !!id,
  });
  const emp = query.data;

  return (
    <Drawer open={!!id} onClose={onClose} title={emp ? emp.fullName : t("people.contracts.detailTitle")} eyebrow={t("people.contracts.drawerEyebrow")}>
      {query.isLoading && <LoadingState rows={2} />}
      {query.error && <ErrorState error={query.error} onRetry={() => query.refetch()} />}
      {emp && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <DetailStat label={t("people.field.empNumber")} value={emp.employeeNumber || "—"} />
            <DetailStat label={t("people.field.jobTitle")} value={emp.jobTitle || "—"} />
            <DetailStat
              label={t("people.field.employmentType")}
              value={emp.employmentType ? employmentTypeLabel(emp.employmentType, t) : "—"}
            />
            <DetailStat label={t("common.status")} value={statusMeta(emp.status, t).label} />
            <DetailStat label={t("people.field.hireDate")} value={formatDate(emp.hireDate)} />
            <DetailStat label={t("people.contracts.stat.contractEnd")} value={formatDate(emp.contractEndDate)} />
            <DetailStat label={t("people.contracts.stat.probationEnd")} value={formatDate(emp.probationEndDate)} />
            <DetailStat label={t("people.field.basicSalary")} value={formatCurrency(emp.basicSalary)} />
            <DetailStat label={t("people.field.idNumber")} value={emp.nationalId || "—"} />
            <DetailStat label={t("people.contracts.stat.iqama")} value={emp.iqamaNumber || "—"} />
            <DetailStat label={t("people.field.department")} value={emp.departmentName || "—"} />
            <DetailStat label={t("people.field.branch")} value={emp.branchName || "—"} />
          </div>
          {(emp.bankName || emp.bankIban) && (
            <div className="grid grid-cols-2 gap-3">
              <DetailStat label={t("people.contracts.stat.bank")} value={emp.bankName || "—"} />
              <DetailStat label={t("people.contracts.stat.iban")} value={emp.bankIban || "—"} />
            </div>
          )}
          {emp.status === "terminated" && (
            <div className="grid grid-cols-2 gap-3">
              <DetailStat label={t("people.contracts.stat.terminationDate")} value={formatDate(emp.terminationDate)} />
              <DetailStat label={t("people.contracts.stat.terminationReason")} value={emp.terminationReason || "—"} />
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
