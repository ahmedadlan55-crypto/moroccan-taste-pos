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
 * Every figure the report needs, dimensionless — in THREE requests, not one.
 *
 * lib/analytics/planner.js caps a request at MAX_METRICS = 12 and answers
 * VALIDATION_ERROR / 422 above it. The report needs 28 figures, so asking for
 * them in a single query would make EVERY load of this page 422 — the screen
 * would be an ErrorState with no data at all. Split into three dimensionless
 * requests over the identical filters/compare and merged by `f()` below.
 *
 * The split is NOT arbitrary:
 *   • A is the statement — every operand of both ladders, so the arithmetic on
 *     screen comes out of ONE response and cannot be assembled from two
 *     snapshots of the window taken a moment apart.
 *   • C carries the three cost-gated metrics (cogs / gross_profit /
 *     margin_pct) BESIDE net_collections, which is ungated. A viewer without
 *     analytics.cost.view therefore gets them masked out of a still-valid
 *     response; a request of only cost metrics would be refused whole with 403
 *     ANALYTICS_ALL_MASKED and break the page for managers.
 */
const SUMMARY_METRICS_A = [
  "sales_before_discount",
  "discounts_total",
  "gross_product_sales",
  "net_ex_vat",
  "vat_amount",
  "returns_net",
  "returns_vat",
  "returns_value",
  "net_product_sales",
  "net_product_sales_ex_vat",
  "invoice_total",
  "statement_variance",
] as const;

const SUMMARY_METRICS_B = [
  "orders",
  "avg_ticket",
  "qty_sold",
  "avg_items_per_order",
  "guests",
  "fees_total",
  "rounding_total",
  "returns_count",
  "payments_in",
  "refunds_out",
] as const;

const SUMMARY_METRICS_C = [
  // VOID METRICS LIVE ALONE WITH NON-ORDER METRICS — never beside orders /
  // avg_ticket / guests / fees. lib/analytics/planner.js:356 computes the
  // void filter PER FACT STATEMENT: if ANY metric on the order fact mentions
  // 'voided', the exclusion is dropped for EVERY metric on that fact. Put
  // voids_count beside orders and the order count silently starts including
  // voided orders — and avg_ticket becomes a ratio of a void-excluded
  // numerator over a void-included denominator. Group C carries no other
  // order-population metric, so the un-exclusion reaches nothing else.
  "voids_count",
  "voids_value",
  "net_collections",
  "cogs",
  "gross_profit",
  "margin_pct",
] as const;

const IN_GROUP_A: ReadonlySet<string> = new Set<string>(SUMMARY_METRICS_A);
const IN_GROUP_B: ReadonlySet<string> = new Set<string>(SUMMARY_METRICS_B);

/**
 * The day-by-day detail table — the one grid on this page that exports as rows.
 *
 * gross_product_sales is deliberately ABSENT: it is Σ d.gross_amount, which
 * lineAllocation.js:242 forces to equal ar_documents.total_amount for every POS
 * sale, so beside invoice_total it would be a duplicate column wearing a
 * different name. What is left is a row that foots on its own —
 * net_ex_vat + vat_amount = invoice_total — with the discount shown beside it
 * as the tax-inclusive figure it is.
 */
const DAILY_METRICS = [
  "orders",
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
//
// BASIS IN THE FILE: the export never passes through the api.ts tax swap, so a
// `net_ex_vat` column in a file exported with the incl-VAT chip on would have
// been ex-VAT while the screen showed incl-VAT, with nothing in the file to say
// which. Both bases are therefore exported as separate columns, and each column
// header is the metric's own label — which now names its basis
// ("Net sales, ex. VAT (after discount)" / "Net sales (incl. VAT)"), so the
// spreadsheet is self-describing however it is later filtered or pasted.
setPageExportRequest(SEGMENT, (filters) => {
  const dim = filters.businessDay ? "business_day" : "calendar_day";
  return {
    metrics: [...DAILY_METRICS, "net_incl_vat"],
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
function Figure({ children, strong, muted }: { children: ReactNode; strong?: boolean; muted?: boolean }) {
  const tone = muted
    ? "font-bold text-slate-400"
    : strong
      ? "font-extrabold text-slate-900"
      : "font-bold text-slate-700";
  return (
    <span dir="ltr" className={`block text-end tabular-nums ${tone}`}>
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
  /**
   * A figure shown FOR REFERENCE that takes no part in the arithmetic above
   * it — a different tax basis, or money that never entered the invoice
   * (fees / the rounding column). Rendered muted, with no operator, so a memo
   * can never be misread as a ladder step. `data-memo` marks it for the
   * harness too, because "it has no minus sign" is not something a test can see.
   */
  memo?: boolean;
  /** Sub-label under a memo line — e.g. "control line: must read zero". */
  note?: string;
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
            data-memo={line.memo ? "true" : undefined}
            className={
              line.memo
                ? "border-b border-dashed border-slate-100"
                : line.op === "eq"
                  ? "border-y border-slate-200 bg-slate-50"
                  : "border-b border-slate-50"
            }
          >
            <th
              scope="row"
              className={`px-4 py-2.5 text-start font-bold ${line.memo ? "text-slate-500" : "text-slate-600"}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {!line.memo && line.op === "sub" && <span aria-hidden="true" className="text-slate-400">−</span>}
                {!line.memo && line.op === "add" && <span aria-hidden="true" className="text-slate-400">+</span>}
                {!line.memo && line.op === "eq" && <span aria-hidden="true" className="text-slate-400">=</span>}
                <span className={line.strong ? "font-extrabold text-slate-900" : undefined}>{line.label}</span>
                {line.explain}
              </span>
              {line.note && <span className="mt-0.5 block text-[11px] font-medium text-slate-400">{line.note}</span>}
            </th>
            <td className="w-40 px-4 py-2.5">
              <Figure strong={line.strong} muted={line.memo}>
                {money(line.value)}
              </Figure>
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

  // taxMode is pinned to "excl" for EVERY request on this page, deliberately.
  //
  // api.ts::metricSwapFor rewrites a requested `net_ex_vat` to `net_incl_vat`
  // whenever the tax chip says "incl" and maps the answer back under the
  // net_ex_vat key — so the SAME slot silently changes basis while its label,
  // and every figure standing next to it, does not. On a statement that is
  // fatal: net_ex_vat + vat_amount would then count the VAT twice, and the
  // taxable base of the VAT section would stop being a taxable base at all.
  // This report does not need the swap: it requests BOTH bases as real
  // registry metrics and renders the ladder the reader asked for, so the
  // switch changes which statement is shown, never what a line means.
  const base = { ...buildFiltersBody(filters), taxMode: "excl" as const };
  const compare = compareSpec(filters);
  const dayDim = filters.businessDay ? "business_day" : "calendar_day";
  /** Which ladder the reader asked for. Named on screen, in print and in the export. */
  const inclBasis = filters.taxIncl;

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
  const summaryBodyC: AnalyticsQueryBody = {
    ...base,
    metrics: [...SUMMARY_METRICS_C],
    dimensions: [],
    ...(compare ? { compare } : {}),
  };
  const byDayBody: AnalyticsQueryBody = {
    ...base,
    metrics: [...DAILY_METRICS],
    dimensions: [dayDim],
    sort: [{ by: dayDim, dir: "asc" }],
    // The daily detail sits directly under a statement that totals the WHOLE
    // period, so the rows must be able to foot to it. Without an explicit limit
    // the planner capped them at 50 (planner.js:58) while a range may legally
    // run to 400 days — the reader saw 50 rows under a 90-day total and no
    // explanation for the gap. 500 is the planner's own MAX_LIMIT.
    limit: 500,
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
  const summaryC = useAnalyticsQuery(SEGMENT, summaryBodyC, { enabled: catalogReady });
  const byDay = useAnalyticsQuery(SEGMENT, byDayBody, { enabled: catalogReady });
  const byTax = useAnalyticsQuery(SEGMENT, byTaxBody, { enabled: catalogReady });
  const byPayment = useAnalyticsQuery(SEGMENT, byPaymentBody, { enabled: catalogReady });

  const hasCompare = filters.compare !== "none";
  const rowA = summaryA.data?.rows[0];
  const rowB = summaryB.data?.rows[0];
  const rowC = summaryC.data?.rows[0];
  /** Which of the three summary requests carries a given figure. */
  const sourceOf = (id: string) =>
    IN_GROUP_A.has(id)
      ? { result: summaryA.data, row: rowA }
      : IN_GROUP_B.has(id)
        ? { result: summaryB.data, row: rowB }
        : { result: summaryC.data, row: rowC };
  const f = (id: string) => {
    const s = sourceOf(id);
    return pick(s.result, s.row, id);
  };
  const c = (id: string): number | null => {
    if (!hasCompare) return null;
    const v = sourceOf(id).row?.compare?.[id];
    return typeof v === "number" ? v : null;
  };

  const dayRows = useMemo<DayRow[]>(
    () =>
      (byDay.data?.rows ?? []).map((r) => ({
        day: String(r.keys[0] ?? ""),
        label: r.labels[0] ?? String(r.keys[0] ?? ""),
        orders: displayMetric(r, "orders"),
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
      { id: "discounts", header: t("salesReports.metrics.discounts_total"), accessor: (r) => r.discounts, cell: (r) => money(r.discounts), numeric: true, sortable: true },
      { id: "net", header: t("salesReports.metrics.net_ex_vat"), accessor: (r) => r.net, cell: (r) => money(r.net), numeric: true, sortable: true },
      { id: "vat", header: t("salesReports.metrics.vat_amount"), accessor: (r) => r.vat, cell: (r) => money(r.vat), numeric: true, sortable: true },
      { id: "total", header: t("salesReports.metrics.invoice_total"), accessor: (r) => r.total, cell: (r) => money(r.total), numeric: true, sortable: true },
      { id: "avgTicket", header: t("salesReports.metrics.avg_ticket"), accessor: (r) => r.avgTicket, cell: (r) => money(r.avgTicket), numeric: true, sortable: true },
    ],
    [t, dayDim],
  );

  const isLoading =
    registry.isLoading || summaryA.isLoading || summaryB.isLoading || summaryC.isLoading ||
    byDay.isLoading || byTax.isLoading || byPayment.isLoading;
  const error =
    registry.error ?? summaryA.error ?? summaryB.error ?? summaryC.error ??
    byDay.error ?? byTax.error ?? byPayment.error;

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
          void summaryC.refetch();
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
  const invoicedInclVat = f("gross_product_sales");
  const voidsValue = f("voids_value");
  const returnsValue = f("returns_value");
  // voids_value is Σ doc.total_amount of the voided orders and returns_value is
  // Σ rl.gross_amount — BOTH tax-inclusive. Dividing them by net_ex_vat, as this
  // page did, measured incl-VAT numerators against an ex-VAT base and overstated
  // every share by the VAT rate. The denominator is the incl-VAT invoiced amount.
  const share = (part: number | null): number | null =>
    part == null || invoicedInclVat == null || invoicedInclVat === 0
      ? null
      : (part / invoicedInclVat) * 100;

  /*
   * THE SALES STATEMENT — one tax basis per ladder, and every "=" line is the
   * exact arithmetic result of the lines above it.
   *
   * Why there are two ladders rather than one. The operands are not all
   * expressible on both bases:
   *   • d.gross_amount, doc.total_amount and rl.gross_amount are recorded
   *     TAX-INCLUSIVE,
   *   • d.net_amount and rl.net_amount are recorded EX-VAT,
   *   • f.discount_total is recorded ONLY tax-inclusive. routes/sales.js:720-742
   *     applies the discount in gross space and scales net and VAT together by
   *     the resulting ratio; the ex-VAT half of a discount is therefore never
   *     written anywhere. On a mixed cart (a standard-rated dish and a
   *     zero-rated bottle of water on the same bill) it cannot even be
   *     recovered by dividing by 1 + rate, because the two lines carry
   *     different rates and the split between them is gone.
   * So: the ex-VAT ladder starts at net_ex_vat, which is ALREADY net of every
   * discount, and shows the discount as a memo figure on its own stated basis
   * rather than pretending to subtract it. The tax-inclusive ladder can show
   * the discount as a real step, because there it shares a basis with the line
   * above it.
   *
   * Every value below is computed server-side in integer halalas
   * (lib/analytics/equations.js) — nothing on this page does money arithmetic.
   */
  const statementLines: StatementLine[] = inclBasis
    ? [
        // NOT sales_before_discount. That figure is RECONSTRUCTED as
        // gross + discount (metrics.js salesBeforeDiscount), so a ladder that
        // opened on it and then subtracted the same discount closed by
        // construction — it would foot perfectly with a WRONG discount, which
        // is a proof of nothing. The ladder now opens on an independently
        // summed figure and the discount is a memo on both bases, exactly as
        // the ex-VAT ladder already treats it.
        // …so this line is exactly the two above it, by construction.
        { id: "net", label: t("salesReports.metrics.gross_product_sales"), value: invoicedInclVat, compare: c("gross_product_sales"), op: "eq", strong: true, explain: metricExplain(t, registry.data, "gross_product_sales") },
        { id: "returns", label: t("salesReports.metrics.returns_value"), value: returnsValue, compare: c("returns_value"), op: "sub" },
        // net_product_sales = gross_product_sales − returns_value
        { id: "net_sales", label: t("salesReports.metrics.net_product_sales"), value: f("net_product_sales"), compare: c("net_product_sales"), op: "eq", strong: true, explain: metricExplain(t, registry.data, "net_product_sales") },
      ]
    : [
        { id: "net", label: t("salesReports.metrics.net_ex_vat"), value: netExVat, compare: c("net_ex_vat"), explain: metricExplain(t, registry.data, "net_ex_vat") },
        { id: "returns", label: t("salesReports.metrics.returns_net"), value: f("returns_net"), compare: c("returns_net"), op: "sub" },
        // net_product_sales_ex_vat = net_ex_vat − returns_net
        { id: "net_sales", label: t("salesReports.metrics.net_product_sales_ex_vat"), value: f("net_product_sales_ex_vat"), compare: c("net_product_sales_ex_vat"), op: "eq", strong: true, explain: metricExplain(t, registry.data, "net_product_sales_ex_vat") },
      ];

  /*
   * MEMO — figures the reader needs but the ladder above may not add.
   *
   * Each one is here for a stated reason, not for symmetry:
   *   • the discount (ex-VAT ladder only) — recorded tax-inclusive, already out
   *     of every line above,
   *   • VAT on sales and VAT on returns — the two stored columns that bridge
   *     the ex-VAT bottom line to the tax-inclusive one and back,
   *   • the other basis's bottom line, so the two statements can be checked
   *     against each other without flipping the chip,
   *   • the invoice headers and the headers-vs-lines control, which reads 0.00
   *     for every sale the line projection wrote (lineAllocation.js:242) and
   *     goes non-zero only for a header with no lines,
   *   • fees and rounding, which are NOT inside the invoice total: fees is
   *     sales.kita_service_fee, persisted beside total_final and never in it,
   *     and rounding_amount is written as a literal 0. The old ladder added
   *     both to reach invoice_total, overstating it by exactly their sum.
   */
  const memoLines: StatementLine[] = [
    // The discount is a MEMO on BOTH bases now. On the ex-VAT ladder it always
    // was (it is recorded incl-VAT and is already out of net_ex_vat). On the
    // incl-VAT ladder it used to be a real step under a reconstructed opening
    // line — gross + discount, then minus discount — which closed by
    // construction and could not detect a wrong discount. Same treatment on
    // both: shown, never pretended to be an operand.
    { id: "memo_discounts", label: t("salesReports.metrics.discounts_total"), value: f("discounts_total"), compare: c("discounts_total"), memo: true },
    { id: "memo_vat", label: t("salesReports.metrics.vat_amount"), value: f("vat_amount"), compare: c("vat_amount"), memo: true },
    { id: "memo_returns_vat", label: t("salesReports.metrics.returns_vat"), value: f("returns_vat"), compare: c("returns_vat"), memo: true },
    inclBasis
      ? { id: "memo_other_basis", label: t("salesReports.metrics.net_product_sales_ex_vat"), value: f("net_product_sales_ex_vat"), compare: c("net_product_sales_ex_vat"), memo: true }
      : { id: "memo_other_basis", label: t("salesReports.metrics.gross_product_sales"), value: invoicedInclVat, compare: c("gross_product_sales"), memo: true },
    { id: "memo_invoice_total", label: t("salesReports.metrics.invoice_total"), value: invoiceTotal, compare: c("invoice_total"), memo: true, explain: metricExplain(t, registry.data, "invoice_total") },
    { id: "memo_variance", label: t("salesReports.metrics.statement_variance"), value: f("statement_variance"), compare: c("statement_variance"), memo: true, note: t("salesReports.report.memoControl"), explain: metricExplain(t, registry.data, "statement_variance") },
    { id: "memo_fees", label: t("salesReports.metrics.fees_total"), value: f("fees_total"), compare: c("fees_total"), memo: true },
    { id: "memo_rounding", label: t("salesReports.metrics.rounding_total"), value: f("rounding_total"), compare: c("rounding_total"), memo: true },
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
          // The basis is not decoration: the same figure means two different
          // things under it, so it is stated ON the statement — not only on the
          // page header chip — and it prints, because nothing here is
          // print:hidden.
          action={
            <Badge tone="info">
              {inclBasis ? t("salesReports.report.basisIncl") : t("salesReports.report.basisExcl")}
            </Badge>
          }
        >
          <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500">
            {inclBasis ? t("salesReports.report.basisNoteIncl") : t("salesReports.report.basisNoteExcl")}
          </p>
          <Statement
            lines={statementLines}
            showCompare={hasCompare}
            compareLabel={t("salesReports.topbar.compare")}
          />
          <p className="border-y border-slate-100 bg-slate-50 px-4 py-2 text-xs font-extrabold text-slate-600">
            {t("salesReports.report.memoTitle")}
            <span className="ms-2 font-medium text-slate-500">{t("salesReports.report.memoNote")}</span>
          </p>
          <Statement
            lines={memoLines}
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
