import { useMemo, useState } from "react";
import {
  Building2,
  ChevronLeft,
  Gauge,
  RefreshCw,
  Search,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { Spinner } from "@/components/ui/spinner";
import { Drawer, DetailStat } from "@/components/drawer/Drawer";
import { Progress } from "@/components/Progress";
import { formatCurrency, formatNumber, formatDateTime } from "@/lib/formatters";
import { useWarehouseScope } from "@/app/warehouse-scope-provider";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { warehouseHealth, alertCount, warehouseTypeLabel } from "@/lib/status-labels";
import type { WarehouseSummary } from "@/lib/adapters/dashboard.adapter";

type ActiveFilter = "all" | "active" | "inactive";

export function WarehousesPage() {
  const { scope } = useWarehouseScope();
  const { data, isLoading, isError, error, refetch, isFetching } = useWarehouses(scope);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [selected, setSelected] = useState<WarehouseSummary | null>(null);

  const rows = useMemo(() => {
    const list = data?.warehouses ?? [];
    const q = query.trim();
    return list.filter((w) => {
      const matchesQ = !q || `${w.name} ${w.code} ${w.manager} ${w.location}`.includes(q);
      const matchesActive =
        activeFilter === "all" || (activeFilter === "active" ? w.isActive : !w.isActive);
      return matchesQ && matchesActive;
    });
  }, [data, query, activeFilter]);

  const header = (
    <PageHeader
      eyebrow="البيانات الرئيسية"
      title="المستودعات والهيكل"
      subtitle="عرض للقراءة فقط — القيمة، الكمية، التنبيهات وآخر حركة لكل مستودع."
      action={
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> تحديث
        </Button>
      }
    />
  );

  if (isLoading) return <>{header}<LoadingState /></>;
  if (isError || !data) return <>{header}<ErrorState error={error} onRetry={() => refetch()} /></>;

  const totals = data.totals;

  return (
    <>
      {header}

      <div className="surface mb-4 flex flex-wrap items-center gap-3 p-4">
        <label className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="field pr-10"
            placeholder="بحث بالاسم أو الكود أو المسؤول..."
            aria-label="بحث في المستودعات"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          {(["all", "active", "inactive"] as ActiveFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setActiveFilter(f)}
              className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${
                activeFilter === f ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f === "all" ? "الكل" : f === "active" ? "نشط" : "معطّل"}
            </button>
          ))}
        </div>
        <span className="mr-auto flex items-center gap-2 text-xs font-bold text-slate-400">
          {isFetching && <Spinner className="h-3.5 w-3.5" />}
          {formatNumber(totals.activeCount)} نشط من {formatNumber(totals.warehouseCount)} · القيمة {formatCurrency(totals.totalValue)}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={query || activeFilter !== "all" ? "لا نتائج مطابقة" : "لا توجد مستودعات"}
          body={query || activeFilter !== "all" ? "جرّب تعديل البحث أو الفلتر." : "لم تُسجَّل أي مستودعات في هذا النطاق بعد."}
        />
      ) : (
        <>
          {/* Mobile: cards */}
          <div className="grid gap-4 md:hidden">
            {rows.map((w) => (
              <WarehouseCard key={w.id} w={w} onOpen={() => setSelected(w)} />
            ))}
          </div>

          {/* Desktop: table */}
          <article className="surface hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-right">
                <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                  <tr>
                    <th className="px-5 py-3">المستودع</th>
                    <th className="px-4 py-3">النوع</th>
                    <th className="px-4 py-3">الأصناف</th>
                    <th className="px-4 py-3">الكمية</th>
                    <th className="px-4 py-3">القيمة</th>
                    <th className="px-4 py-3">تنبيهات</th>
                    <th className="px-4 py-3">آخر حركة</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <tr key={w.id} className="table-row cursor-pointer" onClick={() => setSelected(w)}>
                      <td className="px-5 py-4">
                        <div className="font-extrabold text-slate-800">{w.name}</div>
                        <div className="mt-1 text-xs font-bold text-slate-400">{w.code}{w.location ? ` · ${w.location}` : ""}</div>
                      </td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-500">{warehouseTypeLabel(w.type)}</td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.itemCount)}</td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.totalQty)}</td>
                      <td className="px-4 py-4 text-sm font-extrabold text-slate-800 tabular-nums">{formatCurrency(w.totalValue)}</td>
                      <td className="px-4 py-4"><span className={`font-extrabold ${alertCount(w) > 0 ? "text-rose-600" : "text-slate-400"}`}>{formatNumber(alertCount(w))}</span></td>
                      <td className="px-4 py-4 text-xs font-bold text-slate-400">{formatDateTime(w.lastMovementAt)}</td>
                      <td className="px-4 py-4"><StatusBadge>{warehouseHealth(w)}</StatusBadge></td>
                      <td className="px-5 py-4"><ChevronLeft className="h-4 w-4 text-slate-300" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        eyebrow="تفاصيل المستودع"
        icon={WarehouseIcon}
      >
        {selected && <WarehouseDetail w={selected} />}
      </Drawer>
    </>
  );
}

function WarehouseCard({ w, onOpen }: { w: WarehouseSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="surface group overflow-hidden text-right transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-lift">
      <div className="relative h-20 bg-slate-950 p-4 text-white">
        <div className="flex items-start justify-between">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/10"><WarehouseIcon className="h-5 w-5" /></span>
          <StatusBadge>{warehouseHealth(w)}</StatusBadge>
        </div>
      </div>
      <div className="p-4">
        <h3 className="font-extrabold text-slate-900">{w.name}</h3>
        <p className="mt-1 text-xs font-bold text-slate-400">{w.code}{w.type ? ` · ${warehouseTypeLabel(w.type)}` : ""}</p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[["القيمة", formatCurrency(w.totalValue)], ["الأصناف", formatNumber(w.itemCount)], ["تنبيهات", formatNumber(alertCount(w))]].map(([l, v]) => (
            <div key={l} className="rounded-xl bg-slate-50 px-2 py-3 text-center">
              <div className="truncate text-xs font-extrabold text-slate-800 tabular-nums">{v}</div>
              <div className="mt-1 text-[10px] font-bold text-slate-400">{l}</div>
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}

function WarehouseDetail({ w }: { w: WarehouseSummary }) {
  const occ = Math.min(100, w.itemCount ? Math.round((alertCount(w) / Math.max(1, w.itemCount)) * 100) : 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <DetailStat label="الكود" value={w.code} />
        <DetailStat label="النوع" value={warehouseTypeLabel(w.type)} />
        <DetailStat label="القيمة" value={formatCurrency(w.totalValue)} />
        <DetailStat label="إجمالي الكمية" value={formatNumber(w.totalQty)} />
        <DetailStat label="عدد الأصناف" value={formatNumber(w.itemCount)} />
        <DetailStat label="آخر حركة" value={formatDateTime(w.lastMovementAt)} />
      </div>

      <div className="surface mt-4 p-4 shadow-none">
        <div className="mb-2 flex justify-between text-xs font-extrabold text-slate-600">
          <span>نسبة الأصناف ذات التنبيهات</span>
          <span>{occ}%</span>
        </div>
        <Progress value={occ} tone={occ > 25 ? "amber" : "teal"} />
      </div>

      <h3 className="mt-6 text-sm font-extrabold text-slate-900">تفصيل التنبيهات</h3>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <DetailStat label="منخفض" value={formatNumber(w.lowCount)} />
        <DetailStat label="نافد" value={formatNumber(w.outCount)} />
        <DetailStat label="سالب" value={formatNumber(w.negativeCount)} />
      </div>

      <h3 className="mt-6 text-sm font-extrabold text-slate-900">الروابط التشغيلية</h3>
      <div className="mt-3 space-y-2">
        {[
          ["الموقع", w.location || "—"],
          ["المسؤول", w.manager || "—"],
          ["الحالة", w.isActive ? "نشط" : "معطّل"],
          ["طريقة التقييم", "متوسط التكلفة المرجّح (WAC)"],
        ].map(([l, v]) => (
          <div key={l} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-3 text-sm">
            <span className="font-bold text-slate-400">{l}</span>
            <span className="font-extrabold text-slate-700">{v}</span>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-3 text-xs font-bold text-sky-700">
        <Building2 className="h-4 w-4" /> الإجراءات (تحويل / جرد / تعديل) تُضاف في مرحلة لاحقة — هذه الشاشة للقراءة فقط.
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs font-bold text-slate-400">
        <Gauge className="h-4 w-4" /> القيم بمتوسط تكلفة المستودع؛ تُقدَّر بالتكلفة العامة عند غياب WAC.
      </div>
    </>
  );
}
