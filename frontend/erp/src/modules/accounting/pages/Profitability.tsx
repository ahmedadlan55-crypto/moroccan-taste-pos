import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download } from "lucide-react";
import { Button, DatePicker, PrintDocument, Select } from "@/shared/ui";
import { formatForPeriod } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  useProfitability,
  startOfYearISO,
  todayISO,
  PROFITABILITY_DIMENSIONS,
  profitabilityDimLabel,
  type ProfitabilityFilter,
  type ProfitabilityRow,
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

// /accounting/profitability — converted from the legacy-only erpRptProfitability.
// Revenue − Expenses per dimension value (brand / branch / cost center); the
// server owns the math including the margin — this screen only sorts and renders.

type SortKey = keyof Pick<ProfitabilityRow, "name" | "revenue" | "expenses" | "profit" | "margin">;
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

const COLUMN_KEYS: Array<{ key: SortKey; numeric: boolean }> = [
  { key: "name", numeric: false },
  { key: "revenue", numeric: true },
  { key: "expenses", numeric: true },
  { key: "profit", numeric: true },
  { key: "margin", numeric: true },
];
const COLUMN_LABEL_KEY: Record<SortKey, string> = {
  name: "accounting.profitability.col.dimension",
  revenue: "accounting.profitability.col.revenue",
  expenses: "accounting.profitability.col.expenses",
  profit: "accounting.profitability.col.profit",
  margin: "accounting.profitability.col.margin",
};

/** Margin is only meaningful with positive revenue — otherwise show a dash,
 *  never a fabricated 0%. */
function MarginCell({ row }: { row: ProfitabilityRow }) {
  if (row.revenue <= 0) return <span className="tabular-nums text-slate-300">—</span>;
  return (
    <span dir="ltr" className={`tabular-nums font-semibold ${row.margin < 0 ? "text-rose-600" : "text-slate-700"}`}>
      {fmt(row.margin)}%
    </span>
  );
}

export function ProfitabilityPage() {
  const t = useT();
  const filter = useAppliedFilter<ProfitabilityFilter>({
    dimension: "brand",
    from: startOfYearISO(),
    to: todayISO(),
  });
  const query = useProfitability(filter.applied);
  const data = query.data;
  const [sort, setSort] = useState<SortState>({ key: "profit", dir: "desc" });

  const rows = useMemo(() => {
    const src = data?.rows ?? [];
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...src].sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va ?? "").localeCompare(String(vb ?? ""), "ar", { numeric: true }) * dir;
    });
  }, [data, sort]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.revenue += r.revenue;
          acc.expenses += r.expenses;
          acc.profit += r.profit;
          return acc;
        },
        { revenue: 0, expenses: 0, profit: 0 },
      ),
    [rows],
  );

  const dimLabel = profitabilityDimLabel(t, filter.applied.dimension);
  // WHEN and BY WHAT are two different facts about the run — PrintDocument
  // gives them two slots (`subtitle`, `meta`) instead of one joined string.
  const period = formatForPeriod(filter.applied.from, filter.applied.to);
  const groupedBy = t("accounting.profitability.periodBy", { dimension: dimLabel });

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  const sortIcon = (key: SortKey) => {
    if (sort.key !== key) return <ChevronsUpDown className="h-3.5 w-3.5 text-slate-300" />;
    return sort.dir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5 text-teal-600" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 text-teal-600" />
    );
  };

  return (
    <div>
      <ReportHeader
        title={t("accounting.profitability.title")}
        subtitle={t("accounting.profitability.subtitle")}
        onPrint={printReport}
        extraActions={
          rows.length > 0 && (
            <Button
              variant="secondary"
              onClick={() =>
                exportRowsCsv(
                  `profitability-${filter.applied.dimension}-${filter.applied.from}-${filter.applied.to}.csv`,
                  COLUMN_KEYS.map((c) => t(COLUMN_LABEL_KEY[c.key])),
                  rows.map((r) => [r.name, r.revenue, r.expenses, r.profit, r.revenue > 0 ? r.margin : "—"]),
                )
              }
            >
              <Download className="h-4 w-4" /> {t("table.exportCsv")}
            </Button>
          )
        }
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.profitability.dimensionLabel")}>
          <Select
            value={filter.draft.dimension}
            onChange={(e) =>
              filter.patch({ dimension: e.target.value as ProfitabilityFilter["dimension"] })
            }
            options={PROFITABILITY_DIMENSIONS.map((d) => ({
              value: d,
              label: profitabilityDimLabel(t, d),
            }))}
          />
        </FilterField>
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={!!data && rows.length === 0}
        onRetry={() => query.refetch()}
        emptyBody={t("accounting.profitability.empty")}
      >
        {data && (
          <PrintDocument title={t("accounting.profitability.title")} subtitle={period} meta={groupedBy}>
            <div className="surface overflow-x-auto p-4">
              <table className="w-full min-w-[42rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
                    {COLUMN_KEYS.map((c) => (
                      <th key={c.key} className={`px-3 py-2 ${c.numeric ? "text-left" : "text-right"}`}>
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          className="inline-flex items-center gap-1 font-extrabold transition hover:text-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                        >
                          {t(COLUMN_LABEL_KEY[c.key])}
                          {sortIcon(c.key)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id ?? `row-${i}`} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                      <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                      <td className="px-3 py-2 text-left"><Num value={r.revenue} /></td>
                      <td className="px-3 py-2 text-left"><Num value={r.expenses} /></td>
                      <td className="px-3 py-2 text-left"><Num value={r.profit} signed strong /></td>
                      <td className="px-3 py-2 text-left"><MarginCell row={r} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
                    <td className="px-3 py-2.5 text-right">{t("accounting.common.total")}</td>
                    <td className="px-3 py-2.5 text-left"><Num value={totals.revenue} strong /></td>
                    <td className="px-3 py-2.5 text-left"><Num value={totals.expenses} strong /></td>
                    <td className="px-3 py-2.5 text-left"><Num value={totals.profit} signed strong /></td>
                    <td className="px-3 py-2.5 text-left">
                      {totals.revenue > 0 ? (
                        <span dir="ltr" className="tabular-nums font-extrabold text-slate-900">
                          {fmt((totals.profit / totals.revenue) * 100)}%
                        </span>
                      ) : (
                        <span className="tabular-nums text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </PrintDocument>
        )}
      </ReportState>
    </div>
  );
}
