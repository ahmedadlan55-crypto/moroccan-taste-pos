import { useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Truck,
  PackageCheck,
  ClipboardList,
  Hourglass,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState, ErrorState } from "@/components/states/States";
import { useTransfers } from "@/lib/hooks/useTransfers";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { useCan } from "@/app/permission-provider";
import { formatCurrency, formatNumber, formatQty, formatDate } from "@/lib/formatters";
import { transferStatusToLabel, TRANSFER_STATUS_OPTIONS } from "@/lib/status-labels";
import type { TransferListRow } from "@/lib/adapters/transfer.adapter";
import { TransferDetailDrawer } from "./TransferDetailDrawer";

const PAGE_SIZES = [10, 25, 50];

// Sortable columns → backend sort key (the read router whitelists these).
const COLUMNS: { key: string; label: string; sort?: string; className?: string }[] = [
  { key: "number", label: "رقم التحويل", sort: "issue_number" },
  { key: "route", label: "من ← إلى" },
  { key: "status", label: "الحالة", sort: "status" },
  { key: "date", label: "التاريخ", sort: "issue_date" },
  { key: "lines", label: "الأصناف", className: "text-center" },
  { key: "remaining", label: "المتبقي", className: "text-center" },
  { key: "value", label: "القيمة", sort: "total_cost", className: "text-left" },
];

export function TransfersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const canCreate = useCan("transfer.create");

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const fromWh = params.get("from") ?? "";
  const toWh = params.get("to") ?? "";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const sort = params.get("sort") ?? "created_at";
  const dir = params.get("dir") === "asc" ? "asc" : "desc";
  const view = params.get("view");

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, String(v));
    }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useTransfers({
    q, status, fromWarehouseId: fromWh, toWarehouseId: toWh, dateFrom, dateTo, page, pageSize, sort, dir,
  });

  // Source/destination options: a scoped user only sees their warehouses.
  const allWh = useWarehouses();
  const whOptions = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  function toggleSort(col: string) {
    if (sort === col) patch({ dir: dir === "asc" ? "desc" : "asc" }, false);
    else patch({ sort: col, dir: "desc" }, false);
  }

  const k = data?.kpis;
  const pg = data?.pagination;
  const totalPages = pg?.totalPages ?? 1;
  const from = pg && pg.total > 0 ? (pg.page - 1) * pg.pageSize + 1 : 0;
  const to = pg ? Math.min(pg.page * pg.pageSize, pg.total) : 0;

  return (
    <div>
      <PageHeader
        eyebrow="العمليات"
        title="التحويلات وإذونات الصرف"
        subtitle="نقل المخزون بين المستودعات عبر دورة اعتماد وصرف واستلام قابلة للتدقيق."
        action={
          canCreate ? (
            <Button variant="primary" onClick={() => navigate("/transfers/new")}>
              <Plus className="h-4 w-4" /> تحويل جديد
            </Button>
          ) : null
        }
      />

      {/* KPI row */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="قيد النقل" value={formatNumber(k?.inTransit ?? 0)} note={`متبقٍ استلامه ${formatQty(k?.remainingQty ?? 0)}`} icon={Truck} tone="blue" />
        <MetricCard label="بانتظار الإجراء" value={formatNumber(k?.pending ?? 0)} note="مسودة أو بانتظار الاعتماد" icon={Hourglass} tone="amber" />
        <MetricCard label="مسودات" value={formatNumber(k?.draft ?? 0)} note="لم تُعتمد بعد" icon={ClipboardList} />
        <MetricCard label="مكتملة" value={formatNumber(k?.received ?? 0)} note="استُلمت بالكامل" icon={PackageCheck} tone="teal" />
      </section>

      {/* Filters */}
      <section className="surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="field w-full pr-10"
              placeholder="بحث برقم التحويل أو اسم المستودع…"
              defaultValue={q}
              onChange={(e) => patch({ q: e.target.value })}
              aria-label="بحث"
            />
          </label>
          <select className="field lg:w-48" value={fromWh} onChange={(e) => patch({ from: e.target.value })} aria-label="المستودع المصدر">
            <option value="">كل المصادر</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select className="field lg:w-48" value={toWh} onChange={(e) => patch({ to: e.target.value })} aria-label="المستودع الوجهة">
            <option value="">كل الوجهات</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <input type="date" className="field lg:w-40" value={dateFrom} onChange={(e) => patch({ dateFrom: e.target.value })} aria-label="من تاريخ" />
          <input type="date" className="field lg:w-40" value={dateTo} onChange={(e) => patch({ dateTo: e.target.value })} aria-label="إلى تاريخ" />
        </div>
        <div className="flex flex-wrap gap-1">
          {TRANSFER_STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${
                status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      {/* Body */}
      <section className="mt-4">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            title="لا توجد تحويلات مطابقة"
            body={q || status || fromWh || toWh ? "جرّب تعديل عوامل التصفية." : "ابدأ بإنشاء تحويل جديد بين مستودعين."}
            action={canCreate ? <Button onClick={() => navigate("/transfers/new")}><Plus className="h-4 w-4" /> تحويل جديد</Button> : undefined}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className={`px-4 py-3 text-right ${c.className ?? ""}`}>
                        {c.sort ? (
                          <button type="button" className="inline-flex items-center gap-1 font-bold hover:text-slate-800" onClick={() => toggleSort(c.sort!)}>
                            {c.label}
                            {sort === c.sort && <span aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>}
                          </button>
                        ) : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => patch({ view: r.id }, false)}>
                      <td className="px-4 py-3 font-extrabold text-slate-900">{r.number}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <span className="inline-flex items-center gap-1.5">
                          {r.fromWarehouse.name}
                          <ArrowLeftRight className="h-3.5 w-3.5 text-slate-400" />
                          {r.toWarehouse.name}
                        </span>
                      </td>
                      <td className="px-4 py-3"><StatusBadge>{transferStatusToLabel(r.status)}</StatusBadge></td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(r.issueDate)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-slate-600">{formatNumber(r.lineCount)}</td>
                      <td className="px-4 py-3 text-center tabular-nums text-slate-600">{formatQty(r.remainingQty)}</td>
                      <td className="px-4 py-3 text-left font-bold tabular-nums text-slate-800">{formatCurrency(r.totalCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <button key={r.id} type="button" onClick={() => patch({ view: r.id }, false)} className="surface block w-full p-4 text-right">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-900">{r.number}</span>
                    <StatusBadge>{transferStatusToLabel(r.status)}</StatusBadge>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                    {r.fromWarehouse.name}<ArrowLeftRight className="h-3 w-3" />{r.toWarehouse.name}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{formatDate(r.issueDate)} · {formatNumber(r.lineCount)} صنف</span>
                    <span className="font-bold text-slate-800">{formatCurrency(r.totalCost)}</span>
                  </div>
                </button>
              ))}
            </div>

            {/* Pagination */}
            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                <span>عرض {formatNumber(from)}–{formatNumber(to)} من {formatNumber(pg?.total ?? 0)}</span>
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label="حجم الصفحة">
                  {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / صفحة</option>)}
                </select>
                {isFetching && <span className="text-teal-600">تحديث…</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label="السابق" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <span className="text-xs font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label="التالي" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <TransferDetailDrawer id={view} onClose={() => patch({ view: null }, false)} />
    </div>
  );
}

export type { TransferListRow };
