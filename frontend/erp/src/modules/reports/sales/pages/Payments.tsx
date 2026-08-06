// Sales Analytics Hub — collections and payment reconciliation.
//
// The table is intentionally a query-driven breakdown, not a fixed
// "by payment method" list. The page-local `pg` URL parameter is a shareable
// description of the selected levels and the exact same request shape is
// registered for export.
import { useEffect, useMemo } from "react";
import {
  CalendarDays,
  CalendarRange,
  Clock3,
  CreditCard,
  HandCoins,
  Undo2,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, EmptyState, ErrorState, ExplainNumber, LoadingState, MetricCard } from "@/shared/ui";
import { DataTable } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { useLang, useT, type Lang, type TFunction } from "@/i18n";
import {
  analyticsFilterCodec,
  csvParam,
  makeCodec,
  type AnalyticsFilters,
} from "../lib/filters";
import {
  buildFiltersBody,
  displayMetric,
  reportQuerySpec,
  setPageExportRequest,
  type AnalyticsCompareSpec,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
  type AnalyticsResultRow,
} from "../lib/api";
import { LIMITS } from "../lib/contract";
import { reconcile } from "../lib/grouping";
import { buildResultColumns, toResultRows, type ResultTableRow } from "../lib/resultTable";
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { GroupByControl, MAX_GROUP_DIMS } from "../components/GroupByControl";

const SEGMENT = "payments";
const PAYMENT_METRICS = ["payments_in", "refunds_out", "net_collections"] as const;

const GROUP_TOKENS = ["day", "weekday", "hour", "payment_collector", "payment_method"] as const;
type PaymentGroupToken = (typeof GROUP_TOKENS)[number];

const paymentsCodec = makeCodec({
  pg: csvParam(["payment_method"]),
});

interface NormalizedGroups {
  tokens: PaymentGroupToken[];
  adjusted: boolean;
}

/** URL input is untrusted: dedupe, canonicalise old date ids and obey the planner ceiling. */
export function normalizePaymentGroups(raw: readonly string[]): NormalizedGroups {
  const out: PaymentGroupToken[] = [];
  let adjusted = false;
  for (const value of raw) {
    const canonical = value === "business_day" || value === "calendar_day" ? "day" : value;
    if (!(GROUP_TOKENS as readonly string[]).includes(canonical)) {
      adjusted = true;
      continue;
    }
    const token = canonical as PaymentGroupToken;
    if (out.includes(token)) {
      adjusted = true;
      continue;
    }
    if (out.length >= MAX_GROUP_DIMS) {
      adjusted = true;
      continue;
    }
    out.push(token);
  }
  if (out.length === 0) {
    if (raw.length > 0) adjusted = true;
    out.push("payment_method");
  }
  return { tokens: out, adjusted };
}

function resolveGroup(token: PaymentGroupToken, filters: AnalyticsFilters): string {
  return token === "day" ? (filters.businessDay ? "business_day" : "calendar_day") : token;
}

function compareSpec(filters: AnalyticsFilters): AnalyticsCompareSpec | undefined {
  if (filters.compare === "none") return undefined;
  return {
    mode: filters.compare,
    ...computeCompareRange(filters.compare, { from: filters.from, to: filters.to }),
  };
}

function tokenFromDimension(dimension: string): PaymentGroupToken | null {
  if (dimension === "business_day" || dimension === "calendar_day") return "day";
  return (GROUP_TOKENS as readonly string[]).includes(dimension) ? (dimension as PaymentGroupToken) : null;
}

function detailSort(dimensions: string[]): NonNullable<AnalyticsQueryBody["sort"]> {
  const levels = dimensions.map((dimension) => ({
    by: dimension,
    dir: dimension === "business_day" || dimension === "calendar_day" ? ("desc" as const) : ("asc" as const),
  }));
  return [...levels, { by: "payments_in", dir: "desc" }];
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

function kpiValue(
  result: AnalyticsResult | undefined,
  row: AnalyticsResultRow | undefined,
  id: string,
): string {
  if (!row || result?.meta.maskedMetrics.includes(id)) return "—";
  const value = displayMetric(row, id);
  return value == null ? "—" : formatCurrency(value);
}

const MONDAY_UTC = Date.UTC(2026, 0, 5);

function readableDimensionLabel(
  dimension: string,
  key: string | number | null,
  serverLabel: string,
  lang: Lang,
): string {
  if (key == null) return serverLabel || "—";
  if (dimension === "business_day" || dimension === "calendar_day") return formatDate(String(key));
  if (dimension === "hour") return `${String(Number(key)).padStart(2, "0")}:00`;
  if (dimension === "weekday") {
    const weekday = Number(key);
    if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA" : "en-GB", {
        weekday: "long",
        timeZone: "UTC",
      }).format(new Date(MONDAY_UTC + weekday * 86_400_000));
    }
  }
  return serverLabel || String(key);
}

function quickLabelKey(token: PaymentGroupToken): string {
  if (token === "day") return "date";
  if (token === "payment_collector") return "collector";
  if (token === "payment_method") return "method";
  return token;
}

const QUICK_GROUPS: Array<{ token: PaymentGroupToken; icon: LucideIcon }> = [
  { token: "payment_method", icon: CreditCard },
  { token: "day", icon: CalendarDays },
  { token: "weekday", icon: CalendarRange },
  { token: "hour", icon: Clock3 },
  { token: "payment_collector", icon: UserRound },
];

export default function Payments() {
  const t = useT();
  const lang = useLang();
  const shared = useUrlFilters(analyticsFilterCodec);
  const page = useUrlFilters(paymentsCodec);
  const registry = useAnalyticsRegistry();

  const normalized = useMemo(() => normalizePaymentGroups(page.filters.pg), [page.filters.pg.join("|")]);
  const requestedDimensions = useMemo(
    () => normalized.tokens.map((token) => resolveGroup(token, shared.filters)),
    [normalized.tokens.join("|"), shared.filters.businessDay],
  );
  const reconciled = useMemo(
    () => reconcile(registry.data, [...PAYMENT_METRICS], requestedDimensions),
    [registry.data, requestedDimensions.join("|")],
  );
  const dimensions = reconciled.dimensions.length > 0 ? reconciled.dimensions : ["payment_method"];
  const currentTokens = dimensions
    .map(tokenFromDimension)
    .filter((token): token is PaymentGroupToken => token != null);
  const currentDayDimension = shared.filters.businessDay ? "business_day" : "calendar_day";
  const allowedDimensions = useMemo(
    () => [currentDayDimension, "weekday", "hour", "payment_collector", "payment_method"],
    [currentDayDimension],
  );
  const collectorAvailable = registry.data?.dimensions.some((dimension) => dimension.id === "payment_collector") ?? false;

  const base = buildFiltersBody(shared.filters);
  const compare = compareSpec(shared.filters);
  const kpiBody: AnalyticsQueryBody = {
    ...base,
    ...reportQuerySpec(SEGMENT, "kpis", shared.filters),
    ...(compare ? { compare } : {}),
  };
  const sort = detailSort(dimensions);
  const detailSpec = {
    metrics: [...PAYMENT_METRICS],
    dimensions,
    sort,
    limit: LIMITS.MAX_LIMIT,
  } satisfies Pick<AnalyticsQueryBody, "metrics" | "dimensions" | "sort" | "limit">;
  const detailBody: AnalyticsQueryBody = { ...base, ...detailSpec, ...(compare ? { compare } : {}) };

  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const kpis = useAnalyticsQuery(SEGMENT, kpiBody, { enabled: catalogReady });
  const detail = useAnalyticsQuery(SEGMENT, detailBody, { enabled: catalogReady });

  useEffect(() => {
    setPageExportRequest(SEGMENT, () => ({
      metrics: [...detailSpec.metrics],
      dimensions: [...detailSpec.dimensions],
      sort: detailSpec.sort ? [...detailSpec.sort] : undefined,
      limit: detailSpec.limit,
    }));
  }, [dimensions.join("|"), JSON.stringify(sort)]);

  const rows = useMemo<ResultTableRow[]>(
    () =>
      toResultRows(detail.data?.rows ?? []).map((row) => ({
        ...row,
        labels: row.labels.map((label, index) =>
          readableDimensionLabel(dimensions[index], row.keys[index], label, lang),
        ),
      })),
    [detail.data, dimensions.join("|"), lang],
  );
  const columns = useMemo(
    () =>
      buildResultColumns({
        dimensions,
        metricIds: [...PAYMENT_METRICS],
        t,
        registry: registry.data,
        maskedMetrics: detail.data?.meta.maskedMetrics,
        pinDimensions: 1,
      }),
    [dimensions.join("|"), registry.data, detail.data?.meta.maskedMetrics.join("|"), t],
  );

  const changeGrouping = (nextDimensions: string[]) => {
    const nextTokens = nextDimensions
      .map(tokenFromDimension)
      .filter((token): token is PaymentGroupToken => token != null);
    page.patch({ pg: nextTokens.length > 0 ? nextTokens : ["payment_method"] });
  };

  const drillRow = (row: ResultTableRow) => {
    const next: Partial<AnalyticsFilters> = {};
    dimensions.forEach((dimension, index) => {
      const key = row.keys[index];
      if (key == null) return;
      if (dimension === "payment_method") next.paymentMethod = [String(key)];
      if (dimension === "hour") next.hour = String(key);
      if (dimension === "business_day" || dimension === "calendar_day") {
        next.from = String(key);
        next.to = String(key);
        next.preset = "custom";
      }
    });
    if (Object.keys(next).length > 0) shared.patch(next, { push: true });
  };
  const hasDrillableDimension = dimensions.some((d) =>
    ["payment_method", "hour", "business_day", "calendar_day"].includes(d),
  );

  const isLoading = registry.isLoading || kpis.isLoading || detail.isLoading;
  const error = registry.error ?? kpis.error ?? detail.error;
  if (isLoading) return <LoadingState rows={6} />;
  if (error) {
    return (
      <ErrorState
        error={error}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void kpis.refetch();
          void detail.refetch();
        }}
      />
    );
  }

  const kpiRow = kpis.data?.rows[0];
  const kpiCards = [
    { id: "payments_in", icon: HandCoins, tone: "teal" as const },
    { id: "refunds_out", icon: Undo2, tone: "rose" as const },
    { id: "net_collections", icon: Wallet, tone: "blue" as const },
  ];
  const groupingAdjusted = normalized.adjusted || reconciled.dropped.length > 0;

  return (
    <section className="space-y-4" data-testid="page-payments">
      <CompletenessNotice meta={detail.data?.meta} />

      <article className="surface space-y-4 p-4" data-testid="payments-breakdown-controls">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-extrabold text-slate-900">
              {t("salesReports.pages.payments.breakdown.title")}
            </h2>
            <p className="mt-1 text-sm font-medium text-slate-500">
              {t("salesReports.pages.payments.breakdown.subtitle")}
            </p>
          </div>
          <Badge tone="info">
            {t("salesReports.pages.payments.breakdown.levels", { count: dimensions.length })}
          </Badge>
        </header>

        <div
          className="flex max-w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
          role="group"
          aria-label={t("salesReports.pages.payments.breakdown.quickViews")}
        >
          {QUICK_GROUPS.map(({ token, icon: Icon }) => {
            const active = currentTokens.length === 1 && currentTokens[0] === token;
            const unavailable = token === "payment_collector" && !collectorAvailable;
            return (
              <Button
                key={token}
                size="sm"
                variant={active ? "subtle" : "secondary"}
                className="shrink-0"
                aria-pressed={active}
                disabled={unavailable}
                onClick={() => page.patch({ pg: [token] })}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {t(`salesReports.pages.payments.breakdown.${quickLabelKey(token)}`)}
              </Button>
            );
          })}
        </div>

        <GroupByControl
          registry={registry.data}
          metricIds={[...PAYMENT_METRICS]}
          value={dimensions}
          onChange={changeGrouping}
          allowedDimensionIds={allowedDimensions}
          maxDimensions={MAX_GROUP_DIMS}
        />
        <p className="text-xs font-semibold text-slate-500">
          {t("salesReports.pages.payments.breakdown.hint")}
        </p>
      </article>

      {groupingAdjusted && (
        <div
          data-testid="payments-grouping-adjusted"
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
        >
          {t("salesReports.pages.payments.breakdown.adjusted")}
        </div>
      )}
      {detail.data?.page?.rowCountCapped && (
        <div
          data-testid="payments-breakdown-limited"
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800"
        >
          {t("salesReports.pages.payments.breakdown.scopeLimited")}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3" data-testid="kpi-row">
        {kpiCards.map(({ id, icon, tone }) => (
          <MetricCard
            key={id}
            label={t(`salesReports.metrics.${id}`)}
            value={kpiValue(kpis.data, kpiRow, id)}
            icon={icon}
            tone={tone}
            explain={metricExplain(t, registry.data, id)}
          />
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t("salesReports.states.empty")} />
      ) : (
        <DataTable<ResultTableRow>
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          tableId="sales-hub-payments"
          initialPageSize={25}
          onRowClick={hasDrillableDimension ? drillRow : undefined}
          emptyTitle={t("salesReports.states.empty")}
          mobileTitle={(row) => row.labels.join(" · ")}
        />
      )}
    </section>
  );
}
