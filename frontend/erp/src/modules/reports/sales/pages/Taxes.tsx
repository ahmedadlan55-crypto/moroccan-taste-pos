// Sales Analytics Hub — "taxes" page (VAT from the stored columns).
//
// KPI row: vat_amount + the order-header extras (fees/rounding/tips — tips is
// frequently not tracked historically and renders "—" with an explain note),
// and the by-rate table. Reports are decision tables — the VAT-by-category
// trend chart lives on the dashboard, not here.
import { useMemo } from "react";
import { Coins, HandCoins, Landmark, ReceiptText, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, setPageExportRequest, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const SEGMENT = "taxes";

// The TopBar ExportMenu asks this page's registry entry for its export shape.
setPageExportRequest(SEGMENT, () => ({
  metrics: ["vat_amount", "net_ex_vat"],
  dimensions: ["vat_rate"],
  sort: [{ by: "vat_amount", dir: "desc" }],
}));

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

const KPIS: Array<{ id: string; eq: string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "vat_amount", eq: "sum", icon: Landmark, tone: "teal" },
  { id: "fees_total", eq: "sum", icon: ReceiptText, tone: "blue" },
  { id: "rounding_total", eq: "sum", icon: Coins, tone: "violet" },
  { id: "tips_total", eq: "sum", icon: HandCoins, tone: "amber" },
];

interface RateRow {
  key: string;
  label: string;
  vat_amount: number | null;
  net_ex_vat: number | null;
}

export default function Taxes() {
  const t = useT();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const kpiBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["vat_amount", "fees_total", "rounding_total", "tips_total"], dimensions: [], ...base }),
    [base],
  );
  const rateBody = useMemo<AnalyticsQueryBody>(
    () => ({
      metrics: ["vat_amount", "net_ex_vat"],
      dimensions: ["vat_rate"],
      sort: [{ by: "vat_amount", dir: "desc" }],
      ...base,
    }),
    [base],
  );

  const kpis = useAnalyticsQuery("taxes-kpis", kpiBody);
  const byRate = useAnalyticsQuery("taxes-rate", rateBody);

  if (byRate.isPending) return <LoadingState />;
  if (byRate.isError) return <ErrorState error={byRate.error} onRetry={() => byRate.refetch()} />;

  const rateRows: RateRow[] = (byRate.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    vat_amount: displayMetric(r, "vat_amount"),
    net_ex_vat: displayMetric(r, "net_ex_vat"),
  }));
  if (rateRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const incomplete = byRate.data?.meta?.completeness?.complete === false;

  const tipsMasked = kpiValue(kpis.data, "tips_total") == null;

  const rateColumns: ColumnDef<RateRow>[] = [
    { id: "rate", header: t("salesReports.dims.vat_rate"), accessor: (r) => r.label, pinStart: true, width: 140 },
    {
      id: "vat_amount",
      header: t("salesReports.metrics.vat_amount"),
      accessor: (r) => r.vat_amount,
      cell: (r) => (r.vat_amount == null ? "—" : formatCurrency(r.vat_amount)),
      numeric: true,
      sortable: true,
    },
    {
      id: "net_ex_vat",
      header: t("salesReports.metrics.net_ex_vat"),
      accessor: (r) => r.net_ex_vat,
      cell: (r) => (r.net_ex_vat == null ? "—" : formatCurrency(r.net_ex_vat)),
      numeric: true,
      sortable: true,
    },
  ];

  return (
    <section aria-labelledby="sales-hub-page-taxes" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-taxes" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.taxes.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.taxes.subtitle")}</p>
      </div>

      {incomplete && (
        <div data-testid="completeness-notice">
          <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((k) => {
          const label = t(`salesReports.metrics.${k.id}`);
          const v = kpiValue(kpis.data, k.id);
          const isMaskedTips = k.id === "tips_total" && tipsMasked;
          return (
            <div key={k.id} data-testid={`kpi-${k.id}`}>
              <MetricCard
                label={label}
                value={v == null ? "—" : formatCurrency(v)}
                icon={k.icon}
                tone={k.tone}
                explain={
                  <ExplainNumber
                    title={label}
                    formula={t(`salesReports.explain.${k.eq}`)}
                    // Tips: "—" is a data-availability statement, not a zero.
                    footnote={isMaskedTips ? t("salesReports.states.notAvailableHistorically") : undefined}
                    triggerLabel={label}
                  />
                }
              />
            </div>
          );
        })}
      </div>

      <DataTable<RateRow>
        columns={rateColumns}
        rows={rateRows}
        getRowId={(r) => r.key || r.label}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
      />
    </section>
  );
}
