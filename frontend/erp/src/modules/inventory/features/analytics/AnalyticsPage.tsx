import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  BarChart,
  LineChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  AlertTriangle,
  Boxes,
  CircleDollarSign,
  Coins,
  PackageCheck,
  PackageMinus,
  PackageX,
  RefreshCw,
  TrendingDown,
  Truck,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { DatePicker, PageHeader } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button } from "@/shared/ui";
import { Spinner } from "@/shared/ui";
import { LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import {
  formatCurrency,
  formatNumber,
  formatQty,
  formatDateTime,
} from "@/shared/lib";
import { useT } from "@/i18n";
import { localizeReportWarning } from "@/modules/inventory/lib/adapters/reports.adapter";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useAnalytics, type AnalyticsFilters } from "@/modules/inventory/lib/hooks/useAnalytics";
import type {
  Analytics,
  TrendPoint,
  ValueByWarehouse,
  ValueByCategory,
  TopItem,
  WarehouseComparison,
} from "@/modules/inventory/lib/adapters/analytics.adapter";

// Read-only analytics dashboard wired to GET /api/inventory/analytics/summary.
// Honors the warehouse scope (?wh, owned by the Topbar selector) and its own
// URL-persisted filter bar (from/to/category/type/window). Every chart is paired
// with an accessible <table> of the same data (جداول بديلة للرسوم).

// Accessible palette — sufficient contrast on white, distinguishable for the
// common color-vision deficiencies.
const COLORS = {
  teal: "#0d9488",
  slate: "#334155",
  amber: "#d97706",
  rose: "#e11d48",
  axis: "#94a3b8",
  grid: "#e2e8f0",
} as const;

const WINDOWS = [30, 60, 90, 180] as const;
const DEFAULT_WINDOW = 90;

type WindowValue = (typeof WINDOWS)[number];

function parseWindow(raw: string | null): WindowValue {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as WindowValue) : DEFAULT_WINDOW;
}

function parseType(raw: string | null): "in" | "out" | "" {
  return raw === "in" || raw === "out" ? raw : "";
}

// recharts values come through as `number | string | (number|string)[]`
// (`ValueType`). Coerce to a scalar before formatting, with no `any` leak.
type RechartsValue = number | string | Array<number | string>;
function toScalar(v: RechartsValue): number {
  return Number(Array.isArray(v) ? v[0] : v);
}
// Tooltip `formatter` must accept the full ValueType; axis `tickFormatter` is
// typed `(value: any, index) => string` so the same scalar helpers fit both.
const fmtCurrencyTick = (v: RechartsValue): string => formatCurrency(toScalar(v));
const fmtNumberTick = (v: RechartsValue): string => formatNumber(toScalar(v));

export function AnalyticsPage() {
  const t = useT();
  const { scope } = useWarehouseScope();
  const [params, setParams] = useSearchParams();

  const filters = useMemo<AnalyticsFilters>(() => {
    const from = params.get("from") || undefined;
    const to = params.get("to") || undefined;
    const category = params.get("category") || undefined;
    const type = parseType(params.get("type"));
    const window = parseWindow(params.get("window"));
    return { from, to, category, type: type || undefined, window };
  }, [params]);

  const activeWindow = parseWindow(params.get("window"));
  const activeType = parseType(params.get("type"));
  const activeFrom = params.get("from") || "";
  const activeTo = params.get("to") || "";
  const activeCategory = params.get("category") || "";

  const { data, isLoading, isError, error, refetch, isFetching } = useAnalytics(scope, filters);

  function patchParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  }

  const allWarehouses = data ? data.scope.allWarehousesAccess && scope === ALL_WAREHOUSES : scope === ALL_WAREHOUSES;
  const subtitle = allWarehouses
    ? t("inventoryRest.analytics.subtitleAll")
    : t("inventoryRest.analytics.subtitleScoped");

  const filterBar = (
    <FilterBar
      from={activeFrom}
      to={activeTo}
      category={activeCategory}
      type={activeType}
      window={activeWindow}
      onChange={patchParams}
      onReset={() => setParams(new URLSearchParams(), { replace: true })}
    />
  );

  const header = (
    <PageHeader
      eyebrow={t("inventoryRest.analytics.eyebrow")}
      title={t("inventoryRest.analytics.title")}
      subtitle={subtitle}
      action={
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className="h-4 w-4" /> {t("inventoryRest.ui.refresh")}
        </Button>
      }
    />
  );

  if (isLoading) {
    return (
      <>
        {header}
        {filterBar}
        <LoadingState rows={6} />
      </>
    );
  }

  if (isError || !data) {
    return (
      <>
        {header}
        {filterBar}
        <ErrorState error={error} onRetry={() => refetch()} />
      </>
    );
  }

  const isEmpty =
    data.kpis.itemCount === 0 &&
    data.valueByWarehouse.length === 0 &&
    data.valueByCategory.length === 0 &&
    data.topItemsByValue.length === 0 &&
    data.movementTrend.length === 0 &&
    data.warehouseComparison.length === 0;

  if (isEmpty) {
    return (
      <>
        {header}
        {filterBar}
        <EmptyState
          title={t("inventoryRest.analytics.emptyTitle")}
          body={t("inventoryRest.analytics.emptyBody")}
        />
      </>
    );
  }

  const k = data.kpis;
  const cov = data.dataQualityIndicators.expiryCoverage;

  return (
    <>
      {header}
      {filterBar}

      {isFetching && (
        <div className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-400" aria-live="polite">
          <Spinner className="h-3.5 w-3.5" /> {t("inventoryRest.analytics.updating")}
        </div>
      )}

      <WarningsBanner data={data} />

      {/* Primary KPI row */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={t("inventoryRest.analytics.kpi.positiveValue")}
          value={formatCurrency(k.inventoryValueWac)}
          note={
            k.estimatedCostValue > 0
              ? t("inventoryRest.analytics.kpi.positiveValueWithEst", { value: formatCurrency(k.estimatedCostValue) })
              : t("inventoryRest.analytics.kpi.positiveValueNote")
          }
          icon={CircleDollarSign}
        />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.negativeImpact")}
          value={formatCurrency(k.negativeStockValueImpact)}
          note={
            k.negativeStockValueImpact < 0
              ? t("inventoryRest.analytics.kpi.negativeImpactNote")
              : t("inventoryRest.analytics.kpi.negativeImpactNone")
          }
          icon={Coins}
          tone="rose"
        />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.items")}
          value={formatNumber(k.itemCount)}
          note={t("inventoryRest.analytics.kpi.itemsNote", { qty: formatQty(k.totalQty) })}
          icon={Boxes}
          tone="blue"
        />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.activeWarehouses")}
          value={formatNumber(k.activeWarehouses)}
          note={t("inventoryRest.analytics.kpi.activeWarehousesNote")}
          icon={WarehouseIcon}
        />
      </section>

      {/* Stock-state KPI row */}
      <section className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={t("inventoryRest.analytics.kpi.available")} value={formatNumber(k.availableCount)} note={t("inventoryRest.analytics.kpi.availableNote")} icon={PackageCheck} tone="teal" />
        <MetricCard label={t("inventoryRest.analytics.kpi.low")} value={formatNumber(k.lowCount)} note={t("inventoryRest.analytics.kpi.lowNote")} icon={PackageMinus} tone="amber" />
        <MetricCard label={t("inventoryRest.analytics.kpi.out")} value={formatNumber(k.outCount)} note={t("inventoryRest.analytics.kpi.outNote")} icon={PackageX} tone="rose" />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.negative")}
          value={formatNumber(k.negativeCount)}
          note={k.negativeCount > 0 ? t("inventoryRest.analytics.kpi.negativeNote") : t("inventoryRest.analytics.kpi.negativeNone")}
          icon={TrendingDown}
          tone="rose"
        />
      </section>

      {/* Operational KPI row */}
      <section className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={t("inventoryRest.analytics.kpi.stagnant", { days: formatNumber(data.slowNoMovement.window || activeWindow) })}
          value={formatNumber(data.slowNoMovement.count)}
          note={t("inventoryRest.analytics.kpi.stagnantNote")}
          icon={TrendingDown}
          tone="amber"
        />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.inTransit")}
          value={formatNumber(data.transfers.inTransit)}
          note={t("inventoryRest.analytics.kpi.inTransitNote", { qty: formatQty(data.transfers.remainingQty) })}
          icon={Truck}
          tone="blue"
        />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.transfersPending")}
          value={formatNumber(data.transfers.pending)}
          note={t("inventoryRest.analytics.kpi.transfersPendingNote")}
          icon={Truck}
          tone="amber"
        />
        <MetricCard
          label={t("inventoryRest.analytics.kpi.expiryCoverage")}
          value={
            cov.lots > 0
              ? formatNumber(cov.covered)
              : t("inventoryRest.analytics.kpi.expiryUnavailable")
          }
          note={
            cov.lots > 0
              ? t("inventoryRest.analytics.kpi.expiryCoverageNote", { covered: formatNumber(cov.covered), lots: formatNumber(cov.lots) }) + (cov.reliable ? "" : t("inventoryRest.analytics.kpi.expiryPartial"))
              : t("inventoryRest.analytics.kpi.expiryNoData")
          }
          icon={PackageCheck}
          tone="violet"
        />
      </section>

      {/* Charts grid — each chart paired with an accessible alternative table */}
      <section className="mt-6 grid gap-4 xl:grid-cols-2">
        <MovementTrendCard rows={data.movementTrend} />
        <ValueByWarehouseCard rows={data.valueByWarehouse} />
        <ValueByCategoryCard rows={data.valueByCategory} />
        <TopItemsCard rows={data.topItemsByValue} />
      </section>

      {/* Warehouse comparison table */}
      <WarehouseComparisonSection rows={data.warehouseComparison} />

      {/* Footer */}
      <footer className="mt-6 border-t border-slate-100 pt-4 text-xs font-bold text-slate-400">
        {t("inventoryRest.analytics.generated", { date: formatDateTime(data.generatedAt) })}
        {allWarehouses
          ? t("inventoryRest.analytics.scopeAll")
          : `${t("inventoryRest.analytics.scopeScoped")}${data.scope.warehouseId ? ` (${data.scope.warehouseId})` : ""}`}
      </footer>
    </>
  );
}

/* ----------------------------------------------------------------------------
 * Filter bar (hidden on print)
 * ------------------------------------------------------------------------- */

interface FilterBarProps {
  from: string;
  to: string;
  category: string;
  type: "in" | "out" | "";
  window: WindowValue;
  onChange: (patch: Record<string, string | null>) => void;
  onReset: () => void;
}

function FilterBar({ from, to, category, type, window, onChange, onReset }: FilterBarProps) {
  const t = useT();
  const hasAny = Boolean(from || to || category || type) || window !== DEFAULT_WINDOW;
  return (
    <div className="no-print surface mb-4 flex flex-wrap items-end gap-3 p-4">
      <label className="flex min-w-[8.5rem] flex-1 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("inventoryRest.analytics.filter.from")}</span>
        <DatePicker
          value={from}
          max={to || undefined}
          onChange={(v) => onChange({ from: v || null })}
        />
      </label>

      <label className="flex min-w-[8.5rem] flex-1 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("inventoryRest.analytics.filter.to")}</span>
        <DatePicker
          value={to}
          min={from || undefined}
          onChange={(v) => onChange({ to: v || null })}
        />
      </label>

      <label className="flex min-w-[10rem] flex-1 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("inventoryRest.analytics.filter.category")}</span>
        <input
          type="text"
          className="field"
          placeholder={t("inventoryRest.analytics.filter.categoryPlaceholder")}
          value={category}
          onChange={(e) => onChange({ category: e.target.value || null })}
        />
      </label>

      <label className="flex min-w-[8.5rem] flex-1 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("inventoryRest.analytics.filter.type")}</span>
        <select className="field" value={type} onChange={(e) => onChange({ type: e.target.value || null })}>
          <option value="">{t("inventoryRest.analytics.filter.typeAll")}</option>
          <option value="in">{t("inventoryRest.analytics.filter.typeIn")}</option>
          <option value="out">{t("inventoryRest.analytics.filter.typeOut")}</option>
        </select>
      </label>

      <label className="flex min-w-[8.5rem] flex-1 flex-col gap-1.5">
        <span className="text-xs font-extrabold text-slate-500">{t("inventoryRest.analytics.filter.window")}</span>
        <select
          className="field"
          value={String(window)}
          onChange={(e) => onChange({ window: e.target.value === String(DEFAULT_WINDOW) ? null : e.target.value })}
        >
          {WINDOWS.map((w) => (
            <option key={w} value={String(w)}>
              {t("inventoryRest.analytics.filter.windowDays", { days: formatNumber(w) })}
            </option>
          ))}
        </select>
      </label>

      <Button variant="ghost" onClick={onReset} disabled={!hasAny} className="shrink-0">
        {t("inventoryRest.analytics.filter.reset")}
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Data-quality warnings banner
 * ------------------------------------------------------------------------- */

function WarningsBanner({ data }: { data: Analytics }) {
  const t = useT();
  if (data.warnings.length === 0) return null;
  return (
    <div className="surface mb-4 border-amber-200 bg-amber-50/70 p-4" role="alert">
      <div className="flex items-center gap-2 text-sm font-extrabold text-amber-800">
        <AlertTriangle className="h-5 w-5 shrink-0" />
        {t("inventoryRest.analytics.warningsTitle")}
      </div>
      <ul className="mt-2 list-inside list-disc space-y-1 ps-1 text-xs font-bold text-amber-700">
        {data.warnings.map((w, i) => (
          <li key={`${w.code}-${i}`}>{localizeReportWarning(w, t)}</li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Chart card shell
 * ------------------------------------------------------------------------- */

function ChartCard({
  title,
  subtitle,
  isEmpty,
  children,
}: {
  title: string;
  subtitle?: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <article className="surface overflow-hidden p-5">
      <header className="mb-4">
        <h2 className="text-base font-extrabold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs font-medium text-slate-500">{subtitle}</p>}
      </header>
      {isEmpty ? (
        <div className="grid h-[260px] place-items-center text-sm font-bold text-slate-400">
          {t("inventoryRest.analytics.chartEmpty")}
        </div>
      ) : (
        children
      )}
    </article>
  );
}

const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid #e2e8f0",
  fontSize: 12,
  fontWeight: 700,
  direction: "rtl" as const,
};

/* ----------------------------------------------------------------------------
 * 1) Movement trend
 * ------------------------------------------------------------------------- */

function MovementTrendCard({ rows }: { rows: TrendPoint[] }) {
  const t = useT();
  return (
    <ChartCard title={t("inventoryRest.analytics.movementTrend.title")} subtitle={t("inventoryRest.analytics.movementTrend.subtitle")} isEmpty={rows.length === 0}>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
          <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: COLORS.axis }} reversed />
          <YAxis tick={{ fontSize: 11, fill: COLORS.axis }} tickFormatter={fmtNumberTick} width={56} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={fmtNumberTick} />
          <Legend wrapperStyle={{ fontSize: 12, fontWeight: 700 }} />
          <Line type="monotone" dataKey="in" name={t("inventoryRest.analytics.movementTrend.in")} stroke={COLORS.teal} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="out" name={t("inventoryRest.analytics.movementTrend.out")} stroke={COLORS.rose} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>

      {rows.length > 0 && (
        <DataTable
          caption={t("inventoryRest.analytics.movementTrend.tableCaption")}
          head={[t("inventoryRest.analytics.movementTrend.colPeriod"), t("inventoryRest.analytics.movementTrend.in"), t("inventoryRest.analytics.movementTrend.out")]}
          rows={rows.map((r) => [r.bucket, formatNumber(r.in), formatNumber(r.out)])}
        />
      )}
    </ChartCard>
  );
}

/* ----------------------------------------------------------------------------
 * 2) Value by warehouse
 * ------------------------------------------------------------------------- */

function ValueByWarehouseCard({ rows }: { rows: ValueByWarehouse[] }) {
  const t = useT();
  return (
    <ChartCard title={t("inventoryRest.analytics.valueByWarehouse.title")} subtitle={t("inventoryRest.analytics.valueByWarehouse.subtitle")} isEmpty={rows.length === 0}>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.axis }} interval={0} />
          <YAxis tick={{ fontSize: 11, fill: COLORS.axis }} tickFormatter={fmtNumberTick} width={64} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={fmtCurrencyTick} />
          <Bar dataKey="value" name={t("inventoryRest.analytics.valueByWarehouse.value")} fill={COLORS.teal} radius={[6, 6, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>

      {rows.length > 0 && (
        <DataTable
          caption={t("inventoryRest.analytics.valueByWarehouse.tableCaption")}
          head={[t("inventoryRest.analytics.valueByWarehouse.colWarehouse"), t("inventoryRest.analytics.valueByWarehouse.colCode"), t("inventoryRest.analytics.valueByWarehouse.colValue"), t("inventoryRest.analytics.valueByWarehouse.colQty")]}
          rows={rows.map((r) => [r.name, r.code, formatCurrency(r.value), formatNumber(r.qty)])}
        />
      )}
    </ChartCard>
  );
}

/* ----------------------------------------------------------------------------
 * 3) Value by category
 * ------------------------------------------------------------------------- */

function ValueByCategoryCard({ rows }: { rows: ValueByCategory[] }) {
  const t = useT();
  return (
    <ChartCard title={t("inventoryRest.analytics.valueByCategory.title")} subtitle={t("inventoryRest.analytics.valueByCategory.subtitle")} isEmpty={rows.length === 0}>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
          <XAxis dataKey="category" tick={{ fontSize: 11, fill: COLORS.axis }} interval={0} />
          <YAxis tick={{ fontSize: 11, fill: COLORS.axis }} tickFormatter={fmtNumberTick} width={64} orientation="right" />
          <Tooltip contentStyle={tooltipStyle} formatter={fmtCurrencyTick} />
          <Bar dataKey="value" name={t("inventoryRest.analytics.valueByCategory.value")} fill={COLORS.amber} radius={[6, 6, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>

      {rows.length > 0 && (
        <DataTable
          caption={t("inventoryRest.analytics.valueByCategory.tableCaption")}
          head={[t("inventoryRest.analytics.valueByCategory.colCategory"), t("inventoryRest.analytics.valueByCategory.colValue"), t("inventoryRest.analytics.valueByCategory.colQty"), t("inventoryRest.analytics.valueByCategory.colItems")]}
          rows={rows.map((r) => [r.category || t("inventoryRest.analytics.uncategorized"), formatCurrency(r.value), formatNumber(r.qty), formatNumber(r.items)])}
        />
      )}
    </ChartCard>
  );
}

/* ----------------------------------------------------------------------------
 * 4) Top items by value (horizontal bars)
 * ------------------------------------------------------------------------- */

function TopItemsCard({ rows }: { rows: TopItem[] }) {
  const t = useT();
  return (
    <ChartCard title={t("inventoryRest.analytics.topItems.title")} subtitle={t("inventoryRest.analytics.topItems.subtitle")} isEmpty={rows.length === 0}>
      <ResponsiveContainer width="100%" height={Math.max(280, rows.length * 34 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: COLORS.axis }} tickFormatter={fmtNumberTick} />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 11, fill: COLORS.slate }}
            width={120}
            orientation="right"
            interval={0}
          />
          <Tooltip contentStyle={tooltipStyle} formatter={fmtCurrencyTick} />
          <Bar dataKey="value" name={t("inventoryRest.analytics.topItems.value")} fill={COLORS.slate} radius={[0, 6, 6, 0]} maxBarSize={26} />
        </BarChart>
      </ResponsiveContainer>

      {rows.length > 0 && (
        <DataTable
          caption={t("inventoryRest.analytics.topItems.tableCaption")}
          head={[t("inventoryRest.analytics.topItems.colItem"), t("inventoryRest.analytics.topItems.colCategory"), t("inventoryRest.analytics.topItems.colQty"), t("inventoryRest.analytics.topItems.colValue")]}
          rows={rows.map((r) => [r.name, r.category || t("inventoryRest.analytics.uncategorized"), formatNumber(r.qty), formatCurrency(r.value)])}
        />
      )}
    </ChartCard>
  );
}

/* ----------------------------------------------------------------------------
 * Warehouse comparison table
 * ------------------------------------------------------------------------- */

function WarehouseComparisonSection({ rows }: { rows: WarehouseComparison[] }) {
  const t = useT();
  return (
    <section className="surface mt-6 overflow-hidden">
      <header className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-base font-extrabold text-slate-900">{t("inventoryRest.analytics.comparison.title")}</h2>
        <p className="mt-0.5 text-xs font-medium text-slate-500">{t("inventoryRest.analytics.comparison.subtitle")}</p>
      </header>
      {rows.length === 0 ? (
        <div className="p-10 text-center text-sm font-bold text-slate-400">{t("inventoryRest.analytics.comparison.empty")}</div>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[820px] text-start">
            <caption className="sr-only">{t("inventoryRest.analytics.comparison.caption")}</caption>
            <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
              <tr>
                <th scope="col" className="px-5 py-3">{t("inventoryRest.analytics.comparison.colWarehouse")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colCode")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colType")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colItems")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colQty")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colValue")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colLow")}</th>
                <th scope="col" className="px-4 py-3">{t("inventoryRest.analytics.comparison.colOut")}</th>
                <th scope="col" className="px-5 py-3">{t("inventoryRest.analytics.comparison.colNegative")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="table-row">
                  <th scope="row" className="px-5 py-4 text-start font-extrabold text-slate-800">{w.name}</th>
                  <td className="px-4 py-4 text-xs font-bold text-slate-400">{w.code}</td>
                  <td className="px-4 py-4 text-xs font-bold text-slate-500">{w.type || "—"}</td>
                  <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.itemCount)}</td>
                  <td className="px-4 py-4 text-sm font-bold text-slate-600 tabular-nums">{formatNumber(w.totalQty)}</td>
                  <td className="px-4 py-4 text-sm font-extrabold text-slate-800 tabular-nums">{formatCurrency(w.totalValue)}</td>
                  <td className={`px-4 py-4 text-sm font-extrabold tabular-nums ${w.lowCount > 0 ? "text-amber-600" : "text-slate-400"}`}>{formatNumber(w.lowCount)}</td>
                  <td className={`px-4 py-4 text-sm font-extrabold tabular-nums ${w.outCount > 0 ? "text-rose-600" : "text-slate-400"}`}>{formatNumber(w.outCount)}</td>
                  <td className={`px-5 py-4 text-sm font-extrabold tabular-nums ${w.negativeCount > 0 ? "text-rose-600" : "text-slate-400"}`}>{formatNumber(w.negativeCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
 * Accessible alternative table (shared)
 * ------------------------------------------------------------------------- */

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  const t = useT();
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer select-none text-xs font-extrabold text-teal-700 hover:text-teal-800">
        {t("inventoryRest.analytics.showTable")}
      </summary>
      <div className="mt-3 overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[360px] text-start">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
            <tr>
              {head.map((h) => (
                <th key={h} scope="col" className="px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                {cells.map((cell, j) => (
                  <td key={j} className="px-3 py-2 font-bold text-slate-600 tabular-nums">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
