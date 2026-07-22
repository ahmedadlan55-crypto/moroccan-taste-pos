import { useMemo, useState, type ReactNode } from "react";
import { Coins, Calculator, DoorClosed, DoorOpen, ListChecks, Scale } from "lucide-react";
import { StatusBadge } from "@/shared/ui";
import { DataTable, downloadRowsCsv, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import {
  isShiftOpen,
  shiftActual,
  shiftDiff,
  shiftTheoretical,
  summarizeShifts,
  useShifts,
} from "../lib/shifts";
import { shiftStatusLabel } from "../lib/labels";
import type { Shift, ShiftFilters as ShiftFiltersValue } from "../lib/types";
import { ShiftFilters } from "../components/ShiftFilters";

function StatTile({
  icon: Icon,
  label,
  value,
  tone = "slate",
}: {
  icon: typeof Coins;
  label: string;
  value: ReactNode;
  tone?: "slate" | "teal" | "amber" | "emerald" | "rose";
}) {
  const toneCls: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    teal: "bg-teal-50 text-teal-700",
    amber: "bg-amber-50 text-amber-700",
    emerald: "bg-emerald-50 text-emerald-700",
    rose: "bg-rose-50 text-rose-700",
  };
  return (
    <div className="surface flex items-center gap-3 p-4">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${toneCls[tone]}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-400">{label}</div>
        <div className="text-lg font-extrabold text-slate-900">{value}</div>
      </div>
    </div>
  );
}

// Full CSV mirrors the legacy erpExportShiftCloseAdmin sheet columns. Built per
// call so the headers follow the active UI language.
function makeExportColumns(t: TFunction): ColumnDef<Shift>[] {
  const date = t("posAdmin.col.date");
  const close = t("posAdmin.col.close");
  const expected = t("posAdmin.col.expected");
  const diff = t("posAdmin.col.diff");
  const status = t("common.status");
  return [
    { id: "date", header: date, label: date, exportValue: (r) => formatDate(r.startTime) },
    { id: "displayName", header: t("posAdmin.reports.export.displayName"), label: t("posAdmin.reports.export.displayName"), exportValue: (r) => r.displayName || r.username || "" },
    { id: "username", header: t("posAdmin.reports.export.username"), label: t("posAdmin.reports.export.username"), exportValue: (r) => r.username || "" },
    { id: "open", header: t("posAdmin.reports.export.opening"), label: t("posAdmin.reports.export.opening"), exportValue: (r) => (r.startTime ? formatDateTime(r.startTime) : "") },
    { id: "close", header: close, label: close, exportValue: (r) => (r.endTime ? formatDateTime(r.endTime) : "") },
    { id: "expected", header: expected, label: expected, exportValue: (r) => shiftTheoretical(r) },
    { id: "cash", header: t("posAdmin.reports.export.cashActual"), label: t("posAdmin.reports.export.cashActual"), exportValue: (r) => Number(r.actualCash) || 0 },
    { id: "card", header: t("posAdmin.reports.export.cardActual"), label: t("posAdmin.reports.export.cardActual"), exportValue: (r) => Number(r.actualCard) || 0 },
    { id: "other", header: t("posAdmin.reports.export.otherActual"), label: t("posAdmin.reports.export.otherActual"), exportValue: (r) => Number(r.actualKita) || 0 },
    { id: "actual", header: t("posAdmin.reports.export.totalActual"), label: t("posAdmin.reports.export.totalActual"), exportValue: (r) => shiftActual(r) },
    { id: "diff", header: diff, label: diff, exportValue: (r) => shiftDiff(r) },
    { id: "status", header: status, label: status, exportValue: (r) => shiftStatusLabel(t, isShiftOpen(r)) },
    { id: "id", header: t("posAdmin.reports.export.sessionId"), label: t("posAdmin.reports.export.sessionId"), exportValue: (r) => String(r.id) },
  ];
}

export function ReportsPage() {
  const t = useT();
  const [filters, setFilters] = useState<ShiftFiltersValue>({});
  const { query, rows } = useShifts(filters);

  const summary = useMemo(() => summarizeShifts(rows), [rows]);
  const cashiers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of rows) if (s.username && !seen.has(s.username)) seen.set(s.username, s.displayName || s.username);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [rows]);

  const varianceTone = Math.abs(summary.variance) < 0.01 ? "emerald" : summary.variance < 0 ? "rose" : "amber";

  const columns: ColumnDef<Shift>[] = [
    { id: "date", header: t("posAdmin.col.date"), accessor: (r) => r.startTime ?? "", cell: (r) => formatDate(r.startTime), sortable: true },
    {
      id: "cashier",
      header: t("posAdmin.col.cashier"),
      accessor: (r) => r.displayName || r.username || "",
      sortable: true,
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
      cell: (r) => formatCurrency(shiftDiff(r)),
      numeric: true,
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
      <p className="text-sm font-medium text-slate-500">{t("posAdmin.reports.subtitle")}</p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile icon={ListChecks} label={t("posAdmin.reports.stat.totalShifts")} value={<span dir="ltr" className="tabular-nums">{formatNumber(summary.total)}</span>} tone="teal" />
        <StatTile icon={DoorOpen} label={t("posAdmin.shift.open")} value={<span dir="ltr" className="tabular-nums">{formatNumber(summary.open)}</span>} tone="amber" />
        <StatTile icon={DoorClosed} label={t("posAdmin.shift.closed")} value={<span dir="ltr" className="tabular-nums">{formatNumber(summary.closed)}</span>} tone="emerald" />
        <StatTile icon={Calculator} label={t("posAdmin.reports.stat.totalExpected")} value={<span dir="ltr" className="tabular-nums">{formatCurrency(summary.expected)}</span>} tone="teal" />
        <StatTile icon={Coins} label={t("posAdmin.reports.stat.totalActual")} value={<span dir="ltr" className="tabular-nums">{formatCurrency(summary.actual)}</span>} tone="slate" />
        <StatTile icon={Scale} label={t("posAdmin.reports.stat.totalDiff")} value={<span dir="ltr" className="tabular-nums">{formatCurrency(summary.variance)}</span>} tone={varianceTone} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        exportFilename="cashier-shift-report"
        onExport={(data) => downloadRowsCsv(makeExportColumns(t), data, "cashier-shift-report")}
        emptyTitle={t("posAdmin.reports.emptyTitle")}
        emptyBody={t("posAdmin.shifts.emptyBody")}
        initialSort={{ columnId: "date", dir: "desc" }}
        tableId="pos-admin-reports"
        filterBar={<ShiftFilters value={filters} onChange={setFilters} cashiers={cashiers} />}
      />
    </div>
  );
}
