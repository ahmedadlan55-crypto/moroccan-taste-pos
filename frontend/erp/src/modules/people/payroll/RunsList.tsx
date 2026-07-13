import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, PageHeader, StatusBadge } from "@/shared/ui";
import { useCan } from "@/app/providers";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { CreateRunDialog } from "./CreateRunDialog";
import { money, payrollStatusMeta, periodLabel, usePayrollRuns, type PayrollRun } from "./api";

interface RunsListProps {
  /** Open a run's detail. Called with a run id (row click or after creating). */
  onOpen: (runId: string) => void;
}

export function RunsList({ onOpen }: RunsListProps) {
  const canManage = useCan("people.payroll.manage");
  const runsQuery = usePayrollRuns();
  const [createOpen, setCreateOpen] = useState(false);

  const columns: ColumnDef<PayrollRun>[] = [
    {
      id: "period",
      header: "الفترة",
      accessor: (r) => r.year * 100 + r.month,
      cell: (r) => <span className="font-bold text-slate-800">{periodLabel(r)}</span>,
      sortable: true,
    },
    { id: "branchName", header: "الفرع", accessor: (r) => r.branchName || "كل الفروع" },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => r.status,
      cell: (r) => {
        const m = payrollStatusMeta(r.status);
        return <StatusBadge tone={m.tone}>{m.label}</StatusBadge>;
      },
    },
    {
      id: "employeeCount",
      header: "عدد الموظفين",
      accessor: (r) => r.employeeCount,
      cell: (r) => <span className="tabular-nums">{r.employeeCount}</span>,
      numeric: true,
      sortable: true,
    },
    {
      id: "totalGross",
      header: "إجمالي المستحق",
      accessor: (r) => r.totalGross,
      cell: (r) => money(r.totalGross),
      numeric: true,
      sortable: true,
    },
    {
      id: "totalNet",
      header: "صافي المستحق",
      accessor: (r) => r.totalNet,
      cell: (r) => <span className="font-bold text-emerald-700">{money(r.totalNet)}</span>,
      numeric: true,
      sortable: true,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="الموارد البشرية"
        title="الرواتب"
        subtitle="مسيّرات الرواتب الشهرية: الاحتساب، الاعتماد، الصرف، وقسائم الرواتب."
        action={
          canManage ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> مسير جديد
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
        searchPlaceholder="بحث بالفرع…"
        emptyTitle="لا توجد مسيّرات رواتب"
        emptyBody={canManage ? "أنشئ أول مسير رواتب للبدء." : "لم يُنشأ أي مسير رواتب بعد."}
        emptyAction={
          canManage ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> مسير جديد
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
