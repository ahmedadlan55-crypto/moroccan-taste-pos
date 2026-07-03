import { useMemo, useState } from "react";
import {
  ChevronLeft,
  Plus,
  RefreshCw,
  Search,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { Spinner } from "@/components/ui/spinner";
import { formatCurrency, formatNumber, formatDateTime } from "@/lib/formatters";
import { useCan } from "@/app/permission-provider";
import { useWarehouseAdminList } from "@/lib/hooks/useWarehouseAdmin";
import { warehouseHealth, alertCount, warehouseTypeLabel } from "@/lib/status-labels";
import type { WarehouseAdmin } from "@/lib/adapters/warehouse-admin.adapter";
import { WarehouseFormDialog } from "./WarehouseFormDialog";
import { WarehouseDetailDrawer } from "./WarehouseDetailDrawer";

// المستودعات — Phase W6: full management (create / edit / activate / deactivate /
// hard delete / scope assignments) on top of the read-only stats grid.
// List data comes from GET /api/inventory/v2/warehouses (scoped server-side).

type ActiveFilter = "all" | "active" | "inactive";

export function WarehousesPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useWarehouseAdminList();
  const canCreate = useCan("warehouse.create");
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
      subtitle="إدارة كاملة — البيانات، الرصيد والقيمة، الحركات، صلاحيات الوصول والتفعيل."
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className="h-4 w-4" /> تحديث
          </Button>
          {canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> مستودع جديد
            </Button>
          )}
        </div>
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
          body={query || activeFilter !== "all" ? "جرّب تعديل البحث أو الفلتر." : "ابدأ بإنشاء أول مستودع لهذا النطاق."}
          action={
            !query && activeFilter === "all" && canCreate ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> مستودع جديد
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Mobile: cards */}
          <div className="grid gap-4 md:hidden">
            {rows.map((w) => (
              <WarehouseCard key={w.id} w={w} onOpen={() => setSelectedId(w.id)} />
            ))}
          </div>

          {/* Desktop: table */}
          <article className="surface hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-right">
                <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                  <tr>
                    <th className="px-5 py-3">المستودع</th>
                    <th className="px-4 py-3">النوع</th>
                    <th className="px-4 py-3">الأصناف</th>
                    <th className="px-4 py-3">الكمية</th>
                    <th className="px-4 py-3">القيمة</th>
                    <th className="px-4 py-3">الحركات</th>
                    <th className="px-4 py-3">تنبيهات</th>
                    <th className="px-4 py-3">آخر حركة</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <tr key={w.id} className="table-row cursor-pointer" onClick={() => setSelectedId(w.id)}>
                      <td className="px-5 py-4">
                        <div className="font-extrabold text-slate-800">
                          {w.name}
                          {w.isMain && (
                            <span className="mr-2 rounded-md bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">رئيسي</span>
                          )}
                        </div>
                        <div className="mt-1 text-xs font-bold text-slate-400">{w.code}{w.location ? ` · ${w.location}` : ""}</div>
                      </td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-500">{warehouseTypeLabel(w.type)}</td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.itemCount)}</td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.totalQty)}</td>
                      <td className="px-4 py-4 text-sm font-extrabold text-slate-800 tabular-nums">{formatCurrency(w.totalValue)}</td>
                      <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.movementCount)}</td>
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

      <WarehouseDetailDrawer warehouseId={selectedId} onClose={() => setSelectedId(null)} />

      <WarehouseFormDialog
        open={createOpen}
        warehouse={null}
        onClose={() => setCreateOpen(false)}
        onSaved={(id) => {
          if (id) setSelectedId(id);
        }}
      />
    </>
  );
}

function WarehouseCard({ w, onOpen }: { w: WarehouseAdmin; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="surface group overflow-hidden text-right transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-lift">
      <div className="relative h-20 bg-slate-950 p-4 text-white">
        <div className="flex items-start justify-between">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/10"><WarehouseIcon className="h-5 w-5" /></span>
          <StatusBadge>{warehouseHealth(w)}</StatusBadge>
        </div>
      </div>
      <div className="p-4">
        <h3 className="font-extrabold text-slate-900">
          {w.name}
          {w.isMain && <span className="mr-2 rounded-md bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">رئيسي</span>}
        </h3>
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
