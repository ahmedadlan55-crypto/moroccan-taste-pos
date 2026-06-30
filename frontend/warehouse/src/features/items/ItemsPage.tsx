import { useSearchParams, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, Search, Boxes, CheckCircle2, XCircle, Tag } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, EmptyState, ErrorState } from "@/components/states/States";
import { useCan } from "@/app/permission-provider";
import { formatCurrency, formatNumber } from "@/lib/formatters";
import { ITEM_ACTIVE_OPTIONS } from "@/lib/status-labels";
import { useItemList, useItemCategories } from "@/lib/hooks/useItems";
import { ItemDetailDrawer } from "./ItemDetailDrawer";

const PAGE_SIZES = [10, 25, 50];

export function ItemsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const canCreate = useCan("item.create");
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const category = params.get("category") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 25;
  const view = params.get("view");

  function patch(next: Record<string, string | number | null>, resetPage = true) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === "") p.delete(k); else p.set(k, String(v)); }
    if (resetPage && !("page" in next)) p.delete("page");
    setParams(p, { replace: true });
  }
  const { data, isLoading, isError, error, refetch, isFetching } = useItemList({ q, status, category, page, pageSize, sort: "name", dir: "asc" });
  const cats = useItemCategories();
  const k = data?.kpis; const pg = data?.pagination; const totalPages = pg?.totalPages ?? 1;
  const from = pg && pg.total > 0 ? (pg.page - 1) * pg.pageSize + 1 : 0;
  const to = pg ? Math.min(pg.page * pg.pageSize, pg.total) : 0;

  return (
    <div>
      <PageHeader eyebrow="البيانات الرئيسية" title="كتالوج الأصناف" subtitle="إدارة بيانات الأصناف، الإسناد للمستودعات، وقواعد إعادة الطلب."
        action={canCreate ? <Button variant="primary" onClick={() => navigate("/items/new")}><Plus className="h-4 w-4" /> صنف جديد</Button> : null} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="الإجمالي" value={formatNumber(k?.total ?? 0)} note="أصناف غير محذوفة" icon={Boxes} tone="blue" />
        <MetricCard label="نشط" value={formatNumber(k?.active ?? 0)} note="قابل للاستخدام" icon={CheckCircle2} tone="teal" />
        <MetricCard label="غير نشط" value={formatNumber(k?.inactive ?? 0)} note="محفوظ التاريخ" icon={XCircle} tone="rose" />
        <MetricCard label="بلا SKU" value={formatNumber(k?.noSku ?? 0)} note="أصناف قديمة" icon={Tag} tone="amber" />
      </section>

      <section className="surface mt-4 flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field w-full pr-10" placeholder="بحث بالاسم أو SKU…" defaultValue={q} onChange={(e) => patch({ q: e.target.value })} aria-label="بحث" />
          </label>
          <select className="field lg:w-52" value={category} onChange={(e) => patch({ category: e.target.value })} aria-label="الفئة">
            <option value="">كل الفئات</option>
            {(cats.data ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {ITEM_ACTIVE_OPTIONS.map((o) => (
            <button key={o.value} type="button" onClick={() => patch({ status: o.value })}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{o.label}</button>
          ))}
        </div>
      </section>

      <section className="mt-4">
        {isLoading ? <LoadingState /> : isError ? <ErrorState error={error} onRetry={() => refetch()} /> : !data || data.rows.length === 0 ? (
          <EmptyState title="لا توجد أصناف مطابقة" body={q || status || category ? "جرّب تعديل عوامل التصفية." : "ابدأ بإضافة صنف."} action={canCreate ? <Button onClick={() => navigate("/items/new")}><Plus className="h-4 w-4" /> صنف جديد</Button> : undefined} />
        ) : (
          <>
            <div className="surface hidden overflow-hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr>
                  <th className="px-4 py-3 text-right">الصنف</th><th className="px-4 py-3 text-right">SKU</th><th className="px-4 py-3 text-right">الفئة</th>
                  <th className="px-4 py-3 text-right">الوحدة</th><th className="px-4 py-3 text-left">التكلفة العامة</th><th className="px-4 py-3 text-right">الحالة</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer transition hover:bg-slate-50" onClick={() => patch({ view: r.id }, false)}>
                      <td className="px-4 py-3 font-extrabold text-slate-900">{r.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{r.sku || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{r.category || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{r.unit}</td>
                      <td className="px-4 py-3 text-left tabular-nums text-slate-700">{formatCurrency(r.cost)}</td>
                      <td className="px-4 py-3"><StatusBadge>{r.active ? "نشط" : "غير نشط"}</StatusBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <button key={r.id} type="button" onClick={() => patch({ view: r.id }, false)} className="surface block w-full p-4 text-right">
                  <div className="flex items-center justify-between gap-2"><span className="font-extrabold text-slate-900">{r.name}</span><StatusBadge>{r.active ? "نشط" : "غير نشط"}</StatusBadge></div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500"><span className="font-mono">{r.sku || "—"} · {r.category || "—"}</span><span className="font-bold text-slate-800">{formatCurrency(r.cost)} / {r.unit}</span></div>
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

      <ItemDetailDrawer id={view} onClose={() => patch({ view: null }, false)} onEdit={(id) => navigate(`/items/new?edit=${id}`)} />
    </div>
  );
}
