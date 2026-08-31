import { useMemo, useState } from "react";
import { Download, Info } from "lucide-react";
import { Button, PrintDocument, Select } from "@/shared/ui";
import { formatAsAt } from "@/shared/lib";
import { Pagination } from "@/shared/tables";
import { useT, type TFunction } from "@/i18n";
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

const ITEM_TYPES = ["raw", "semi", "finished"];
function itemTypeLabel(t: TFunction, type: string): string {
  return ITEM_TYPES.includes(type) ? t(`accounting.invValuation.itemType.${type}`) : type;
}

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

function itemsCsv(t: TFunction, items: ValuationItem[], applied: InventoryValuationFilter) {
  exportRowsCsv(
    `inventory-valuation-${todayISO()}${applied.warehouseId ? `-wh-${applied.warehouseId}` : ""}.csv`,
    [
      t("accounting.invValuation.col.warehouse"),
      t("accounting.invValuation.col.item"),
      t("accounting.invValuation.col.sku"),
      t("accounting.invValuation.col.unit"),
      t("accounting.invValuation.col.type"),
      t("accounting.invValuation.col.qty"),
      t("accounting.invValuation.col.unitCost"),
      t("accounting.invValuation.col.value"),
    ],
    items.map((it) => [
      it.warehouseName || "—",
      it.itemName,
      it.sku,
      it.unit,
      itemTypeLabel(t, it.itemType),
      it.qty,
      it.avgCost,
      it.value,
    ]),
  );
}

export function InventoryValuationPage() {
  const t = useT();
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
    warehouses.data?.find((w) => w.id === filter.applied.warehouseId)?.name ?? t("accounting.invValuation.allWarehouses");
  const brandName = brands.data?.find((b) => b.id === filter.applied.brandId)?.name ?? t("accounting.invValuation.allBrands");
  // The date is WHEN, the warehouse/brand pair is WHAT SCOPE — PrintDocument
  // keeps them apart (`subtitle` vs `meta`) instead of running all three into
  // one dot-separated string.
  const asAt = formatAsAt(todayISO());
  const scope = `${whName} · ${brandName}`;

  return (
    <div>
      <ReportHeader
        title={t("accounting.invValuation.title")}
        subtitle={t("accounting.invValuation.subtitle")}
        onPrint={printReport}
        pdf={{ filename: "inventory-valuation", landscape: true }}
        extraActions={
          items.length > 0 && (
            <Button variant="secondary" onClick={() => itemsCsv(t, items, filter.applied)}>
              <Download className="h-4 w-4" /> {t("table.exportCsv")}
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
        <FilterField label={t("accounting.invValuation.warehouse")}>
          <Select
            value={filter.draft.warehouseId}
            onChange={(e) => filter.patch({ warehouseId: e.target.value })}
          >
            <option value="">{t("accounting.invValuation.allWarehouses")}</option>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label={t("accounting.invValuation.brand")}>
          <Select value={filter.draft.brandId} onChange={(e) => filter.patch({ brandId: e.target.value })}>
            <option value="">{t("accounting.invValuation.allBrands")}</option>
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
        emptyBody={t("accounting.invValuation.empty")}
      >
        {data && (
          <>
            {/* The cost basis SURVIVES — a valuation whose basis is unstated is
                unreadable — but as one compact screen chip, not a three-line
                amber panel printed on top of the report. The basis itself also
                rides onto the paper as PrintDocument's `meta`, so the printed
                sheet still says what the figures were valued at. */}
            <div className="no-print mb-4 inline-flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t("accounting.invValuation.costNote")}
                {data.costBasis && (
                  <>
                    {" — "}
                    <code>{data.costBasis}</code>
                  </>
                )}
              </span>
            </div>

            <PrintDocument
              title={t("accounting.invValuation.title")}
              subtitle={asAt}
              meta={scope}
            >
            <div className="mb-5 grid gap-3 sm:grid-cols-3">
              <Kpi label={t("accounting.invValuation.itemCount")} value={data.grand.itemCount} isCount />
              <Kpi label={t("accounting.invValuation.totalQty")} value={data.grand.totalQty} />
              <Kpi label={t("accounting.invValuation.totalValue")} value={data.grand.totalValue} />
            </div>

            {data.byWarehouse.length > 0 && (
              <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.byWarehouse.map((w, i) => (
                  <div key={w.warehouseId || `wh-${i}`} className="surface p-4">
                    <div className="text-sm font-extrabold text-slate-900">
                      {w.warehouseName || t("accounting.invValuation.noWarehouse")}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs font-bold text-slate-600">
                      <span>
                        {t("accounting.invValuation.items")} <span dir="ltr" className="tabular-nums">{w.itemCount}</span>
                      </span>
                      <span>
                        {t("accounting.invValuation.qty")} <span dir="ltr" className="tabular-nums">{fmt(w.totalQty)}</span>
                      </span>
                      <span>
                        {t("accounting.invValuation.value")} <Num value={w.totalValue} strong />
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
                      <th className="px-3 py-2 text-start">{t("accounting.invValuation.col.warehouse")}</th>
                      <th className="px-3 py-2 text-start">{t("accounting.invValuation.col.item")}</th>
                      <th className="px-3 py-2 text-start">{t("accounting.invValuation.col.sku")}</th>
                      <th className="px-3 py-2 text-start">{t("accounting.invValuation.col.unit")}</th>
                      <th className="px-3 py-2 text-start">{t("accounting.invValuation.col.type")}</th>
                      <th className="px-3 py-2 text-end">{t("accounting.invValuation.col.qty")}</th>
                      <th className="px-3 py-2 text-end">{t("accounting.invValuation.col.unitCost")}</th>
                      <th className="px-3 py-2 text-end">{t("accounting.invValuation.col.value")}</th>
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
                          <td className="px-3 py-2 text-slate-600">{itemTypeLabel(t, it.itemType)}</td>
                          <td className="px-3 py-2 text-end"><Num value={it.qty} dash={false} /></td>
                          <td className="px-3 py-2 text-end"><Num value={it.avgCost} dash={false} /></td>
                          <td className="px-3 py-2 text-end"><Num value={it.value} strong dash={false} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
                      <td colSpan={5} className="px-3 py-2.5 text-start">{t("accounting.common.total")}</td>
                      <td className="px-3 py-2.5 text-end"><Num value={data.grand.totalQty} strong /></td>
                      <td className="px-3 py-2.5 text-end" />
                      <td className="px-3 py-2.5 text-end"><Num value={data.grand.totalValue} strong /></td>
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
            </PrintDocument>
          </>
        )}
      </ReportState>
    </div>
  );
}
