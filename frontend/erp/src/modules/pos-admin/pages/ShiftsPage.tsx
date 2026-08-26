import { useMemo, useState } from "react";
import { Badge, PageHeader, StatusBadge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate, formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  cashierOptions,
  isShiftOpen,
  shiftActual,
  shiftDiff,
  shiftTheoretical,
  useShifts,
} from "../lib/shifts";
import { shiftStatusLabel } from "../lib/labels";
import type { Shift, ShiftFilters as ShiftFiltersValue } from "../lib/types";
import { ShiftFilters } from "../components/ShiftFilters";
import { ShiftDetailDrawer } from "../components/ShiftDetailDrawer";

function DiffBadge({ shift }: { shift: Shift }) {
  const t = useT();
  const diff = shiftDiff(shift);
  if (Math.abs(diff) < 0.01) return <Badge tone="success">{t("posAdmin.shift.balanced")}</Badge>;
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
  const t = useT();
  const [filters, setFilters] = useState<ShiftFiltersValue>({});
  const [selected, setSelected] = useState<Shift | null>(null);
  const { query, rows } = useShifts(filters);

  const cashiers = useMemo(() => cashierOptions(rows), [rows]);

  const columns: ColumnDef<Shift>[] = [
    {
      id: "date",
      header: t("posAdmin.col.date"),
      accessor: (r) => r.startTime ?? "",
      cell: (r) => formatDate(r.startTime),
      sortable: true,
    },
    {
      id: "cashier",
      header: t("posAdmin.col.cashier"),
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
      header: t("posAdmin.col.start"),
      accessor: (r) => r.startTime ?? "",
      cell: (r) => formatDateTime(r.startTime),
    },
    {
      id: "end",
      header: t("posAdmin.col.close"),
      accessor: (r) => r.endTime ?? "",
      cell: (r) => (r.endTime ? formatDateTime(r.endTime) : t("posAdmin.shift.open")),
    },
    {
      id: "expected",
      header: t("posAdmin.col.expected"),
      accessor: (r) => shiftTheoretical(r),
      cell: (r) => formatCurrency(shiftTheoretical(r)),
      numeric: true,
      sortable: true,
    },
    {
      id: "actual",
      header: t("posAdmin.col.actual"),
      accessor: (r) => shiftActual(r),
      cell: (r) => formatCurrency(shiftActual(r)),
      numeric: true,
      sortable: true,
    },
    {
      id: "diff",
      header: t("posAdmin.col.diff"),
      accessor: (r) => shiftDiff(r),
      cell: (r) => <DiffBadge shift={r} />,
      align: "center",
      sortable: true,
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => shiftStatusLabel(t, isShiftOpen(r)),
      cell: (r) => (
        <StatusBadge tone={isShiftOpen(r) ? "warning" : "success"}>
          {shiftStatusLabel(t, isShiftOpen(r))}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("nav.items.pa-shifts")} subtitle={t("posAdmin.shifts.subtitle")} />

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        onRowClick={(r) => setSelected(r)}
        exportFilename="shifts"
        emptyTitle={t("posAdmin.shifts.emptyTitle")}
        emptyBody={t("posAdmin.shifts.emptyBody")}
        initialSort={{ columnId: "date", dir: "desc" }}
        tableId="pos-admin-shifts"
        filterBar={<ShiftFilters value={filters} onChange={setFilters} cashiers={cashiers} />}
      />

      <ShiftDetailDrawer shift={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
