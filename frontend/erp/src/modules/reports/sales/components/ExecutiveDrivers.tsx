import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { cn, formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import type { AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  reportQuerySpec,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
} from "../lib/api";
import { rankDrivers, type DriverRow } from "../lib/driverRanking";
import { useAnalyticsQuery } from "../lib/useAnalyticsQuery";

type DriverDimension = "branch" | "item" | "hour" | "cashier" | "payment";

interface DriverOption {
  id: DriverDimension;
  queryId: string;
  primaryMetric: string;
  center: string;
  view: string;
  filterKey: string;
}

const OPTIONS: readonly DriverOption[] = [
  { id: "branch", queryId: "driverBranch", primaryMetric: "net_ex_vat", center: "operations", view: "branches", filterKey: "branchId" },
  { id: "item", queryId: "driverItem", primaryMetric: "net_ex_vat", center: "items", view: "items", filterKey: "menuItemId" },
  { id: "hour", queryId: "driverHour", primaryMetric: "net_ex_vat", center: "operations", view: "hours", filterKey: "hour" },
  { id: "cashier", queryId: "driverCashier", primaryMetric: "net_ex_vat", center: "operations", view: "cashiers", filterKey: "cashierId" },
  { id: "payment", queryId: "driverPayment", primaryMetric: "net_collections", center: "payments", view: "payments", filterKey: "paymentMethod" },
] as const;

function compareSpec(filters: AnalyticsFilters): AnalyticsCompareSpec | undefined {
  if (filters.compare === "none") return undefined;
  return {
    mode: filters.compare,
    ...computeCompareRange(filters.compare, { from: filters.from, to: filters.to }),
  };
}

function driverHref(option: DriverOption, row: DriverRow, search: string): string {
  const params = new URLSearchParams(search);
  params.set("view", option.view);
  params.set(option.filterKey, row.key);
  return `/reports/sales/${option.center}?${params.toString()}`;
}

function DriverCard({
  row,
  kind,
  title,
  option,
  search,
  openLabel,
}: {
  row: DriverRow;
  kind: "leader" | "gain" | "decline";
  title: string;
  option: DriverOption;
  search: string;
  openLabel: string;
}) {
  const Icon: LucideIcon = kind === "leader" ? Trophy : kind === "gain" ? ArrowUpRight : ArrowDownRight;
  const mainValue = kind === "leader" ? row.current : row.deltaAbs;
  return (
    <Link
      to={driverHref(option, row, search)}
      data-driver-rank={kind}
      className="group min-w-0 rounded-xl border border-slate-200 bg-white p-3.5 transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-soft focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
            kind === "leader" && "bg-teal-50 text-teal-700",
            kind === "gain" && "bg-emerald-50 text-emerald-700",
            kind === "decline" && "bg-rose-50 text-rose-700",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        {kind !== "leader" && row.deltaPct != null && (
          <span
            dir="ltr"
            className={cn(
              "rounded-full px-2 py-1 text-[11px] font-black tabular-nums",
              kind === "gain" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
            )}
          >
            {row.deltaPct > 0 ? "+" : ""}{formatNumber(row.deltaPct)}%
          </span>
        )}
      </div>
      <p className="mt-3 text-[11px] font-extrabold uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-1 truncate text-sm font-black text-slate-950">{row.label || row.key}</p>
      <p dir="ltr" className="mt-2 text-end text-lg font-black tabular-nums text-slate-950">
        {formatCurrency(mainValue ?? 0)}
      </p>
      {kind !== "leader" && (
        <p dir="ltr" className="mt-1 text-end text-[11px] font-bold tabular-nums text-slate-500">
          {row.previous == null ? "—" : formatCurrency(row.previous)} → {row.current == null ? "—" : formatCurrency(row.current)}
        </p>
      )}
      <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-extrabold text-teal-700">
        {openLabel}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Link>
  );
}

export function ExecutiveDrivers({
  filters,
  search,
  canViewCashiers,
}: {
  filters: AnalyticsFilters;
  search: string;
  canViewCashiers: boolean;
}) {
  const t = useT();
  const available = useMemo(
    () => OPTIONS.filter((option) => option.id !== "cashier" || canViewCashiers),
    [canViewCashiers],
  );
  const [dimension, setDimension] = useState<DriverDimension>("branch");
  const option = available.find((entry) => entry.id === dimension) ?? available[0];
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...buildFiltersBody(filters),
    taxMode: "excl",
    ...reportQuerySpec("executive", option.queryId, filters),
    ...(compare ? { compare } : {}),
    sort: [{ by: option.primaryMetric, dir: "desc" }],
  };
  const query = useAnalyticsQuery(`executive-driver-${option.id}`, body);
  const rows = useMemo<DriverRow[]>(
    () =>
      (query.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        current: displayMetric(row, option.primaryMetric),
        previous: row.compare?.[option.primaryMetric] ?? null,
        deltaAbs: row.deltaAbs?.[option.primaryMetric] ?? null,
        deltaPct: row.delta?.[option.primaryMetric] ?? null,
      })),
    [query.data, option.primaryMetric],
  );
  const ranking = useMemo(
    () => rankDrivers(rows, query.data?.page?.rowCountCapped === true),
    [rows, query.data?.page?.rowCountCapped],
  );
  const cards = [
    ranking.topContributor && { kind: "leader" as const, row: ranking.topContributor },
    ranking.strongestGain && { kind: "gain" as const, row: ranking.strongestGain },
    ranking.biggestDecline && { kind: "decline" as const, row: ranking.biggestDecline },
  ].filter((entry): entry is { kind: "leader" | "gain" | "decline"; row: DriverRow } => entry != null);

  return (
    <section className="no-print surface overflow-hidden" data-testid="performance-drivers">
      <header className="border-b border-slate-100 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-teal-700">
              {t("salesReports.command.drivers.step")}
            </p>
            <h3 className="mt-0.5 text-base font-black text-slate-950">{t("salesReports.command.drivers.title")}</h3>
            <p className="mt-0.5 max-w-3xl text-xs font-medium leading-5 text-slate-500">
              {t("salesReports.command.drivers.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("salesReports.command.drivers.dimensionAria")}>
            {available.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === option.id}
                onClick={() => setDimension(entry.id)}
                className={cn(
                  "min-h-10 rounded-xl border px-3 text-xs font-extrabold transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                  entry.id === option.id
                    ? "border-teal-300 bg-teal-50 text-teal-900"
                    : "border-slate-200 bg-white text-slate-600 hover:border-teal-200 hover:bg-slate-50",
                )}
              >
                {t(`salesReports.command.drivers.dimensions.${entry.id}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {ranking.scopeLimited && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-bold leading-5 text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t("salesReports.command.drivers.scopeLimited")}
        </div>
      )}

      {query.isLoading ? (
        <div className="grid gap-3 p-4 sm:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((key) => <div key={key} className="h-36 animate-pulse rounded-xl bg-slate-100" />)}
        </div>
      ) : query.error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-5">
          <p className="text-sm font-bold text-rose-700">{t("salesReports.command.drivers.failed")}</p>
          <button type="button" onClick={() => void query.refetch()} className="min-h-10 rounded-xl border border-slate-200 px-3 text-xs font-extrabold text-slate-700">
            {t("salesReports.topbar.lookupRetry")}
          </button>
        </div>
      ) : cards.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm font-bold text-slate-500">
          {filters.compare === "none"
            ? t("salesReports.command.drivers.compareNeeded")
            : t("salesReports.command.drivers.empty")}
        </div>
      ) : (
        <div className="grid gap-3 p-4 md:grid-cols-3">
          {cards.map(({ kind, row }) => (
            <DriverCard
              key={kind}
              row={row}
              kind={kind}
              title={t(`salesReports.command.drivers.cards.${kind}`)}
              option={option}
              search={search}
              openLabel={t("salesReports.command.openAnalysis")}
            />
          ))}
        </div>
      )}
    </section>
  );
}
