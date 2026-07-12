import { useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, Search, Factory, ClipboardList, Wallet, PackageCheck } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatNumber, formatDate, formatQty } from "@/shared/lib";
import { productionStatusToLabel, PRODUCTION_STATUS_OPTIONS, PRODUCTION_PARTIAL_LABEL } from "@/modules/inventory/lib/status-labels";
import { useProductionList } from "@/modules/inventory/lib/hooks/useProduction";

const PAGE_SIZES = [10, 25, 50];

export function ProductionPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const canCreate = useCan("production.create");

  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const warehouseId = params.get("wh") ?? "";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const sort = params.get("sort") ?? "created_at";
  const dir = params.get("dir") === "asc" ? "asc" : "desc";

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useProductionList({ q, status, warehouseId, dateFrom, dateTo, page, pageSize, sort, dir });

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
        title="أوامر الإنتاج"
        subtitle="دورة تصنيع كاملة: مسودة ← اعتماد ← إصدار مواد (FEFO) ← تسجيل إنتاج جزئي وهدر ← إكمال وإغلاق — بتكلفة فعلية وقيود متوازنة."
        action={canCreate ? (<Button variant="primary" onClick={() => navigate("/inventory/production?new=1")}><Plus className="h-4 w-4" /> أمر إنتاج جديد</Button>) : null}
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="قيد التنفيذ" value={formatNumber(k?.inProgress ?? 0)} note={`${formatNumber(k?.partiallyCompleted ?? 0)} منها منجز جزئيًا`} icon={Factory} tone="blue" />
        <MetricCard label="بانتظار الإجراء" value={formatNumber((k?.draft ?? 0) + (k?.approved ?? 0))} note="مسودة أو معتمدة" icon={ClipboardList} tone="amber" />
        <MetricCard label="قيمة WIP الجارية" value={formatCurrency(k?.wipValue ?? 0)} note="مواد صُرفت ولم تُنتج بعد" icon={Wallet} tone="teal" />
        <MetricCard label="مكتملة/مغلقة" value={formatNumber((k?.completed ?? 0) + (k?.closed ?? 0))} note={`قيمة الإنتاج ${formatCurrency(k?.producedValue ?? 0)}`} icon={PackageCheck} tone="teal" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full pr-10" placeholder="بحث برقم الأمر أو الدفعة…" defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label="بحث" />
          </label>
          <select className="field lg:w-52" value={warehouseId} onChange={(e) => patch({ wh: e.target.value })} aria-label="المستودع">
            <option value="">كل المستودعات</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <input type="date" className="field lg:w-40" value={dateFrom} onChange={(e) => patch({ dateFrom: e.target.value })} aria-label="من تاريخ" />
          <input type="date" className="field lg:w-40" value={dateTo} onChange={(e) => patch({ dateTo: e.target.value })} aria-label="إلى تاريخ" />
        </div>
        <div className="flex flex-wrap gap-1">
          {PRODUCTION_STATUS_OPTIONS.map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState title="لا توجد أوامر إنتاج مطابقة" body={q || status || warehouseId ? "جرّب تعديل عوامل التصفية." : "ابدأ بإنشاء أمر إنتاج من وصفة (BOM)."} action={canCreate ? <Button onClick={() => navigate("/inventory/production?new=1")}><Plus className="h-4 w-4" /> أمر إنتاج جديد</Button> : undefined} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-right"><SortBtn label="رقم الأمر" col="order_number" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-right">المنتج</th>
                    <th className="px-4 py-3 text-right"><SortBtn label="الحالة" col="status" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-right"><SortBtn label="الكمية" col="qty_planned" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-right">المستودعات</th>
                    <th className="px-4 py-3 text-right"><SortBtn label="التاريخ" col="planned_date" sort={sort} dir={dir} onSort={toggleSort} /></th>
                    <th className="px-4 py-3 text-left">WIP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => navigate(`/inventory/production?doc=${r.id}`)}>
                      <td className="px-4 py-3">
                        <span className="font-extrabold text-slate-900">{r.number}</span>
                        {r.source === "legacy" && <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">قديم — للعرض</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{r.productName}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusBadge>{productionStatusToLabel(r.status)}</StatusBadge>
                          {r.partiallyCompleted && <StatusBadge>{PRODUCTION_PARTIAL_LABEL}</StatusBadge>}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-slate-700">
                        {formatQty(r.qtyProduced)} / {formatQty(r.qtyPlanned, r.productUnit)}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{r.warehouseName}{r.outputWarehouseId !== r.warehouseId ? ` ← ${r.outputWarehouseName}` : ""}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(r.plannedDate)}</td>
                      <td className="px-4 py-3 text-left font-bold tabular-nums text-slate-800">{formatCurrency(r.wipBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <button key={r.id} type="button" onClick={() => navigate(`/inventory/production?doc=${r.id}`)} className="surface block w-full p-4 text-right">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-extrabold text-slate-900">{r.number}</span>
                    <StatusBadge>{productionStatusToLabel(r.status)}</StatusBadge>
                  </div>
                  <div className="mt-1 text-sm font-medium text-slate-600">{r.productName}</div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{formatQty(r.qtyProduced)} / {formatQty(r.qtyPlanned, r.productUnit)} · {formatDate(r.plannedDate)}</span>
                    <span className="font-bold text-slate-800">{formatCurrency(r.wipBalance)}</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <div className="flex items-center gap-3 text-xs font-medium text-slate-500">
                <span>عرض {formatNumber(from)}–{formatNumber(to)} من {formatNumber(pg?.total ?? 0)}</span>
                <select className="field min-h-9 py-1 text-xs" value={pageSize} onChange={(e) => patch({ pageSize: e.target.value })} aria-label="حجم الصفحة">{PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / صفحة</option>)}</select>
                {isFetching && <span className="text-teal-600">تحديث…</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" aria-label="السابق" disabled={page <= 1} onClick={() => patch({ page: page - 1 }, false)}><ChevronRight className="h-4 w-4" /></Button>
                <span className="text-xs font-bold text-slate-600">{formatNumber(page)} / {formatNumber(totalPages)}</span>
                <Button variant="ghost" size="icon" aria-label="التالي" disabled={page >= totalPages} onClick={() => patch({ page: page + 1 }, false)}><ChevronLeft className="h-4 w-4" /></Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SortBtn({ label, col, sort, dir, onSort }: { label: string; col: string; sort: string; dir: string; onSort: (c: string) => void }) {
  return (
    <button type="button" className="inline-flex items-center gap-1 font-bold hover:text-slate-800" onClick={() => onSort(col)}>
      {label}{sort === col && <span aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>}
    </button>
  );
}
