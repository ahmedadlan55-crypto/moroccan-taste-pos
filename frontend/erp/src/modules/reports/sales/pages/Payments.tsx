// Sales Analytics Hub — "payments" page.
//
// Collections KPIs (payments in / refunds out / net collections / tips — tips
// renders "—" when null) and a per-method table with the in/out direction
// split (refunds cells carry the negative cellTone). Wave 4: a method row
// drills by pinning the shared `paymentMethod` codec param (push:true — Back
// restores).
import { useMemo } from "react";
import { HandCoins, Undo2, Wallet, Coins } from "lucide-react";
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
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
  type AnalyticsResultRow,
} from "../lib/api";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";

const SEGMENT = "payments";
const KPI_METRICS = ["payments_in", "refunds_out", "net_collections", "tips_total"] as const;

// The TopBar ExportMenu asks this page's registry entry for its export shape.
setPageExportRequest(SEGMENT, () => ({
  metrics: ["payments_in", "refunds_out", "net_collections"],
  dimensions: ["payment_method"],
  sort: [{ by: "payments_in", dir: "desc" }],
}));

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

/** The masked/missing contract for a single-row (dimensionless) KPI result. */
function kpiValue(
  result: AnalyticsResult | undefined,
  row: AnalyticsResultRow | undefined,
  id: string,
  format: (v: number) => string,
): string {
  if (!row || result?.meta.maskedMetrics.includes(id)) return "—";
  const v = displayMetric(row, id);
  return v == null ? "—" : format(v);
}

interface MethodRow {
  key: string;
  label: string;
  paymentsIn: number | null;
  refundsOut: number | null;
  net: number | null;
}

export default function Payments() {
  const t = useT();
  const { filters, patch } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  // Wave-4 drill: pin the clicked method as the shared paymentMethod filter.
  const drillMethod = (method: string) => {
    if (method !== "") patch({ paymentMethod: [method] }, { push: true });
  };

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);

  const kpiBody: AnalyticsQueryBody = {
    ...base,
    metrics: [...KPI_METRICS],
    dimensions: [],
    ...(compare ? { compare } : {}),
  };
  const byMethodBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["payments_in", "refunds_out", "net_collections"],
    dimensions: ["payment_method"],
    sort: [{ by: "payments_in", dir: "desc" }],
  };

  // Data queries wait for a VALID metric catalog: without one there is nothing
  // to label or explain, and a disabled query never fires a doomed request.
  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const kpis = useAnalyticsQuery(SEGMENT, kpiBody, { enabled: catalogReady });
  const byMethod = useAnalyticsQuery(SEGMENT, byMethodBody, { enabled: catalogReady });

  const kpiRow = kpis.data?.rows[0];

  const methodRows = useMemo<MethodRow[]>(
    () =>
      (byMethod.data?.rows ?? []).map((row) => ({
        key: String(row.keys[0] ?? ""),
        label: row.labels[0] ?? String(row.keys[0] ?? ""),
        paymentsIn: displayMetric(row, "payments_in"),
        refundsOut: displayMetric(row, "refunds_out"),
        net: displayMetric(row, "net_collections"),
      })),
    [byMethod.data],
  );

  const columns = useMemo<ColumnDef<MethodRow>[]>(
    () => [
      {
        id: "method",
        header: t("salesReports.dims.payment_method"),
        accessor: (r) => r.label,
        pinStart: true, hideable: false,
        width: 160,
        sortable: true,
      },
      {
        id: "paymentsIn",
        header: t("salesReports.metrics.payments_in"),
        accessor: (r) => r.paymentsIn,
        cell: (r) => (r.paymentsIn == null ? "—" : formatCurrency(r.paymentsIn)),
        numeric: true,
        sortable: true,
      },
      {
        id: "refundsOut",
        header: t("salesReports.metrics.refunds_out"),
        accessor: (r) => r.refundsOut,
        cell: (r) => (r.refundsOut == null ? "—" : formatCurrency(r.refundsOut)),
        cellTone: (r) => (r.refundsOut != null && r.refundsOut > 0 ? "negative" : undefined),
        numeric: true,
        sortable: true,
      },
      {
        id: "net",
        header: t("salesReports.metrics.net_collections"),
        accessor: (r) => r.net,
        cell: (r) => (r.net == null ? "—" : formatCurrency(r.net)),
        numeric: true,
        sortable: true,
      },
    ],
    [t],
  );

  const isLoading = registry.isLoading || kpis.isLoading || byMethod.isLoading;
  const error = registry.error ?? kpis.error ?? byMethod.error;

  if (isLoading) return <LoadingState rows={6} />;
  if (error) {
    return (
      <ErrorState
        error={error}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void kpis.refetch();
          void byMethod.refetch();
        }}
      />
    );
  }
  if (methodRows.length === 0) {
    return <EmptyState title={t("salesReports.states.empty")} />;
  }

  const kpiCards = [
    { id: "payments_in", icon: HandCoins, tone: "teal" as const },
    { id: "refunds_out", icon: Undo2, tone: "rose" as const },
    { id: "net_collections", icon: Wallet, tone: "blue" as const },
    { id: "tips_total", icon: Coins, tone: "amber" as const },
  ];

  return (
    <section className="space-y-4" data-testid="page-payments">
      <CompletenessNotice meta={byMethod.data?.meta} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="kpi-row">
        {kpiCards.map(({ id, icon, tone }) => (
          <MetricCard
            key={id}
            label={t(`salesReports.metrics.${id}`)}
            value={kpiValue(kpis.data, kpiRow, id, formatCurrency)}
            icon={icon}
            tone={tone}
            explain={metricExplain(t, registry.data, id)}
          />
        ))}
      </div>

      {/* No chart here by design: reports are decision tables — charts live on the dashboard. */}
      <DataTable<MethodRow>
        columns={columns}
        rows={methodRows}
        getRowId={(r) => r.key}
        tableId="sales-hub-payments"
        initialSort={{ columnId: "paymentsIn", dir: "desc" }}
        onRowClick={(r) => drillMethod(r.key)}
        emptyTitle={t("salesReports.states.empty")}
      />
    </section>
  );
}
