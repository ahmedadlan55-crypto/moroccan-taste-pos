import { useMemo, useState } from "react";
import { Download, Info } from "lucide-react";
import { Button, Select } from "@/shared/ui";
import { Pagination } from "@/shared/tables";
import {
  useInventoryValuation,
  useWarehousesLookup,
  useBrands,
  todayISO,
  type InventoryValuationFilter,
  type ValuationItem,
} from "../api";
import {
  Num,
  fmt,
  ReportHeader,
  FilterCard,
  FilterField,
  PrintArea,
  PrintBanner,
  ReportState,
  useAppliedFilter,
  printReport,
  exportRowsCsv,
} from "../components";

// /accounting/inventory-valuation — converted from the legacy-only
// erpRptInventoryValuation. Stock × recorded item cost per item, grouped by
// warehouse. The server owns the math; the cost basis (recorded item cost, NOT
// a moving average) is stated honestly on-screen.

const PAGE_SIZE = 50;
/** Client-side pagination kicks in at this row count (spec: ≥100). */
const PAGINATE_AT = 100;

const ITEM_TYPE_LABEL: Record<string, string> = {
  raw: "خام",
  semi: "نصف مصنّع",
  finished: "تام الصنع",
};

function Kpi({ label, value, isCount = false }: { label: string; value: number; isCount?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-bold text-slate-500">{label}</div>
      <div dir="ltr" className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900">
        {isCount ? Math.round(value).toLocaleString("en-US") : fmt(value)}
      </div>
    </div>
  );
}

function itemsCsv(items: ValuationItem[], applied: InventoryValuationFilter) {
  exportRowsCsv(
    `inventory-valuation-${todayISO()}${applied.warehouseId ? `-wh-${applied.warehouseId}` : ""}.csv`,
    ["المستودع", "الصنف", "SKU", "الوحدة", "النوع", "الكمية", "تكلفة الوحدة", "القيمة"],
    items.map((it) => [
      it.warehouseName || "—",
      it.itemName,
      it.sku,
      it.unit,
      ITEM_TYPE_LABEL[it.itemType] ?? it.itemType,
      it.qty,
      it.avgCost,
      it.value,
    ]),
  );
}

export function InventoryValuationPage() {
  const filter = useAppliedFilter<InventoryValuationFilter>({ warehouseId: "", brandId: "" });
  const query = useInventoryValuation(filter.applied);
  const warehouses = useWarehousesLookup();
  const brands = useBrands();
  const data = query.data;
  const [page, setPage] = useState(1);

  const items = useMemo(() => data?.items ?? [], [data]);
  const paginated = items.length >= PAGINATE_AT;
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;

  const whName =
    warehouses.data?.find((w) => w.id === filter.applied.warehouseId)?.name ?? "كل المستودعات";
  const brandName = brands.data?.find((b) => b.id === filter.applied.brandId)?.name ?? "كل العلامات";
  const period = `كما في ${todayISO()} · ${whName} · ${brandName}`;

  return (
    <div>
      <ReportHeader
        title="تقييم المخزون"
        subtitle="قيمة المخزون الحالي = الكمية × تكلفة الصنف المسجلة، لكل صنف ومستودع — يحسبها الخادم."
        onPrint={printReport}
        extraActions={
          items.length > 0 && (
            <Button variant="secondary" onClick={() => itemsCsv(items, filter.applied)}>
              <Download className="h-4 w-4" /> تصدير CSV
            </Button>
          )
        }
      />
      <FilterCard
        onRun={() => {
          setPage(1);
          filter.run();
        }}
        running={query.isFetching}
      >
        <FilterField label="المستودع">
          <Select
            value={filter.draft.warehouseId}
            onChange={(e) => filter.patch({ warehouseId: e.target.value })}
          >
            <option value="">كل المستودعات</option>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="العلامة التجارية">
          <Select value={filter.draft.brandId} onChange={(e) => filter.patch({ brandId: e.target.value })}>
            <option value="">كل العلامات</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={!!data && items.length === 0}
        onRetry={() => query.refetch()}
        emptyBody="لا توجد أصناف برصيد موجب ضمن النطاق المحدد."
      >
        {data && (
          <PrintArea>
            <div className="surface mb-5 p-4">
              <PrintBanner title="تقييم المخزون" period={period} />
              {/* Honest cost-basis note: the recorded item cost, NOT a moving average. */}
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-bold">
                    التكلفة = تكلفة الصنف المسجلة، ليست متوسطًا متحركًا.
                  </div>
                  {data.note && <div className="mt-1 font-medium">{data.note}</div>}
                  {data.costBasis && (
                    <div className="mt-1 font-medium text-amber-700">
                      أساس التكلفة: <code>{data.costBasis}</code>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mb-5 grid gap-3 sm:grid-cols-3">
              <Kpi label="عدد الأصناف" value={data.grand.itemCount} isCount />
              <Kpi label="إجمالي الكمية" value={data.grand.totalQty} />
              <Kpi label="إجمالي القيمة" value={data.grand.totalValue} />
            </div>

            {data.byWarehouse.length > 0 && (
              <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.byWarehouse.map((w, i) => (
                  <div key={w.warehouseId || `wh-${i}`} className="surface p-4">
                    <div className="text-sm font-extrabold text-slate-900">
                      {w.warehouseName || "بدون مستودع"}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs font-bold text-slate-600">
                      <span>
                        الأصناف: <span dir="ltr" className="tabular-nums">{w.itemCount}</span>
                      </span>
                      <span>
                        الكمية: <span dir="ltr" className="tabular-nums">{fmt(w.totalQty)}</span>
                      </span>
                      <span>
                        القيمة: <Num value={w.totalValue} strong />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="surface overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
                      <th className="px-3 py-2 text-right">المستودع</th>
                      <th className="px-3 py-2 text-right">الصنف</th>
                      <th className="px-3 py-2 text-right">SKU</th>
                      <th className="px-3 py-2 text-right">الوحدة</th>
                      <th className="px-3 py-2 text-right">النوع</th>
                      <th className="px-3 py-2 text-left">الكمية</th>
                      <th className="px-3 py-2 text-left">تكلفة الوحدة</th>
                      <th className="px-3 py-2 text-left">القيمة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      const onPage = !paginated || (idx >= pageStart && idx < pageEnd);
                      return (
                        <tr
                          key={`${it.warehouseId}-${it.itemId}-${idx}`}
                          // Off-page rows stay in the DOM hidden so PRINT always
                          // gets the FULL table, not just the visible page.
                          className={`border-b border-slate-50 last:border-0 hover:bg-slate-50/70 ${
                            onPage ? "" : "hidden print:table-row"
                          }`}
                        >
                          <td className="px-3 py-2 text-slate-500">{it.warehouseName || "—"}</td>
                          <td className="px-3 py-2 font-semibold text-slate-800">{it.itemName}</td>
                          <td className="px-3 py-2"><code className="text-[11px] text-slate-400">{it.sku}</code></td>
                          <td className="px-3 py-2 text-slate-600">{it.unit || "—"}</td>
                          <td className="px-3 py-2 text-slate-600">{ITEM_TYPE_LABEL[it.itemType] ?? it.itemType}</td>
                          <td className="px-3 py-2 text-left"><Num value={it.qty} dash={false} /></td>
                          <td className="px-3 py-2 text-left"><Num value={it.avgCost} dash={false} /></td>
                          <td className="px-3 py-2 text-left"><Num value={it.value} strong dash={false} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
                      <td colSpan={5} className="px-3 py-2.5 text-right">الإجمالي</td>
                      <td className="px-3 py-2.5 text-left"><Num value={data.grand.totalQty} strong /></td>
                      <td className="px-3 py-2.5 text-left" />
                      <td className="px-3 py-2.5 text-left"><Num value={data.grand.totalValue} strong /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {paginated && (
                <div className="no-print">
                  <Pagination
                    page={safePage}
                    pageCount={pageCount}
                    total={items.length}
                    pageSize={PAGE_SIZE}
                    onPageChange={setPage}
                  />
                </div>
              )}
            </div>
          </PrintArea>
        )}
      </ReportState>
    </div>
  );
}
