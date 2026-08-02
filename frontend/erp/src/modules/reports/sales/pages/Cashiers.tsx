// Sales Analytics Hub — "cashiers" page (hub-gated: analytics.employees.view).
//
// One per-cashier query drives everything: the KPI row (orders / net / avg
// ticket from the query totals) and a per-cashier table whose discount/void
// rate cells carry the warning cellTone above the CLIENT-SIDE P75 of the
// column. Wave 4: a cashier row drills to the orders segment with the cashier
// pinned via the shared `cashierId` param.
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Coins, ShoppingBag, Ticket } from "lucide-react";
import { Badge, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  reportQuerySpec,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { hubHref } from "../lib/reportRegistry";

const SEGMENT = "cashiers";
// Metrics and the cashier grouping come from lib/reportRegistry — the same
// declaration the ExportMenu reads for this report's file.
//
// E2E-wave fix, recorded there: return_rate_by_cashier is dropped — its
// returns_count input lives on the RETURN fact, which does not carry the
// cashier dimension, so the planner refuses the grouping
// (ANALYTICS_UNSUPPORTED_COMBINATION 422) and this page errored on every load.
// Discount/void rates are order-fact inputs and group by cashier fine.

/* ── tiny local helpers (page-local copies by design) ── */

function compareSpec(filters: AnalyticsFilters): AnalyticsCompareSpec | undefined {
  if (filters.compare === "none") return undefined;
  return { mode: filters.compare, ...computeCompareRange(filters.compare, { from: filters.from, to: filters.to }) };
}

function metricExplain(t: TFunction, registry: AnalyticsRegistry | undefined, code: string) {
  const equationKey = registry?.metrics?.find?.((m) => m.id === code)?.equationKey;
  return (
    <ExplainNumber
      title={t(`salesReports.metrics.${code}`)}
      formula={equationKey ? t(`salesReports.explain.${equationKey}`) : undefined}
      triggerLabel={`${t("salesReports.explain.trigger")} — ${t(`salesReports.metrics.${code}`)}`}
    />
  );
}

function CompletenessNotice({ meta }: { meta?: AnalyticsResult["meta"] }) {
  const t = useT();
  if (!meta?.completeness || meta.completeness.complete) return null;
  return (
    <div
      data-testid="completeness-notice"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
    >
      <span>{t("salesReports.states.notAvailableHistorically")}</span>
      {(meta.completeness.missingDays?.length ?? 0) > 0 && (
        <Badge tone="warning">{formatNumber(meta.completeness.missingDays!.length)}</Badge>
      )}
    </div>
  );
}

function totalValue(result: AnalyticsResult | undefined, id: string): number | null {
  if (!result || result.meta.maskedMetrics.includes(id)) return null;
  const v = result.totals?.[id];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const fmtPercent = (v: number) => `${formatNumber(v)}%`;

/** The canonical URL of another hub report — lib/reportRegistry owns the
 *  centre a report lives in, so a drill never hand-builds a retired path. */
function segmentHref(search: string, segment: string, extra: Record<string, string>): string {
  return hubHref(segment, search, extra);
}

/** Client-side P75 (linear index method) over the non-null values. */
function p75(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (nums.length < 2) return null;
  return nums[Math.floor(0.75 * (nums.length - 1))];
}

interface CashierRow {
  key: string;
  label: string;
  orders: number | null;
  net: number | null;
  avgTicket: number | null;
  discountRate: number | null;
  voidRate: number | null;
}

export default function Cashiers() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { filters } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const body: AnalyticsQueryBody = {
    ...base,
    ...reportQuerySpec(SEGMENT, "byCashier", filters),
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...(compare ? { compare } : {}),
  };
  // TWO REQUESTS, NOT ONE — see the registry note on `byCashierVoids`. A
  // void_rate_by_cashier asked for beside `orders` makes the planner drop the
  // void exclusion for the whole order-fact statement, so the order count, the
  // average ticket and the discount rate on this very row would each silently
  // switch population. The rate comes back on its own and is merged by cashier
  // key below.
  const voidsBody: AnalyticsQueryBody = {
    ...base,
    ...reportQuerySpec(SEGMENT, "byCashierVoids", filters),
    sort: [{ by: "voids_count", dir: "desc" }],
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const query = useAnalyticsQuery(SEGMENT, body, { enabled: catalogReady });
  const voidsQuery = useAnalyticsQuery(`${SEGMENT}-voids`, voidsBody, { enabled: catalogReady });

  const cashierRows = useMemo<CashierRow[]>(() => {
    // Merge on the cashier key. A cashier present in only one result keeps a
    // null in the other column — never a 0, which would read as "no voids"
    // when the truth is "not measured on this side".
    const voidRateByKey = new Map<string, number | null>(
      (voidsQuery.data?.rows ?? []).map((row) => [
        String(row.keys[0] ?? ""),
        displayMetric(row, "void_rate_by_cashier"),
      ]),
    );
    return (query.data?.rows ?? []).map((row) => {
      const key = String(row.keys[0] ?? "");
      return {
        key,
        label: row.labels[0] ?? key,
        orders: displayMetric(row, "orders"),
        net: displayMetric(row, "net_ex_vat"),
        avgTicket: displayMetric(row, "avg_ticket"),
        discountRate: displayMetric(row, "discount_rate_by_cashier"),
        voidRate: voidRateByKey.get(key) ?? null,
      };
    });
  }, [query.data, voidsQuery.data]);

  const thresholds = useMemo(
    () => ({
      discountRate: p75(cashierRows.map((r) => r.discountRate)),
      voidRate: p75(cashierRows.map((r) => r.voidRate)),
    }),
    [cashierRows],
  );

  const columns = useMemo<ColumnDef<CashierRow>[]>(() => {
    const warnTone =
      (pick: (r: CashierRow) => number | null, threshold: number | null) =>
      (r: CashierRow): "warning" | undefined => {
        const v = pick(r);
        return threshold != null && v != null && v > threshold ? "warning" : undefined;
      };
    return [
      {
        id: "cashier",
        header: t("salesReports.dims.cashier"),
        accessor: (r) => r.label,
        pinStart: true, hideable: false,
        width: 160,
        sortable: true,
      },
      {
        id: "orders",
        header: t("salesReports.metrics.orders"),
        accessor: (r) => r.orders,
        cell: (r) => (r.orders == null ? "—" : formatNumber(r.orders)),
        numeric: true,
        sortable: true,
      },
      {
        id: "net",
        header: t("salesReports.metrics.net_ex_vat"),
        accessor: (r) => r.net,
        cell: (r) => (r.net == null ? "—" : formatCurrency(r.net)),
        numeric: true,
        sortable: true,
      },
      {
        id: "avgTicket",
        header: t("salesReports.metrics.avg_ticket"),
        accessor: (r) => r.avgTicket,
        cell: (r) => (r.avgTicket == null ? "—" : formatCurrency(r.avgTicket)),
        numeric: true,
        sortable: true,
      },
      {
        id: "discountRate",
        header: t("salesReports.metrics.discount_rate_by_cashier"),
        accessor: (r) => r.discountRate,
        cell: (r) => (r.discountRate == null ? "—" : fmtPercent(r.discountRate)),
        cellTone: warnTone((r) => r.discountRate, thresholds.discountRate),
        numeric: true,
        sortable: true,
      },
      {
        id: "voidRate",
        header: t("salesReports.metrics.void_rate_by_cashier"),
        accessor: (r) => r.voidRate,
        cell: (r) => (r.voidRate == null ? "—" : fmtPercent(r.voidRate)),
        cellTone: warnTone((r) => r.voidRate, thresholds.voidRate),
        numeric: true,
        sortable: true,
      },
      // return_rate_by_cashier column removed — see the METRICS note above.
    ];
  }, [t, thresholds]);

  if (registry.isLoading || query.isLoading) return <LoadingState rows={6} />;
  const loadError = registry.error ?? query.error;
  if (loadError) {
    return (
      <ErrorState
        error={loadError}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void query.refetch();
        }}
      />
    );
  }
  if (cashierRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  const kpis = [
    { id: "orders", icon: ShoppingBag, tone: "violet" as const, format: formatNumber },
    { id: "net_ex_vat", icon: Coins, tone: "teal" as const, format: formatCurrency },
    { id: "avg_ticket", icon: Ticket, tone: "amber" as const, format: formatCurrency },
  ];

  return (
    <section className="space-y-4" data-testid="page-cashiers">
      <CompletenessNotice meta={query.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="kpi-row">
        {kpis.map(({ id, icon, tone, format }) => {
          const v = totalValue(query.data, id);
          return (
            <MetricCard
              key={id}
              label={t(`salesReports.metrics.${id}`)}
              value={v == null ? "—" : format(v)}
              icon={icon}
              tone={tone}
              explain={metricExplain(t, registry.data, id)}
            />
          );
        })}
      </div>

      {/* No chart here: reports are decision tables — charts live on the
          dashboard. The net-by-cashier ranking is the table's default sort. */}
      <DataTable<CashierRow>
        columns={columns}
        rows={cashierRows}
        getRowId={(r) => r.key}
        tableId="sales-hub-cashiers"
        initialSort={{ columnId: "net", dir: "desc" }}
        // Wave-4 drill: orders segment with the cashier pinned (`cashierId`
        // codec param merged into the current search — one history push).
        onRowClick={(r) =>
          r.key !== "" && navigate(segmentHref(location.search, "orders", { cashierId: r.key }))
        }
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
