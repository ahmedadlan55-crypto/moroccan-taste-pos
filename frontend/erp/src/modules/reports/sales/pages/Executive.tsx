// Sales Analytics Hub — "executive": the administrative sales report.
//
// This screen is a REPORT, not a dashboard. Managers and accountants read it
// top-to-bottom the way they read a statement: a header that pins down exactly
// which numbers these are (period, basis, tax mode, filters), then a stepped
// sales statement, the tax breakdown a VAT return needs, collections with a
// sales-vs-collections reconciliation line, returns and voids, cost and margin,
// and finally the day-by-day detail with a totals row.
//
// Deliberately CHART-FREE: charts crowd a report that exists to be read,
// printed and reconciled. The visual analysis lives on the other sections
// (explorer, hours, branches…) — this one carries the figures.
import { useMemo, type ReactNode } from "react";
import { Printer } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  ExplainNumber,
  LoadingState,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { formatCurrency, formatDateTime, formatNumber } from "@/shared/lib";
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

const SEGMENT = "executive";

/**
 * Every figure the report needs, dimensionless — in TWO requests, not one.
 *
 * lib/analytics/planner.js caps a request at MAX_METRICS = 12 and answers
 * VALIDATION_ERROR / 422 above it. The report needs 23 figures, so asking for
 * them in a single query made EVERY load of this page 422 — the screen was an
 * ErrorState with no data at all. Split into two dimensionless requests over
 * the identical filters/compare and merged by `f()` below.
 *
 * The split is NOT arbitrary: the three cost-gated metrics (cogs /
 * gross_profit / margin_pct) sit in group B alongside eight ungated ones, so a
 * viewer without analytics.cost.view gets them masked out of a still-valid
 * response. Isolating them in a request of their own would be refused whole
 * with 403 ANALYTICS_ALL_MASKED and break the page for managers.
 */
const SUMMARY_METRICS_A = [
  "gross_product_sales",
  "discounts_total",
  "returns_net",
  "net_ex_vat",
  "vat_amount",
  "fees_total",
  "rounding_total",
  "invoice_total",
  "orders",
  "avg_ticket",
  "qty_sold",
  "avg_items_per_order",
] as const;

const SUMMARY_METRICS_B = [
  "guests",
  "returns_count",
  "returns_value",
  "voids_count",
  "voids_value",
  "payments_in",
  "refunds_out",
  "net_collections",
  "cogs",
  "gross_profit",
  "margin_pct",
] as const;

const IN_GROUP_A: ReadonlySet<string> = new Set<string>(SUMMARY_METRICS_A);

/** The day-by-day detail table — the one grid on this page that exports as rows. */
const DAILY_METRICS = [
  "orders",
  "gross_product_sales",
  "discounts_total",
  "net_ex_vat",
  "vat_amount",
  "invoice_total",
  "avg_ticket",
] as const;

// The TopBar ExportMenu asks this page's registry entry for its export shape.
// Without it the export silently falls back to DEFAULT_EXPORT_SPEC (net +
// orders), which is not this report. The statement/tax/collections figures are
// dimensionless and can't be exported as rows, so the export mirrors the daily
// detail table — including its date basis, so the file matches the screen.
setPageExportRequest(SEGMENT, (filters) => {
  const dim = filters.businessDay ? "business_day" : "calendar_day";
  return {
    metrics: [...DAILY_METRICS],
    dimensions: [dim],
    sort: [{ by: dim, dir: "asc" }],
  };
});

const MONEY_EPSILON = 0.01;

/* ── local helpers ───────────────────────────────────────────────────────── */

function compareSpec(filters: AnalyticsFilters): AnalyticsCompareSpec | undefined {
  if (filters.compare === "none") return undefined;
  return {
    mode: filters.compare,
    ...computeCompareRange(filters.compare, { from: filters.from, to: filters.to }),
  };
}

function metricExplain(t: TFunction, registry: AnalyticsRegistry | undefined, code: string) {
  const equationKey = registry?.metrics?.find?.((m) => m.id === code)?.equationKey;
  return (
    <ExplainNumber
      title={t(`salesReports.metrics.${code}`)}
      formula={equationKey ? t(`salesReports.explain.${equationKey}`) : undefined}
      triggerLabel={t(`salesReports.metrics.${code}`)}
    />
  );
}

/** The masked/missing contract: a refused or absent metric is "—", never 0. */
function pick(result: AnalyticsResult | undefined, row: AnalyticsResultRow | undefined, id: string): number | null {
  if (!row || result?.meta.maskedMetrics.includes(id)) return null;
  return displayMetric(row, id);
}

function money(v: number | null): string {
  return v == null ? "—" : formatCurrency(v);
}
function count(v: number | null): string {
  return v == null ? "—" : formatNumber(v);
}
function percent(v: number | null): string {
  return v == null ? "—" : `${formatNumber(v)}%`;
}

/** Right-aligned, always LTR, tabular — the house rule for every figure. */
function Figure({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      dir="ltr"
      className={`block text-end tabular-nums ${strong ? "font-extrabold text-slate-900" : "font-bold text-slate-700"}`}
    >
      {children}
    </span>
  );
}

function Section({
  title,
  note,
  action,
  children,
  testId,
}: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="surface overflow-hidden" data-testid={testId}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-extrabold text-slate-900">{title}</h3>
          {note && <p className="mt-0.5 text-xs font-medium text-slate-500">{note}</p>}
        </div>
        {action}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

interface StatementLine {
  id: string;
  label: string;
  value: number | null;
  /** "−" / "+" / "=" sign shown before the label, statement-style. */
  op?: "add" | "sub" | "eq";
  strong?: boolean;
  explain?: ReactNode;
  compare?: number | null;
}

function Statement({ lines, showCompare, compareLabel }: { lines: StatementLine[]; showCompare: boolean; compareLabel: string }) {
  return (
    <table className="w-full min-w-[22rem] text-sm">
      <tbody>
        {showCompare && (
          <tr className="border-b border-slate-100 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
            <th scope="col" className="px-4 py-2 text-start font-extrabold">
              &nbsp;
            </th>
            <th scope="col" className="px-4 py-2 text-end font-extrabold">
              &nbsp;
            </th>
            <th scope="col" className="px-4 py-2 text-end font-extrabold">
              {compareLabel}
            </th>
          </tr>
        )}
        {lines.map((line) => (
          <tr
            key={line.id}
            // Stable per-line anchor: the statement is where the money figures
            // live now that this page is chart-free, so the harness needs to
            // read a NAMED line (net_ex_vat, invoice_total…) rather than
            // "the first card in the KPI row" — which today is `orders`.
            data-line={line.id}
            className={
              line.op === "eq"
                ? "border-y border-slate-200 bg-slate-50"
                : "border-b border-slate-50"
            }
          >
            <th scope="row" className="px-4 py-2.5 text-start font-bold text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                {line.op === "sub" && <span aria-hidden="true" className="text-slate-400">−</span>}
                {line.op === "add" && <span aria-hidden="true" className="text-slate-400">+</span>}
                {line.op === "eq" && <span aria-hidden="true" className="text-slate-400">=</span>}
                <span className={line.strong ? "font-extrabold text-slate-900" : undefined}>{line.label}</span>
                {line.explain}
              </span>
            </th>
            <td className="w-40 px-4 py-2.5">
              <Figure strong={line.strong}>{money(line.value)}</Figure>
            </td>
            {showCompare && (
              <td className="w-40 px-4 py-2.5">
                <Figure>{money(line.compare ?? null)}</Figure>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Compact label/figure grid — the operational counters, no icons, no cards. */
function Figures({ items, testId }: { items: Array<{ id: string; label: string; value: string }>; testId?: string }) {
  return (
    <dl
      data-testid={testId}
      className="grid grid-cols-2 divide-slate-100 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:rtl:divide-x-reverse"
    >
      {items.map((it) => (
        <div key={it.id} className="border-b border-slate-100 px-4 py-3 lg:border-b-0">
          <dt className="truncate text-xs font-bold text-slate-500">{it.label}</dt>
          <dd dir="ltr" className="mt-1 text-lg font-extrabold tabular-nums text-slate-900 text-end lg:text-start">
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  values: Array<{ id: string; text: string; strong?: boolean }>;
}

function Breakdown({
  head,
  rows,
  total,
  emptyLabel,
}: {
  head: string[];
  rows: BreakdownRow[];
  total?: BreakdownRow;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-xs font-bold text-slate-400">{emptyLabel}</p>;
  }
  return (
    <table className="w-full min-w-[28rem] text-sm">
      <thead>
        <tr className="border-b border-slate-100 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
          {head.map((h, i) => (
            <th key={h} scope="col" className={`px-4 py-2 ${i === 0 ? "text-start" : "text-end"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-slate-50">
            <th scope="row" className="px-4 py-2.5 text-start font-bold text-slate-700">
              {r.label}
            </th>
            {r.values.map((v) => (
              <td key={v.id} className="px-4 py-2.5">
                <Figure strong={v.strong}>{v.text}</Figure>
              </td>
            ))}
          </tr>
        ))}
        {total && (
          <tr className="border-t border-slate-200 bg-slate-50">
            <th scope="row" className="px-4 py-2.5 text-start font-extrabold text-slate-900">
              {total.label}
            </th>
            {total.values.map((v) => (
              <td key={v.id} className="px-4 py-2.5">
                <Figure strong>{v.text}</Figure>
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </table>
  );
}

interface DayRow {
  day: string;
  label: string;
  orders: number | null;
  gross: number | null;
  discounts: number | null;
  net: number | null;
  vat: number | null;
  total: number | null;
  avgTicket: number | null;
}

/* ── page ────────────────────────────────────────────────────────────────── */

export default function Executive() {
  const t = useT();
  const { filters, patch } = useUrlFilters(analyticsFilterCodec);
  const registry = useAnalyticsRegistry();

  const base = buildFiltersBody(filters);
  const compare = compareSpec(filters);
  const dayDim = filters.businessDay ? "business_day" : "calendar_day";

  const summaryBodyA: AnalyticsQueryBody = {
    ...base,
    metrics: [...SUMMARY_METRICS_A],
    dimensions: [],
    ...(compare ? { compare } : {}),
  };
  const summaryBodyB: AnalyticsQueryBody = {
    ...base,
    metrics: [...SUMMARY_METRICS_B],
    dimensions: [],
    ...(compare ? { compare } : {}),
  };
  const byDayBody: AnalyticsQueryBody = {
    ...base,
    metrics: [...DAILY_METRICS],
    dimensions: [dayDim],
    sort: [{ by: dayDim, dir: "asc" }],
  };
  const byTaxBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["net_ex_vat", "vat_amount"],
    dimensions: ["vat_category"],
  };
  const byPaymentBody: AnalyticsQueryBody = {
    ...base,
    metrics: ["payments_in", "refunds_out", "net_collections"],
    dimensions: ["payment_method"],
    sort: [{ by: "payments_in", dir: "desc" }],
  };

  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const summaryA = useAnalyticsQuery(SEGMENT, summaryBodyA, { enabled: catalogReady });
  const summaryB = useAnalyticsQuery(SEGMENT, summaryBodyB, { enabled: catalogReady });
  const byDay = useAnalyticsQuery(SEGMENT, byDayBody, { enabled: catalogReady });
  const byTax = useAnalyticsQuery(SEGMENT, byTaxBody, { enabled: catalogReady });
  const byPayment = useAnalyticsQuery(SEGMENT, byPaymentBody, { enabled: catalogReady });

  const hasCompare = filters.compare !== "none";
  const rowA = summaryA.data?.rows[0];
  const rowB = summaryB.data?.rows[0];
  /** Read a figure from whichever of the two summary requests carries it. */
  const f = (id: string) =>
    IN_GROUP_A.has(id) ? pick(summaryA.data, rowA, id) : pick(summaryB.data, rowB, id);
  const c = (id: string): number | null => {
    if (!hasCompare) return null;
    const v = (IN_GROUP_A.has(id) ? rowA : rowB)?.compare?.[id];
    return typeof v === "number" ? v : null;
  };

  const dayRows = useMemo<DayRow[]>(
    () =>
      (byDay.data?.rows ?? []).map((r) => ({
        day: String(r.keys[0] ?? ""),
        label: r.labels[0] ?? String(r.keys[0] ?? ""),
        orders: displayMetric(r, "orders"),
        gross: displayMetric(r, "gross_product_sales"),
        discounts: displayMetric(r, "discounts_total"),
        net: displayMetric(r, "net_ex_vat"),
        vat: displayMetric(r, "vat_amount"),
        total: displayMetric(r, "invoice_total"),
        avgTicket: displayMetric(r, "avg_ticket"),
      })),
    [byDay.data],
  );

  const dayColumns = useMemo<ColumnDef<DayRow>[]>(
    () => [
      {
        id: "day",
        header: t(`salesReports.dims.${dayDim}`),
        accessor: (r) => r.day,
        cell: (r) => r.label,
        pinStart: true,
        width: 128,
        sortable: true,
      },
      { id: "orders", header: t("salesReports.metrics.orders"), accessor: (r) => r.orders, cell: (r) => count(r.orders), numeric: true, sortable: true },
      { id: "gross", header: t("salesReports.metrics.gross_product_sales"), accessor: (r) => r.gross, cell: (r) => money(r.gross), numeric: true, sortable: true },
      { id: "discounts", header: t("salesReports.metrics.discounts_total"), accessor: (r) => r.discounts, cell: (r) => money(r.discounts), numeric: true, sortable: true },
      { id: "net", header: t("salesReports.metrics.net_ex_vat"), accessor: (r) => r.net, cell: (r) => money(r.net), numeric: true, sortable: true },
      { id: "vat", header: t("salesReports.metrics.vat_amount"), accessor: (r) => r.vat, cell: (r) => money(r.vat), numeric: true, sortable: true },
      { id: "total", header: t("salesReports.metrics.invoice_total"), accessor: (r) => r.total, cell: (r) => money(r.total), numeric: true, sortable: true },
      { id: "avgTicket", header: t("salesReports.metrics.avg_ticket"), accessor: (r) => r.avgTicket, cell: (r) => money(r.avgTicket), numeric: true, sortable: true },
    ],
    [t, dayDim],
  );

  const isLoading =
    registry.isLoading || summaryA.isLoading || summaryB.isLoading ||
    byDay.isLoading || byTax.isLoading || byPayment.isLoading;
  const error =
    registry.error ?? summaryA.error ?? summaryB.error ?? byDay.error ?? byTax.error ?? byPayment.error;

  if (isLoading) return <LoadingState rows={6} />;
  if (error) {
    return (
      <ErrorState
        error={error}
        title={t("salesReports.states.loadFailed")}
        onRetry={() => {
          void registry.refetch();
          void summaryA.refetch();
          void summaryB.refetch();
          void byDay.refetch();
          void byTax.refetch();
          void byPayment.refetch();
        }}
      />
    );
  }
  if (dayRows.length === 0) return <EmptyState title={t("salesReports.states.empty")} />;

  /* ── derived report figures ── */

  const invoiceTotal = f("invoice_total");
  const netCollections = f("net_collections");
  const settlementDiff =
    invoiceTotal == null || netCollections == null ? null : invoiceTotal - netCollections;
  const balanced = settlementDiff != null && Math.abs(settlementDiff) < MONEY_EPSILON;

  const netExVat = f("net_ex_vat");
  const voidsValue = f("voids_value");
  const returnsValue = f("returns_value");
  const share = (part: number | null): number | null =>
    part == null || netExVat == null || netExVat === 0 ? null : (part / netExVat) * 100;

  const statementLines: StatementLine[] = [
    { id: "gross", label: t("salesReports.metrics.gross_product_sales"), value: f("gross_product_sales"), compare: c("gross_product_sales"), explain: metricExplain(t, registry.data, "gross_product_sales") },
    { id: "discounts", label: t("salesReports.metrics.discounts_total"), value: f("discounts_total"), compare: c("discounts_total"), op: "sub" },
    { id: "returns", label: t("salesReports.metrics.returns_net"), value: f("returns_net"), compare: c("returns_net"), op: "sub" },
    { id: "net", label: t("salesReports.metrics.net_ex_vat"), value: netExVat, compare: c("net_ex_vat"), op: "eq", strong: true, explain: metricExplain(t, registry.data, "net_ex_vat") },
    { id: "vat", label: t("salesReports.metrics.vat_amount"), value: f("vat_amount"), compare: c("vat_amount"), op: "add" },
    { id: "fees", label: t("salesReports.metrics.fees_total"), value: f("fees_total"), compare: c("fees_total"), op: "add" },
    { id: "rounding", label: t("salesReports.metrics.rounding_total"), value: f("rounding_total"), compare: c("rounding_total"), op: "add" },
    { id: "total", label: t("salesReports.metrics.invoice_total"), value: invoiceTotal, compare: c("invoice_total"), op: "eq", strong: true, explain: metricExplain(t, registry.data, "invoice_total") },
  ];

  const taxRows: BreakdownRow[] = (byTax.data?.rows ?? []).map((r) => ({
    key: String(r.keys[0] ?? ""),
    label: r.labels[0] ?? String(r.keys[0] ?? "—"),
    values: [
      { id: "base", text: money(displayMetric(r, "net_ex_vat")) },
      { id: "tax", text: money(displayMetric(r, "vat_amount")) },
    ],
  }));

  const paymentRows: BreakdownRow[] = (byPayment.data?.rows ?? []).map((r) => {
    const inAmt = displayMetric(r, "payments_in");
    const pct =
      inAmt == null || netCollections == null || netCollections === 0 ? null : (inAmt / netCollections) * 100;
    return {
      key: String(r.keys[0] ?? ""),
      label: r.labels[0] ?? String(r.keys[0] ?? "—"),
      values: [
        { id: "in", text: money(inAmt) },
        { id: "out", text: money(displayMetric(r, "refunds_out")) },
        { id: "net", text: money(displayMetric(r, "net_collections")), strong: true },
        { id: "share", text: percent(pct) },
      ],
    };
  });

  const cogs = f("cogs");
  const grossProfit = f("gross_profit");
  const showProfit = cogs != null || grossProfit != null;

  const activeFilterChips = [
    filters.brandId.length > 0 && `${t("salesReports.topbar.brand")} (${filters.brandId.length})`,
    filters.branchId.length > 0 && `${t("salesReports.topbar.branch")} (${filters.branchId.length})`,
    filters.channel.length > 0 && `${t("salesReports.topbar.channel")} (${filters.channel.length})`,
    filters.orderType.length > 0 && `${t("salesReports.topbar.orderType")} (${filters.orderType.length})`,
  ].filter(Boolean) as string[];

  const freshness = summaryA.data?.meta.freshness?.watermark;

  return (
    <section className="space-y-4" data-testid="page-executive">
      {/* ── report identity: exactly which numbers these are ── */}
      <header className="surface flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-extrabold text-slate-900">{t("salesReports.report.title")}</h2>
          <p dir="ltr" className="text-xs font-bold tabular-nums text-slate-600 text-start">
            {filters.from} → {filters.to}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold text-slate-500">
            <Badge tone="neutral">
              {filters.businessDay ? t("salesReports.topbar.businessDay") : t("salesReports.topbar.calendarDay")}
            </Badge>
            <Badge tone="neutral">
              {filters.taxIncl ? t("salesReports.topbar.taxIncl") : t("salesReports.topbar.taxExcl")}
            </Badge>
            {activeFilterChips.map((chip) => (
              <Badge key={chip} tone="info">
                {chip}
              </Badge>
            ))}
            {freshness && (
              // data-freshness-watermark is the AGREED mask hook (see
              // e2e/erp/visual-baselines.spec.ts): the watermark is the server's
              // generatedAt when no rollup high-water mark exists, so it changes
              // on every single render. Without the attribute this line diffs
              // the pinned baseline on every run — the mask exists precisely for
              // the moment a screen started showing it, which is now.
              <span data-freshness-watermark className="text-slate-400">
                {t("salesReports.topbar.refreshedAt")}: {formatDateTime(freshness)}
              </span>
            )}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => window.print()} className="print:hidden">
          <Printer className="h-4 w-4" aria-hidden="true" />
          {t("salesReports.report.print")}
        </Button>
      </header>

      {/* ── operational counters (the harness's kpi-row anchor) ── */}
      <div className="surface overflow-hidden">
        <Figures
          testId="kpi-row"
          items={[
            { id: "orders", label: t("salesReports.metrics.orders"), value: count(f("orders")) },
            { id: "avg_ticket", label: t("salesReports.metrics.avg_ticket"), value: money(f("avg_ticket")) },
            { id: "qty_sold", label: t("salesReports.metrics.qty_sold"), value: count(f("qty_sold")) },
            { id: "avg_items_per_order", label: t("salesReports.metrics.avg_items_per_order"), value: count(f("avg_items_per_order")) },
            { id: "guests", label: t("salesReports.metrics.guests"), value: count(f("guests")) },
          ]}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          testId="statement-sales"
          title={t("salesReports.report.sectionSummary")}
          note={t("salesReports.report.sectionSummaryNote")}
        >
          <Statement
            lines={statementLines}
            showCompare={hasCompare}
            compareLabel={t("salesReports.topbar.compare")}
          />
        </Section>

        <Section title={t("salesReports.report.sectionTax")} note={t("salesReports.report.sectionTaxNote")}>
          <Breakdown
            head={[t("salesReports.dims.vat_category"), t("salesReports.report.taxableBase"), t("salesReports.metrics.vat_amount")]}
            rows={taxRows}
            total={{
              key: "total",
              label: t("salesReports.report.totalRow"),
              values: [
                { id: "base", text: money(netExVat) },
                { id: "tax", text: money(f("vat_amount")) },
              ],
            }}
            emptyLabel={t("salesReports.states.empty")}
          />
        </Section>

        <Section
          title={t("salesReports.report.sectionCollections")}
          note={t("salesReports.report.sectionCollectionsNote")}
          action={
            settlementDiff == null ? null : (
              <Badge tone={balanced ? "success" : "warning"}>
                {balanced
                  ? t("salesReports.report.balanced")
                  : `${t("salesReports.report.difference")}: ${formatCurrency(settlementDiff)}`}
              </Badge>
            )
          }
        >
          <Breakdown
            head={[
              t("salesReports.dims.payment_method"),
              t("salesReports.metrics.payments_in"),
              t("salesReports.metrics.refunds_out"),
              t("salesReports.metrics.net_collections"),
              t("salesReports.report.share"),
            ]}
            rows={paymentRows}
            total={{
              key: "total",
              label: t("salesReports.report.totalRow"),
              values: [
                { id: "in", text: money(f("payments_in")) },
                { id: "out", text: money(f("refunds_out")) },
                { id: "net", text: money(netCollections) },
                { id: "share", text: netCollections == null ? "—" : percent(100) },
              ],
            }}
            emptyLabel={t("salesReports.states.empty")}
          />
        </Section>

        <Section title={t("salesReports.report.sectionReturns")} note={t("salesReports.report.sectionReturnsNote")}>
          <Breakdown
            head={[
              t("salesReports.report.item"),
              t("salesReports.report.countCol"),
              t("salesReports.report.valueCol"),
              t("salesReports.report.share"),
            ]}
            rows={[
              {
                key: "returns",
                label: t("salesReports.metrics.returns_value"),
                values: [
                  { id: "n", text: count(f("returns_count")) },
                  { id: "v", text: money(returnsValue) },
                  { id: "s", text: percent(share(returnsValue)) },
                ],
              },
              {
                key: "voids",
                label: t("salesReports.metrics.voids_value"),
                values: [
                  { id: "n", text: count(f("voids_count")) },
                  { id: "v", text: money(voidsValue) },
                  { id: "s", text: percent(share(voidsValue)) },
                ],
              },
            ]}
            emptyLabel={t("salesReports.states.empty")}
          />
        </Section>
      </div>

      {showProfit && (
        <Section title={t("salesReports.report.sectionProfit")} note={t("salesReports.report.sectionProfitNote")}>
          <Statement
            showCompare={hasCompare}
            compareLabel={t("salesReports.topbar.compare")}
            lines={[
              { id: "net", label: t("salesReports.metrics.net_ex_vat"), value: netExVat, compare: c("net_ex_vat") },
              { id: "cogs", label: t("salesReports.metrics.cogs"), value: cogs, compare: c("cogs"), op: "sub", explain: metricExplain(t, registry.data, "cogs") },
              { id: "profit", label: t("salesReports.metrics.gross_profit"), value: grossProfit, compare: c("gross_profit"), op: "eq", strong: true, explain: metricExplain(t, registry.data, "gross_profit") },
            ]}
          />
          <div className="border-t border-slate-100 px-4 py-2.5 text-sm">
            <span className="font-bold text-slate-600">{t("salesReports.metrics.margin_pct")}</span>
            <span dir="ltr" className="ms-2 font-extrabold tabular-nums text-slate-900">
              {percent(f("margin_pct"))}
            </span>
          </div>
        </Section>
      )}

      <Section title={t("salesReports.report.sectionDaily")} note={t(`salesReports.dims.${dayDim}`)}>
        <DataTable<DayRow>
          columns={dayColumns}
          rows={dayRows}
          getRowId={(r) => r.day}
          initialSort={{ columnId: "day", dir: "asc" }}
          onRowClick={(r) => patch({ from: r.day, to: r.day, preset: "custom" }, { push: true })}
          emptyTitle={t("salesReports.states.empty")}
        />
      </Section>
    </section>
  );
}
