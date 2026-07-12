import { useMemo, useState } from "react";
import { Badge, StatusBadge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate, formatDateTime } from "@/shared/lib";
import {
  cashierOptions,
  isShiftOpen,
  shiftActual,
  shiftDiff,
  shiftTheoretical,
  useShifts,
} from "../lib/shifts";
import type { Shift, ShiftFilters as ShiftFiltersValue } from "../lib/types";
import { ShiftFilters } from "../components/ShiftFilters";
import { ShiftDetailDrawer } from "../components/ShiftDetailDrawer";

function DiffBadge({ shift }: { shift: Shift }) {
  const diff = shiftDiff(shift);
  if (Math.abs(diff) < 0.01) return <Badge tone="success">متطابق</Badge>;
  return (
    <Badge tone={diff < 0 ? "danger" : "warning"}>
      <span dir="ltr" className="tabular-nums">
        {diff > 0 ? "+" : ""}
        {formatCurrency(diff)}
      </span>
    </Badge>
  );
}

export function ShiftsPage() {
  const [filters, setFilters] = useState<ShiftFiltersValue>({});
  const [selected, setSelected] = useState<Shift | null>(null);
  const { query, rows } = useShifts(filters);

  const cashiers = useMemo(() => cashierOptions(rows), [rows]);

  const columns: ColumnDef<Shift>[] = [
    {
      id: "date",
      header: "التاريخ",
      accessor: (r) => r.startTime ?? "",
      cell: (r) => formatDate(r.startTime),
      sortable: true,
    },
    {
      id: "cashier",
      header: "الكاشير",
      accessor: (r) => r.displayName || r.username || "",
      sortable: true,
      cell: (r) => (
        <div>
          <div className="font-extrabold text-slate-800">{r.displayName || r.username || "—"}</div>
          {r.username && r.displayName && (
            <div dir="ltr" className="text-[11px] font-medium text-slate-400">
              {r.username}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "start",
      header: "بدء الوردية",
      accessor: (r) => r.startTime ?? "",
      cell: (r) => formatDateTime(r.startTime),
    },
    {
      id: "end",
      header: "الإغلاق",
      accessor: (r) => r.endTime ?? "",
      cell: (r) => (r.endTime ? formatDateTime(r.endTime) : "مفتوحة"),
    },
    {
      id: "expected",
      header: "المتوقّع",
      accessor: (r) => shiftTheoretical(r),
      cell: (r) => formatCurrency(shiftTheoretical(r)),
      numeric: true,
      sortable: true,
    },
    {
      id: "actual",
      header: "الفعلي",
      accessor: (r) => shiftActual(r),
      cell: (r) => formatCurrency(shiftActual(r)),
      numeric: true,
      sortable: true,
    },
    {
      id: "diff",
      header: "الفرق",
      accessor: (r) => shiftDiff(r),
      cell: (r) => <DiffBadge shift={r} />,
      align: "center",
      sortable: true,
    },
    {
      id: "status",
      header: "الحالة",
      accessor: (r) => (isShiftOpen(r) ? "مفتوحة" : "مغلقة"),
      cell: (r) => (
        <StatusBadge tone={isShiftOpen(r) ? "warning" : "success"}>
          {isShiftOpen(r) ? "مفتوحة" : "مغلقة"}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-slate-500">
        مراجعة ورديات الكاشير — المتوقّع مقابل الفعلي والفروقات. اضغط أي وردية لعرض توزيع طرق الدفع.
      </p>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        onRowClick={(r) => setSelected(r)}
        exportFilename="shifts"
        emptyTitle="لا توجد ورديات"
        emptyBody="لا توجد ورديات مطابقة لعوامل التصفية المحددة."
        initialSort={{ columnId: "date", dir: "desc" }}
        tableId="pos-admin-shifts"
        filterBar={<ShiftFilters value={filters} onChange={setFilters} cashiers={cashiers} />}
      />

      <ShiftDetailDrawer shift={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
