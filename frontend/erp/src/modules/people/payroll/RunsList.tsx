import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, PageHeader, StatusBadge } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useCan } from "@/app/providers";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { CreateRunDialog } from "./CreateRunDialog";
import { money, payrollStatusMeta, periodLabel, usePayrollRuns, type PayrollRun } from "./api";

interface RunsListProps {
  /** Open a run's detail. Called with a run id (row click or after creating). */
  onOpen: (runId: string) => void;
}

export function RunsList({ onOpen }: RunsListProps) {
  const t = useTx();
  const canManage = useCan("people.payroll.manage");
  const runsQuery = usePayrollRuns();
  const [createOpen, setCreateOpen] = useState(false);

  const columns: ColumnDef<PayrollRun>[] = [
    {
      id: "period",
      header: t("people.payroll.col.period"),
      accessor: (r) => r.year * 100 + r.month,
      cell: (r) => <span className="font-bold text-slate-800">{periodLabel(r, t)}</span>,
      sortable: true,
    },
    { id: "branchName", header: t("people.field.branch"), accessor: (r) => r.branchName || t("people.payroll.allBranches") },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => {
        const m = payrollStatusMeta(r.status, t);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
    {
      id: "employeeCount",
      header: t("people.payroll.col.employeeCount"),
      accessor: (r) => r.employeeCount,
      cell: (r) => <span className="tabular-nums">{r.employeeCount}</span>,
      numeric: true,
      sortable: true,
    },
    {
      id: "totalGross",
      header: t("people.payroll.col.totalGross"),
      accessor: (r) => r.totalGross,
      cell: (r) => money(r.totalGross),
      numeric: true,
      sortable: true,
    },
    {
      id: "totalNet",
      header: t("people.payroll.col.totalNet"),
      accessor: (r) => r.totalNet,
      cell: (r) => <span className="font-bold text-emerald-700">{money(r.totalNet)}</span>,
      numeric: true,
      sortable: true,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("people.eyebrow")}
        title={t("people.payroll.title")}
        subtitle={t("people.payroll.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> {t("people.payroll.newRunBtn")}
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={runsQuery.data ?? []}
        getRowId={(r) => r.id}
        loading={runsQuery.isLoading}
        error={runsQuery.error}
        onRetry={() => runsQuery.refetch()}
        tableId="people.payroll.runs"
        initialSort={{ columnId: "period", dir: "desc" }}
        searchable
        searchPlaceholder={t("people.payroll.searchByBranch")}
        emptyTitle={t("people.payroll.emptyTitle")}
        emptyBody={canManage ? t("people.payroll.emptyBodyManage") : t("people.payroll.emptyBodyView")}
        emptyAction={
          canManage ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> {t("people.payroll.newRunBtn")}
            </Button>
          ) : undefined
        }
        onRowClick={(r) => onOpen(r.id)}
      />

      <CreateRunDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(runId) => {
          setCreateOpen(false);
          if (runId) onOpen(runId);
        }}
      />
    </div>
  );
}
