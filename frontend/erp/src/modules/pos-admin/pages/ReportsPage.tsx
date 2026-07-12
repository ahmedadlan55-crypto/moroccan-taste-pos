import { useMemo, useState, type ReactNode } from "react";
import { Coins, Calculator, DoorClosed, DoorOpen, ListChecks, Scale } from "lucide-react";
import { StatusBadge } from "@/shared/ui";
import { DataTable, downloadRowsCsv, type ColumnDef } from "@/shared/tables";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "@/shared/lib";
import {
  isShiftOpen,
  shiftActual,
  shiftDiff,
  shiftTheoretical,
  summarizeShifts,
  useShifts,
} from "../lib/shifts";
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

// Full CSV mirrors the legacy erpExportShiftCloseAdmin sheet columns.
const EXPORT_COLUMNS: ColumnDef<Shift>[] = [
  { id: "date", header: "التاريخ", label: "التاريخ", exportValue: (r) => formatDate(r.startTime) },
  { id: "displayName", header: "اسم العرض", label: "اسم العرض", exportValue: (r) => r.displayName || r.username || "" },
  { id: "username", header: "اسم المستخدم", label: "اسم المستخدم", exportValue: (r) => r.username || "" },
  { id: "open", header: "الافتتاح", label: "الافتتاح", exportValue: (r) => (r.startTime ? formatDateTime(r.startTime) : "") },
  { id: "close", header: "الإغلاق", label: "الإغلاق", exportValue: (r) => (r.endTime ? formatDateTime(r.endTime) : "") },
  { id: "expected", header: "المتوقّع", label: "المتوقّع", exportValue: (r) => shiftTheoretical(r) },
  { id: "cash", header: "الفعلي - كاش", label: "الفعلي - كاش", exportValue: (r) => Number(r.actualCash) || 0 },
  { id: "card", header: "الفعلي - بطاقة", label: "الفعلي - بطاقة", exportValue: (r) => Number(r.actualCard) || 0 },
  { id: "other", header: "الفعلي - أخرى", label: "الفعلي - أخرى", exportValue: (r) => Number(r.actualKita) || 0 },
  { id: "actual", header: "الفعلي - إجمالي", label: "الفعلي - إجمالي", exportValue: (r) => shiftActual(r) },
  { id: "diff", header: "الفرق", label: "الفرق", exportValue: (r) => shiftDiff(r) },
  { id: "status", header: "الحالة", label: "الحالة", exportValue: (r) => (isShiftOpen(r) ? "مفتوحة" : "مغلقة") },
  { id: "id", header: "رقم الجلسة", label: "رقم الجلسة", exportValue: (r) => String(r.id) },
];

export function ReportsPage() {
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
    { id: "date", header: "التاريخ", accessor: (r) => r.startTime ?? "", cell: (r) => formatDate(r.startTime), sortable: true },
    {
      id: "cashier",
      header: "الكاشير",
      accessor: (r) => r.displayName || r.username || "",
      sortable: true,
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
      cell: (r) => formatCurrency(shiftDiff(r)),
      numeric: true,
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
        ملخّص إغلاق ورديات الكاشير مع إمكانية التصدير — المتوقّع، الفعلي، والفروقات.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile icon={ListChecks} label="إجمالي الورديات" value={<span dir="ltr" className="tabular-nums">{formatNumber(summary.total)}</span>} tone="teal" />
        <StatTile icon={DoorOpen} label="مفتوحة" value={<span dir="ltr" className="tabular-nums">{formatNumber(summary.open)}</span>} tone="amber" />
        <StatTile icon={DoorClosed} label="مغلقة" value={<span dir="ltr" className="tabular-nums">{formatNumber(summary.closed)}</span>} tone="emerald" />
        <StatTile icon={Calculator} label="إجمالي المتوقّع" value={<span dir="ltr" className="tabular-nums">{formatCurrency(summary.expected)}</span>} tone="teal" />
        <StatTile icon={Coins} label="إجمالي الفعلي" value={<span dir="ltr" className="tabular-nums">{formatCurrency(summary.actual)}</span>} tone="slate" />
        <StatTile icon={Scale} label="إجمالي الفرق" value={<span dir="ltr" className="tabular-nums">{formatCurrency(summary.variance)}</span>} tone={varianceTone} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => String(r.id)}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        exportFilename="cashier-shift-report"
        onExport={(data) => downloadRowsCsv(EXPORT_COLUMNS, data, "cashier-shift-report")}
        emptyTitle="لا توجد بيانات"
        emptyBody="لا توجد ورديات مطابقة لعوامل التصفية المحددة."
        initialSort={{ columnId: "date", dir: "desc" }}
        tableId="pos-admin-reports"
        filterBar={<ShiftFilters value={filters} onChange={setFilters} cashiers={cashiers} />}
      />
    </div>
  );
}
