import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Info,
  RefreshCw,
  Search,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/States";
import { Spinner } from "@/components/ui/spinner";
import { Drawer, DetailStat } from "@/components/drawer/Drawer";
import { formatCurrency, formatNumber, formatQty, formatDateTime } from "@/lib/formatters";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";
import { useWarehouseInventory, useInventoryCategories } from "@/lib/hooks/useInventory";
import { useInventoryItem } from "@/lib/hooks/useInventoryItem";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";
import { itemStatusLabel, ITEM_STATUS_OPTIONS, movementTypeLabel } from "@/lib/status-labels";
import type { InventoryRow } from "@/lib/adapters/inventory.adapter";

export function InventoryPage() {
  const { scope } = useWarehouseScope();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 350);
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<string>(params.get("status") ?? "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<InventoryRow | null>(null);

  // A status deep-link from the dashboard (?status=low) seeds the filter once.
  useEffect(() => {
    const s = params.get("status");
    if (s && s !== status) setStatus(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Any filter / scope / size change resets to page 1.
  useEffect(() => { setPage(1); }, [debouncedSearch, category, status, pageSize, scope]);

  const { data: categories } = useInventoryCategories(scope);
  const query = useWarehouseInventory({
    scope,
    q: debouncedSearch,
    category,
    status,
    page,
    pageSize,
    sort,
    dir,
  });
  const { data, isLoading, isError, error, refetch, isFetching, isPlaceholderData } = query;

  function toggleSort(key: string) {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(key); setDir("asc"); }
    setPage(1);
  }

  function setStatusFilter(s: string) {
    setStatus(s);
    const next = new URLSearchParams(params);
    if (s) next.set("status", s); else next.delete("status");
    setParams(next, { replace: true });
  }

  const header = (
    <PageHeader
      eyebrow="المواد والأرصدة"
      title="كتالوج المخزون"
      subtitle={
        scope === ALL_WAREHOUSES
          ? "رصيد موحّد عبر كل المستودعات — للقراءة فقط. القيمة بمتوسط تكلفة المستودع (WAC)."
          : "رصيد المستودع المحدّد فقط — للقراءة فقط."
      }
      action={
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> تحديث
        </Button>
      }
    />
  );

  if (isLoading) return <>{header}<LoadingState /></>;
  if (isError || !data) return <>{header}<ErrorState error={error} onRetry={() => refetch()} /></>;

  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);
  const anyEstimated = data.rows.some((r) => r.costEstimated);

  return (
    <>
      {header}

      <article className="surface overflow-hidden">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <label className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="field pr-10"
              placeholder="بحث بالاسم أو SKU..."
              aria-label="بحث في المخزون"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select className="field max-w-44" aria-label="الفئة" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">كل الفئات</option>
            {(categories ?? []).map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
          <div className="flex flex-wrap gap-1">
            {ITEM_STATUS_OPTIONS.map((o) => (
              <button
                key={o.value || "all"}
                type="button"
                onClick={() => setStatusFilter(o.value)}
                className={`min-h-10 rounded-xl border px-3 text-xs font-extrabold transition ${
                  status === o.value ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="mr-auto flex items-center gap-2 text-xs font-bold text-slate-400">
            {isFetching && <Spinner className="h-3.5 w-3.5" />}
            {formatNumber(data.total)} سطر
          </span>
        </div>

        {anyEstimated && (
          <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/60 px-4 py-2 text-[11px] font-bold text-amber-700">
            <Info className="h-3.5 w-3.5" /> القيمة المعلَّمة (≈) محسوبة بالتكلفة العامة لغياب متوسط تكلفة المستودع.
          </div>
        )}

        {data.rows.length === 0 ? (
          <EmptyState
            title={debouncedSearch || category || status ? "لا نتائج مطابقة" : "لا توجد أصناف"}
            body={debouncedSearch || category || status ? "جرّب تعديل البحث أو الفلاتر." : "لا توجد أصناف ذات رصيد ضمن هذا النطاق."}
          />
        ) : (
          <div className={`overflow-x-auto transition-opacity ${isPlaceholderData ? "opacity-60" : ""}`}>
            <table className="w-full min-w-[1040px] text-right">
              <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                <tr>
                  <SortableTh label="الصنف" col="name" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">المستودع</th>
                  <SortableTh label="الكمية" col="qty" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">المحجوز</th>
                  <th className="px-4 py-3">المتاح</th>
                  <SortableTh label="التكلفة" col="cost" sort={sort} dir={dir} onSort={toggleSort} />
                  <SortableTh label="القيمة" col="value" sort={sort} dir={dir} onSort={toggleSort} />
                  <th className="px-4 py-3">حد الطلب</th>
                  <th className="px-4 py-3">الحالة</th>
                  <th className="px-4 py-3">آخر حركة</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.warehouseId}:${r.itemId}`} className="table-row cursor-pointer" onClick={() => setSelected(r)}>
                    <td className="px-5 py-4">
                      <div className="font-extrabold text-slate-800">{r.name}</div>
                      <div className="mt-1 font-mono text-[11px] font-bold text-slate-400">{r.sku}{r.category ? ` · ${r.category}` : ""}</div>
                    </td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-500">{r.warehouseName || "—"}</td>
                    <td className="px-4 py-4 text-sm font-extrabold text-slate-900 tabular-nums">{formatQty(r.qty, r.unit)}</td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-400">—</td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(r.available)}</td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">
                      {r.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(r.avgCost)}
                    </td>
                    <td className="px-4 py-4 text-sm font-extrabold text-slate-800 tabular-nums">
                      {r.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(r.value)}
                    </td>
                    <td className="px-4 py-4 text-sm font-bold text-slate-500 tabular-nums">{r.reorderPoint > 0 ? formatNumber(r.reorderPoint) : "—"}</td>
                    <td className="px-4 py-4"><StatusBadge>{itemStatusLabel[r.status]}</StatusBadge></td>
                    <td className="px-4 py-4 text-xs font-bold text-slate-400">{formatDateTime(r.lastMovementAt)}</td>
                    <td className="px-5 py-4"><ChevronLeft className="h-4 w-4 text-slate-300" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-xs font-bold text-slate-400">
          <div className="flex items-center gap-3">
            <span>عرض {formatNumber(from)}–{formatNumber(to)} من {formatNumber(data.total)}</span>
            <select className="field h-9 min-h-9 w-auto py-0 text-xs" aria-label="حجم الصفحة" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => (<option key={n} value={n}>{n} / صفحة</option>))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="السابق" disabled={data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="px-2 tabular-nums">{formatNumber(data.page)} / {formatNumber(data.totalPages)}</span>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="التالي" disabled={data.page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </article>

      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        eyebrow="تفاصيل الصنف"
        icon={Boxes}
      >
        {selected && <ItemDetail row={selected} />}
      </Drawer>
    </>
  );
}

function SortableTh({ label, col, sort, dir, onSort }: { label: string; col: string; sort: string; dir: string; onSort: (c: string) => void }) {
  const active = sort === col;
  return (
    <th className="px-4 py-3">
      <button type="button" onClick={() => onSort(col)} className="inline-flex items-center gap-1 font-extrabold text-slate-400 hover:text-slate-700">
        {label}
        {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

function ItemDetail({ row }: { row: InventoryRow }) {
  const { distribution, movements } = useInventoryItem(row.itemId);
  return (
    <>
      <div className="flex items-center justify-between rounded-2xl bg-slate-950 p-5 text-white">
        <div>
          <div className="font-mono text-xs font-bold text-slate-400">{row.sku}</div>
          <div className="mt-2 text-2xl font-extrabold tabular-nums">
            {formatNumber(row.qty)} <span className="text-sm text-slate-400">{row.unit}</span>
          </div>
        </div>
        <StatusBadge>{itemStatusLabel[row.status]}</StatusBadge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <DetailStat label="القيمة" value={<>{row.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(row.value)}</>} />
        <DetailStat label="تكلفة الوحدة (WAC)" value={<>{row.costEstimated && <span className="text-amber-600">≈ </span>}{formatCurrency(row.avgCost)}</>} />
        <DetailStat label="حد إعادة الطلب" value={row.reorderPoint > 0 ? formatQty(row.reorderPoint, row.unit) : "—"} />
        <DetailStat label="المستودع" value={row.warehouseName || "—"} />
      </div>
      {row.costEstimated && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700">
          <Info className="h-3.5 w-3.5" /> القيمة تقديرية: لا يوجد متوسط تكلفة لهذا المستودع، فاستُخدمت التكلفة العامة.
        </div>
      )}

      <h3 className="mb-3 mt-6 text-sm font-extrabold text-slate-900">التوزيع حسب المستودع</h3>
      {distribution.isLoading ? (
        <div className="py-4"><Spinner /></div>
      ) : distribution.isError ? (
        <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs font-bold text-rose-700">تعذّر تحميل التوزيع.</div>
      ) : (distribution.data ?? []).length === 0 ? (
        <div className="text-xs font-bold text-slate-400">لا يوجد توزيع مسجّل.</div>
      ) : (
        <div className="space-y-2">
          {(distribution.data ?? []).map((d) => (
            <div key={d.warehouseId} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-3 text-sm">
              <span className="font-extrabold text-slate-700">{d.warehouseName}{d.isMain ? " · رئيسي" : ""}</span>
              <span className="font-bold text-slate-500 tabular-nums">{formatNumber(d.qty)} {row.unit} · {formatCurrency(d.value)}</span>
            </div>
          ))}
        </div>
      )}

      <h3 className="mb-3 mt-6 text-sm font-extrabold text-slate-900">آخر الحركات</h3>
      {movements.isLoading ? (
        <div className="py-4"><Spinner /></div>
      ) : movements.isError ? (
        <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs font-bold text-rose-700">تعذّر تحميل الحركات.</div>
      ) : (movements.data ?? []).length === 0 ? (
        <div className="text-xs font-bold text-slate-400">لا توجد حركات مسجّلة لهذا الصنف.</div>
      ) : (
        <div className="space-y-2">
          {(movements.data ?? []).map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-extrabold text-slate-700">{m.reason || movementTypeLabel(m.type)}</div>
                <div className="mt-0.5 text-[11px] font-bold text-slate-400">{formatDateTime(m.date)}{m.warehouseName ? ` · ${m.warehouseName}` : ""}</div>
              </div>
              <span className={`shrink-0 font-extrabold tabular-nums ${m.type === "in" ? "text-emerald-600" : "text-sky-600"}`}>
                {m.type === "in" ? "+" : "−"}{formatNumber(m.qty)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
