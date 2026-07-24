// Sales Analytics Hub — "shifts" page (till performance).
//
// KPI totals for expected/counted/variance, an over/short bar per business day
// (positive → pos token, negative → neg token), and a per-shift DataTable
// (dimension "shift" — see lib/analytics/registry/dimensions.js) with variance
// tones: short (negative) → negative, over (positive) → warning. Row click →
// the operational /pos-admin/shifts screen (its filters live in local state,
// not the URL, so the drill carries no params — verified in ShiftsPage.tsx).
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Banknote, Calculator, Scale, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard, type MetricTone } from "@/shared/ui";
import { ChartCard, useChartPalette, useChartsRtl } from "@/shared/charts";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { formatCurrency } from "@/shared/lib";
import { useT } from "@/i18n";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { analyticsFilterCodec } from "../lib/filters";
import { buildFiltersBody, displayMetric, type AnalyticsQueryBody, type AnalyticsResult } from "../lib/api";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

const METRICS = ["till_expected_cash", "till_counted", "till_variance"] as const;

/** |variance| below this is treated as balanced (mirrors pos-admin's 0.01). */
const BALANCED_EPS = 0.01;

function kpiValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result) return null;
  const v = result.totals?.[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const row = result.rows[0];
  return row ? displayMetric(row, id) : null;
}

const KPIS: Array<{ id: string; eq: string; icon: LucideIcon; tone: MetricTone }> = [
  { id: "till_expected_cash", eq: "expectedCash", icon: Calculator, tone: "teal" },
  { id: "till_counted", eq: "sum", icon: Banknote, tone: "blue" },
  { id: "till_variance", eq: "tillVariance", icon: Scale, tone: "amber" },
];

interface ShiftRow {
  key: string;
  label: string;
  expected: number | null;
  counted: number | null;
  variance: number | null;
}

export default function Shifts() {
  const t = useT();
  const navigate = useNavigate();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const palette = useChartPalette();
  const rtl = useChartsRtl();
  const base = useMemo(() => buildFiltersBody(filters), [filters]);

  const dayDim = filters.businessDay ? "business_day" : "calendar_day";

  const kpiBody = useMemo<AnalyticsQueryBody>(() => ({ metrics: [...METRICS], dimensions: [], ...base }), [base]);
  const shiftBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: [...METRICS], dimensions: ["shift"], sort: [{ by: "till_variance", dir: "asc" }], ...base }),
    [base],
  );
  const dayBody = useMemo<AnalyticsQueryBody>(
    () => ({ metrics: ["till_variance"], dimensions: [dayDim], sort: [{ by: dayDim, dir: "asc" }], ...base }),
    [base, dayDim],
  );

  const kpis = useAnalyticsQuery("shifts-kpis", kpiBody);
  const byShift = useAnalyticsQuery("shifts-till", shiftBody);
  const byDay = useAnalyticsQuery("shifts-day", dayBody);

  if (byShift.isPending) return <LoadingState />;
  if (byShift.isError) return <ErrorState error={byShift.error} onRetry={() => byShift.refetch()} />;

  const shiftRows: ShiftRow[] = (byShift.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    expected: displayMetric(r, "till_expected_cash"),
    counted: displayMetric(r, "till_counted"),
    variance: displayMetric(r, "till_variance"),
  }));
  if (shiftRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const incomplete = byShift.data?.meta?.completeness?.complete === false;

  const dayRows = (byDay.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    variance: displayMetric(r, "till_variance"),
  }));

  const varianceTone = (r: ShiftRow): "negative" | "warning" | undefined => {
    if (r.variance == null || Math.abs(r.variance) < BALANCED_EPS) return undefined;
    return r.variance < 0 ? "negative" : "warning";
  };

  const columns: ColumnDef<ShiftRow>[] = [
    { id: "shift", header: t("salesReports.dims.shift"), accessor: (r) => r.label, pinStart: true, width: 150 },
    {
      id: "expected",
      header: t("salesReports.metrics.till_expected_cash"),
      accessor: (r) => r.expected,
      cell: (r) => (r.expected == null ? "—" : formatCurrency(r.expected)),
      numeric: true,
      sortable: true,
    },
    {
      id: "counted",
      header: t("salesReports.metrics.till_counted"),
      accessor: (r) => r.counted,
      cell: (r) => (r.counted == null ? "—" : formatCurrency(r.counted)),
      numeric: true,
      sortable: true,
    },
    {
      id: "variance",
      header: t("salesReports.metrics.till_variance"),
      accessor: (r) => r.variance,
      cell: (r) => (r.variance == null ? "—" : formatCurrency(r.variance)),
      numeric: true,
      sortable: true,
      cellTone: varianceTone,
    },
  ];

  return (
    <section aria-labelledby="sales-hub-page-shifts" className="space-y-4">
      <div>
        <h2 id="sales-hub-page-shifts" className="text-lg font-extrabold text-slate-900">
          {t("salesReports.pages.shifts.title")}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">{t("salesReports.pages.shifts.subtitle")}</p>
      </div>

      {incomplete && (
        <div data-testid="completeness-notice">
          <Badge tone="warning">{t("salesReports.states.notAvailableHistorically")}</Badge>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {KPIS.map((k) => {
          const label = t(`salesReports.metrics.${k.id}`);
          const v = kpiValue(kpis.data, k.id);
          return (
            <div key={k.id} data-testid={`kpi-${k.id}`}>
              <MetricCard
                label={label}
                value={v == null ? "—" : formatCurrency(v)}
                icon={k.icon}
                tone={k.tone}
                explain={
                  <ExplainNumber title={label} formula={t(`salesReports.explain.${k.eq}`)} triggerLabel={label} />
                }
              />
            </div>
          );
        })}
      </div>

      {dayRows.length > 0 && (
        <ChartCard
          title={`${t("salesReports.metrics.till_variance")} — ${t(`salesReports.dims.${dayDim}`)}`}
          tableLabel={t(`salesReports.dims.${dayDim}`)}
          tableColumns={[
            { key: "label", label: t(`salesReports.dims.${dayDim}`) },
            { key: "variance", label: t("salesReports.metrics.till_variance") },
          ]}
          tableRows={dayRows.map((r) => ({
            label: r.label,
            variance: r.variance == null ? "—" : formatCurrency(r.variance),
          }))}
        >
          <BarChart data={dayRows}>
            <CartesianGrid stroke={palette.grid} vertical={false} />
            <XAxis dataKey="label" reversed={rtl.xAxisReversed} stroke={palette.axis} tick={{ fontSize: 11 }} />
            <YAxis orientation={rtl.dir === "rtl" ? "right" : "left"} stroke={palette.axis} tickFormatter={rtl.tickFormatterNumber} tick={{ fontSize: 11 }} />
            <RechartsTooltip contentStyle={rtl.tooltipStyle} formatter={(v) => rtl.tickFormatterCurrency(v)} />
            <Bar dataKey="variance" name={t("salesReports.metrics.till_variance")} radius={[4, 4, 0, 0]}>
              {dayRows.map((r) => (
                <Cell key={r.key || r.label} fill={(r.variance ?? 0) < 0 ? palette.neg : palette.pos} />
              ))}
            </Bar>
          </BarChart>
        </ChartCard>
      )}

      <DataTable<ShiftRow>
        columns={columns}
        rows={shiftRows}
        getRowId={(r) => r.key || r.label}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("salesReports.states.empty")}
        mobileTitle={(r) => r.label}
        // Operational drill: the pos-admin shifts screen (no URL param contract).
        onRowClick={() => navigate("/pos-admin/shifts")}
      />
    </section>
  );
}
