// Sales Analytics Hub — "executive": the administrative sales report.
//
// This screen is a DECISION WORKSPACE followed by its formal verification
// layer. Managers first see the period pulse, exceptions and ranked drivers;
// accountants can then read/print the stepped statement, VAT, collections,
// returns, profit and day detail from the same trusted responses.
//
// Deliberately CHART-FREE: ranked evidence and direct drills answer a decision
// faster than decorative plots, while the detailed statement remains printable.
import { useMemo, type ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  CircleAlert,
  Clock3,
  CreditCard,
  Gauge,
  PackageSearch,
  ReceiptText,
  ShoppingBag,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import {
  Badge,
  EmptyState,
  ErrorState,
  ExplainNumber,
  LoadingState,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { useCan } from "@/shared/permissions";
import { computeCompareRange } from "@/shared/ui/date-range-picker";
import { cn, formatCurrency, formatDateTime, formatNumber } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import { analyticsFilterCodec, type AnalyticsFilters } from "../lib/filters";
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
import { useAnalyticsQuery, useAnalyticsRegistry } from "../lib/useAnalyticsQuery";
import { REPORT_BY_ID, reportQuery } from "../lib/reportRegistry";
import { ExecutiveDrivers } from "../components/ExecutiveDrivers";

const SEGMENT = "executive";

/**
 * The formal statement needs FIVE requests. The decision workspace adds ONE
 * active driver request (never five dimensions in parallel), for six total.
 *
 * lib/analytics/planner.js caps a request at MAX_METRICS = 12 and answers
 * VALIDATION_ERROR / 422 above it. The report needs 30 figures, so a single
 * query would make EVERY load of this page 422 — an ErrorState with no data at
 * all. The requests are:
 *
 *   1  `statement`      dimensionless, 12 metrics — every operand of both
 *                       ladders, so the arithmetic on screen comes out of ONE
 *                       response and cannot be assembled from two snapshots of
 *                       the window taken a moment apart.
 *   2  `voidsAndProfit` dimensionless — the void metrics MUST ride alone (see
 *                       below), and they carry the five cost-gated metrics
 *                       BESIDE net_collections, which is ungated: a viewer
 *                       without analytics.cost.view then gets them masked out
 *                       of a still-valid response, where a request of only cost
 *                       metrics would be refused whole with 403
 *                       ANALYTICS_ALL_MASKED and break the page for managers.
 *   3  `daily`          grouped by day — the detail table AND, off its totals,
 *                       the six operational counters.
 *   4  `byTax`          grouped by vat_category.
 *   5  `byPayment`      grouped by payment_method — the collections table AND,
 *                       off its totals, payments_in / refunds_out.
 *
 * 3, 4 and 5 group by three DIFFERENT dimensions, so they cannot be one
 * request: the planner emits one GROUP BY per request. That is the floor.
 */
// The groups live in lib/reportRegistry as `statement` / `voidsAndProfit` /
// `daily` / `byTax` / `byPayment`; they are read back here so the statement
// layout and the request can never name different metrics.
//
// WHY THE VOID GROUP IS SEPARATE — the reason is recorded here because this is
// where the layout that depends on it lives:
//
//   • the planner caps a request at 12 metrics (MAX_METRICS);
//   • VOID METRICS LIVE ALONE WITH NON-ORDER METRICS — never beside orders /
//     avg_ticket / guests / fees. planner.js:356 computes the void filter PER
//     FACT STATEMENT: if ANY metric on the order fact mentions 'voided', the
//     exclusion is dropped for EVERY metric on that fact. Put voids_count
//     beside orders and the order count silently starts including voided
//     orders — and avg_ticket becomes a ratio of a void-excluded numerator
//     over a void-included denominator. Group C carries no other
//     order-population metric, so the un-exclusion reaches nothing else.
const EXEC_REPORT = REPORT_BY_ID[SEGMENT];
const SUMMARY_METRICS_A: readonly string[] = reportQuery(EXEC_REPORT, "statement")!.metrics;
const IN_GROUP_A: ReadonlySet<string> = new Set<string>(SUMMARY_METRICS_A);

/**
 * FIVE STATEMENT REQUESTS + ONE ACTIVE DRIVER — where each figure comes from.
 *
 * The operational counters (qty, items per order, guests, fees, rounding,
 * returns count) used to be their OWN dimensionless request whose only output
 * was a grand total. Every grouped request already computes its grand total
 * server-side, so they ride on the DAILY request and are read off its `totals`;
 * `payments_in` / `refunds_out` likewise come off the COLLECTIONS request's
 * totals. Nothing is recomputed in the browser — both are the server's own
 * period aggregate over the same population and the same WHERE clause, from a
 * totals statement that carries no LIMIT.
 *
 * __tests__/executiveRequests.test.tsx counts the requests this page issues and
 * pins the full figure list, so a "simplification" that adds a sixth request
 * back — or that meets the count by dropping a line — fails.
 */
const FROM_DAILY_TOTALS: ReadonlySet<string> = new Set<string>(
  reportQuery(EXEC_REPORT, "daily")!.metrics,
);
const FROM_PAYMENT_TOTALS: ReadonlySet<string> = new Set<string>(
  reportQuery(EXEC_REPORT, "byPayment")!.metrics,
);

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
// `columns`, not `metrics`: the daily REQUEST also carries the six period-only
// counters (see FROM_DAILY_TOTALS), and the table — and the file — show the six
// day columns. Exporting all twelve plus net_incl_vat would be thirteen
// metrics, one past the planner's ceiling, and the export job would 422.
const DAILY_METRICS: readonly string[] = reportQuery(EXEC_REPORT, "daily")!.columns!;

// THE ONE PAGE THAT STILL REGISTERS ITS OWN EXPORT SHAPE, and why.
//
// The registry's `daily` query is the SCREEN's column set. The file adds one
// column the screen does not have: the export never passes through the api.ts
// tax swap, so a `net_ex_vat` column in a file exported with the incl-VAT chip
// on would be ex-VAT while the screen showed incl-VAT, with nothing in the file
// to say which. Both bases are therefore exported as separate columns, and each
// header is the metric's own label — which names its basis ("Net sales, ex. VAT
// (after discount)" / "Net sales (incl. VAT)") — so the spreadsheet is
// self-describing however it is later filtered or pasted. The grouping and the
// sort still follow the registry, resolved against the date basis.
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
interface DecisionKpi {
  id: string;
  label: string;
  value: string;
  delta: number | null;
  to: string;
  icon: LucideIcon;
  supporting?: string;
  secondaryLabel?: string;
  secondaryValue?: string;
}

function DeltaPill({ value, enabled, label }: { value: number | null; enabled: boolean; label: string }) {
  if (!enabled) {
    return <span className="text-[11px] font-bold text-slate-400">{label}</span>;
  }
  if (value == null) return <span className="text-[11px] font-bold text-slate-400">—</span>;
  const rising = value > 0;
  const falling = value < 0;
  const Icon = rising ? ArrowUpRight : falling ? ArrowDownRight : Gauge;
  return (
    <span
      dir="ltr"
      className={cn(
        "inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-[11px] font-extrabold tabular-nums",
        rising && "bg-emerald-50 text-emerald-700",
        falling && "bg-rose-50 text-rose-700",
        !rising && !falling && "bg-slate-100 text-slate-600",
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {value > 0 ? "+" : ""}{formatNumber(value)}%
    </span>
  );
}

function DecisionKpis({ items, compareEnabled, compareOffLabel }: {
  items: DecisionKpi[];
  compareEnabled: boolean;
  compareOffLabel: string;
}) {
  return (
    <div
      data-testid="kpi-row"
      className={cn(
        "grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0",
        items.length >= 5 ? "2xl:grid-cols-5" : "xl:grid-cols-4",
      )}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.id}
            to={item.to}
            data-kpi-id={item.id}
            className="group min-w-0 border-slate-100 p-4 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-teal-100 sm:border-e"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700 transition-colors group-hover:bg-teal-100">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <DeltaPill value={item.delta} enabled={compareEnabled} label={compareOffLabel} />
            </div>
            <dl className="mt-3">
              <dt className="min-h-10 text-xs font-bold leading-5 text-slate-500">{item.label}</dt>
              <dd dir="ltr" className="mt-1 text-end text-xl font-black tabular-nums text-slate-950">
                {item.value}
              </dd>
              {item.supporting && (
                <dd className="mt-1 truncate text-[11px] font-bold text-slate-400">{item.supporting}</dd>
              )}
            </dl>
            {item.secondaryLabel && (
              <dl className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[11px] font-bold text-slate-400">
                <dt className="truncate">{item.secondaryLabel}</dt>
                <dd dir="ltr" className="shrink-0 tabular-nums">{item.secondaryValue ?? "—"}</dd>
              </dl>
            )}
          </Link>
        );
      })}
    </div>
  );
}

interface DecisionSignal {
  id: string;
  title: string;
  body: string;
  value?: string;
  to?: string;
  tone: "critical" | "warning";
}

function DecisionSignals({ signals, title, subtitle, clearTitle, clearBody, openLabel }: {
  signals: DecisionSignal[];
  title: string;
  subtitle: string;
  clearTitle: string;
  clearBody: string;
  openLabel: string;
}) {
  return (
    <section className="surface overflow-hidden" data-testid="decision-signals">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-extrabold text-slate-950">{title}</h3>
        <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">{subtitle}</p>
      </header>
      {signals.length === 0 ? (
        <div className="flex items-start gap-3 px-4 py-5" data-signal-state="clear">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-extrabold text-slate-900">{clearTitle}</p>
            <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{clearBody}</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {signals.map((signal) => {
            const content = (
              <>
                <span
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
                    signal.tone === "critical"
                      ? "bg-rose-50 text-rose-700"
                      : "bg-amber-50 text-amber-700",
                  )}
                >
                  <CircleAlert className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-extrabold text-slate-900">{signal.title}</span>
                    {signal.value && (
                      <span dir="ltr" className="text-xs font-black tabular-nums text-slate-700">{signal.value}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs font-medium leading-5 text-slate-500">{signal.body}</span>
                  {signal.to && <span className="mt-1 block text-[11px] font-extrabold text-teal-700">{openLabel}</span>}
                </span>
              </>
            );
            return (
              <li key={signal.id} data-signal-id={signal.id}>
                {signal.to ? (
                  <Link
                    to={signal.to}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-teal-100"
                  >
                    {content}
                  </Link>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-3">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface DayInsight {
  id: string;
  title: string;
  day: string;
  label: string;
  value: string;
}

function PeriodPulse({ insights, title, subtitle, openLabel, onOpen }: {
  insights: DayInsight[];
  title: string;
  subtitle: string;
  openLabel: string;
  onOpen: (day: string) => void;
}) {
  return (
    <section className="surface overflow-hidden" data-testid="period-pulse">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-extrabold text-slate-950">{title}</h3>
        <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">{subtitle}</p>
      </header>
      <div className="grid sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {insights.map((insight) => (
          <button
            key={insight.id}
            type="button"
            data-insight-id={insight.id}
            onClick={() => onOpen(insight.day)}
            className="min-w-0 border-b border-e border-slate-100 px-4 py-3 text-start transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-teal-100"
          >
            <span className="block text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{insight.title}</span>
            <span className="mt-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-extrabold text-slate-900">{insight.label}</span>
              <span dir="ltr" className="shrink-0 text-sm font-black tabular-nums text-slate-950">{insight.value}</span>
            </span>
            <span className="mt-1 block text-[11px] font-extrabold text-teal-700">{openLabel}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DecisionShortcut({
  to,
  icon: Icon,
  label,
  description,
  step,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  description: string;
  step: number;
}) {
  return (
    <Link
      to={to}
      className="group relative flex min-h-20 min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white px-3 py-3 text-start transition hover:-translate-y-0.5 hover:border-teal-300 hover:bg-teal-50 hover:shadow-soft focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-teal-50 text-teal-700 transition group-hover:bg-white">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-extrabold text-slate-900">{label}</span>
        <span className="mt-0.5 block text-[11px] font-medium leading-4 text-slate-500">{description}</span>
      </span>
      <span dir="ltr" className="absolute end-2 top-1 text-[10px] font-black tabular-nums text-slate-200">0{step}</span>
    </Link>
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
  const { search } = useLocation();
  const canViewCashierPerformance = useCan("analytics.employees.view");
  const canViewCost = useCan("analytics.cost.view");
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
    ...reportQuerySpec(SEGMENT, "statement", filters),
    ...(compare ? { compare } : {}),
  };
  const summaryBodyC: AnalyticsQueryBody = {
    ...base,
    ...reportQuerySpec(SEGMENT, "voidsAndProfit", filters),
    ...(compare ? { compare } : {}),
  };
  const byDayBody: AnalyticsQueryBody = {
    ...base,
    // Carries the six DAILY COLUMNS plus the six period-only counters — see
    // FROM_DAILY_TOTALS above; `compare` so the counters keep their
    // vs-previous-period figures.
    ...(compare ? { compare } : {}),
    // The registry's `daily` query carries the explicit row limit — see the
    // note there: without it the planner caps at DEFAULT_LIMIT = 50 and the
    // detail under a 90-day total shows fifty rows.
    ...reportQuerySpec(SEGMENT, "daily", filters),
    sort: [{ by: dayDim, dir: "asc" }],
  };
  const byTaxBody: AnalyticsQueryBody = {
    ...base,
    ...reportQuerySpec(SEGMENT, "byTax", filters),
  };
  const byPaymentBody: AnalyticsQueryBody = {
    ...base,
    ...reportQuerySpec(SEGMENT, "byPayment", filters),
    sort: [{ by: "payments_in", dir: "desc" }],
    // The collections panel's own period figures come off THIS request's
    // totals (see FROM_PAYMENT_TOTALS), so it needs the comparison window too.
    ...(compare ? { compare } : {}),
  };

  const catalogReady = registry.data != null && Array.isArray(registry.data.metrics);
  const summaryA = useAnalyticsQuery(SEGMENT, summaryBodyA, { enabled: catalogReady });
  const summaryC = useAnalyticsQuery(SEGMENT, summaryBodyC, { enabled: catalogReady });
  const byDay = useAnalyticsQuery(SEGMENT, byDayBody, { enabled: catalogReady });
  const byTax = useAnalyticsQuery(SEGMENT, byTaxBody, { enabled: catalogReady });
  const byPayment = useAnalyticsQuery(SEGMENT, byPaymentBody, { enabled: catalogReady });

  const hasCompare = filters.compare !== "none";
  const rowA = summaryA.data?.rows[0];
  const rowC = summaryC.data?.rows[0];

  /**
   * Which request carries a given figure, and whether it is a ROW value (a
   * dimensionless request answers one row) or a period TOTAL (a grouped request
   * answers many rows plus the server's own grand total).
   */
  const sourceOf = (id: string) => {
    if (IN_GROUP_A.has(id)) return { result: summaryA.data, row: rowA, fromTotals: false };
    if (FROM_DAILY_TOTALS.has(id)) return { result: byDay.data, row: undefined, fromTotals: true };
    if (FROM_PAYMENT_TOTALS.has(id)) return { result: byPayment.data, row: undefined, fromTotals: true };
    return { result: summaryC.data, row: rowC, fromTotals: false };
  };
  const f = (id: string) => {
    const s = sourceOf(id);
    if (!s.fromTotals) return pick(s.result, s.row, id);
    if (!s.result || s.result.meta.maskedMetrics.includes(id)) return null;
    const v = s.result.totals?.[id];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const c = (id: string): number | null => {
    if (!hasCompare) return null;
    const s = sourceOf(id);
    const v = s.fromTotals ? s.result?.totalsCompare?.[id] : s.row?.compare?.[id];
    return typeof v === "number" ? v : null;
  };
  // The server calculates comparison percentages over its own exact fact
  // population. Never re-derive them from rounded display figures here.
  const d = (id: string): number | null => {
    if (!hasCompare) return null;
    const s = sourceOf(id);
    const v = s.fromTotals ? s.result?.totalsDelta?.[id] : s.row?.delta?.[id];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
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
        pinStart: true, hideable: false,
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
    registry.isLoading || summaryA.isLoading || summaryC.isLoading ||
    byDay.isLoading || byTax.isLoading || byPayment.isLoading;
  const error =
    registry.error ?? summaryA.error ?? summaryC.error ??
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
        // NO `op` on the opening line. It carries no "=" because there is
        // nothing above it to equal: it is the period's independently summed
        // invoiced total, the ladder's starting point. It briefly rendered with
        // op:"eq" — a leading "=" with no operands above it, styled exactly
        // like the genuine subtotal at the foot — which invites a reader
        // following the section note ("every '=' line is the exact result of
        // the lines above it") to hunt for operands that do not exist.
        { id: "net", label: t("salesReports.metrics.gross_product_sales"), value: invoicedInclVat, compare: c("gross_product_sales"), strong: true, explain: metricExplain(t, registry.data, "gross_product_sales") },
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

  const cogsAfterReturns = f("cogs_after_returns");
  const grossProfitAfterReturns = f("gross_profit_after_returns");
  // A zero cost is not evidence that an item was free. These exposure metrics
  // identify revenue whose cost provenance is missing. Publishing a margin
  // over that population would be precise-looking but unauditable, so the
  // affected side of the comparison is withheld explicitly.
  const periodHasUncosted =
    (f("uncosted_net") ?? 0) >= MONEY_EPSILON ||
    (f("uncosted_returns_net") ?? 0) >= MONEY_EPSILON;
  const compareHasUncosted =
    hasCompare &&
    ((c("uncosted_net") ?? 0) >= MONEY_EPSILON ||
      (c("uncosted_returns_net") ?? 0) >= MONEY_EPSILON);
  const showProfit =
    canViewCost &&
    (periodHasUncosted || compareHasUncosted || cogsAfterReturns != null || grossProfitAfterReturns != null);
  const trustedCogsAfterReturns = periodHasUncosted ? null : cogsAfterReturns;
  const trustedGrossProfitAfterReturns = periodHasUncosted ? null : grossProfitAfterReturns;
  const trustedMarginAfterReturns = periodHasUncosted ? null : f("margin_pct_after_returns");
  const trustedCompare = (id: string) => (compareHasUncosted ? null : c(id));
  const freshness = summaryA.data?.meta.freshness;

  const decisionHref = (center: string, view: string) => {
    const params = new URLSearchParams(search);
    params.set("view", view);
    return `/reports/sales/${center}?${params.toString()}`;
  };
  const decisionShortcuts: Array<{
    id: string;
    center: string;
    view: string;
    icon: LucideIcon;
  }> = [
    { id: "items", center: "items", view: "items", icon: PackageSearch },
    { id: "branches", center: "operations", view: "branches", icon: Building2 },
    { id: "hours", center: "operations", view: "hours", icon: Clock3 },
    { id: "cashiers", center: "operations", view: "cashiers", icon: UserRound },
    { id: "payments", center: "payments", view: "payments", icon: CreditCard },
  ].filter((shortcut) => shortcut.id !== "cashiers" || canViewCashierPerformance);

  const headlineMetricId = inclBasis ? "net_product_sales" : "net_product_sales_ex_vat";
  const decisionKpis: DecisionKpi[] = [
    {
      id: "net_sales",
      label: inclBasis
        ? t("salesReports.metrics.net_product_sales")
        : t("salesReports.metrics.net_product_sales_ex_vat"),
      value: money(inclBasis ? f("net_product_sales") : f("net_product_sales_ex_vat")),
      delta: d(headlineMetricId),
      to: decisionHref("operations", "branches"),
      icon: Building2,
    },
    {
      id: "orders",
      label: t("salesReports.metrics.orders"),
      value: count(f("orders")),
      delta: d("orders"),
      to: decisionHref("operations", "orders"),
      icon: ShoppingBag,
    },
    {
      id: "avg_ticket",
      label: t("salesReports.metrics.avg_ticket"),
      value: money(f("avg_ticket")),
      delta: d("avg_ticket"),
      to: decisionHref("operations", "hours"),
      icon: ReceiptText,
      supporting: t("salesReports.command.exVatBasis"),
    },
    {
      id: "net_collections",
      label: t("salesReports.metrics.net_collections"),
      value: money(netCollections),
      delta: d("net_collections"),
      to: decisionHref("payments", "payments"),
      icon: CreditCard,
    },
    ...(canViewCost
      ? [
          {
            id: "gross_profit_after_returns",
            label: t("salesReports.metrics.gross_profit_after_returns"),
            value: money(trustedGrossProfitAfterReturns),
            delta: compareHasUncosted ? null : d("gross_profit_after_returns"),
            to: decisionHref("items", "profitability"),
            icon: Gauge,
            secondaryLabel: t("salesReports.metrics.margin_pct_after_returns"),
            secondaryValue: percent(trustedMarginAfterReturns),
          },
        ]
      : []),
  ];

  const statementVariance = f("statement_variance");
  const uncostedExposure = (f("uncosted_net") ?? 0) + (f("uncosted_returns_net") ?? 0);
  const signals: DecisionSignal[] = [];
  if (statementVariance != null && Math.abs(statementVariance) >= MONEY_EPSILON) {
    signals.push({
      id: "statement-variance",
      title: t("salesReports.command.signals.statementVariance.title"),
      body: t("salesReports.command.signals.statementVariance.body"),
      value: money(statementVariance),
      to: decisionHref("operations", "orders"),
      tone: "critical",
    });
  }
  if (settlementDiff != null && Math.abs(settlementDiff) >= MONEY_EPSILON) {
    signals.push({
      id: "settlement-difference",
      title: t("salesReports.command.signals.settlement.title"),
      body: t("salesReports.command.signals.settlement.body"),
      value: money(settlementDiff),
      to: decisionHref("payments", "reconciliation"),
      tone: "critical",
    });
  }
  if (canViewCost && uncostedExposure >= MONEY_EPSILON) {
    signals.push({
      id: "uncosted-sales",
      title: t("salesReports.command.signals.uncosted.title"),
      body: t("salesReports.command.signals.uncosted.body"),
      value: money(uncostedExposure),
      to: decisionHref("items", "profitability"),
      tone: "warning",
    });
  }
  if ((freshness?.pendingDays ?? 0) > 0) {
    signals.push({
      id: "pending-days",
      title: t("salesReports.command.signals.pending.title"),
      body: t("salesReports.command.signals.pending.body"),
      value: count(freshness?.pendingDays ?? 0),
      tone: "warning",
    });
  }
  if ((d(headlineMetricId) ?? 0) < 0) {
    signals.push({
      id: "sales-decline",
      title: t("salesReports.command.signals.salesDecline.title"),
      body: t("salesReports.command.signals.salesDecline.body"),
      value: percent(d(headlineMetricId)),
      to: decisionHref("operations", "branches"),
      tone: "warning",
    });
  }
  if ((d("orders") ?? 0) < 0) {
    signals.push({
      id: "orders-decline",
      title: t("salesReports.command.signals.ordersDecline.title"),
      body: t("salesReports.command.signals.ordersDecline.body"),
      value: percent(d("orders")),
      to: decisionHref("operations", "hours"),
      tone: "warning",
    });
  }

  const rowsWithNet = dayRows.filter((row) => row.net != null);
  const rowsWithOrders = dayRows.filter((row) => row.orders != null);
  const rowsWithTicket = dayRows.filter((row) => row.avgTicket != null);
  const bestNet = rowsWithNet.reduce<DayRow | null>(
    (best, row) => (best == null || (row.net ?? -Infinity) > (best.net ?? -Infinity) ? row : best),
    null,
  );
  const weakestNet = rowsWithNet.reduce<DayRow | null>(
    (weakest, row) => (weakest == null || (row.net ?? Infinity) < (weakest.net ?? Infinity) ? row : weakest),
    null,
  );
  const busiest = rowsWithOrders.reduce<DayRow | null>(
    (best, row) => (best == null || (row.orders ?? -Infinity) > (best.orders ?? -Infinity) ? row : best),
    null,
  );
  const highestTicket = rowsWithTicket.reduce<DayRow | null>(
    (best, row) => (best == null || (row.avgTicket ?? -Infinity) > (best.avgTicket ?? -Infinity) ? row : best),
    null,
  );
  const periodInsights: DayInsight[] = [
    bestNet && {
      id: "best-sales-day",
      title: t("salesReports.command.pulse.bestSales"),
      day: bestNet.day,
      label: bestNet.label,
      value: money(bestNet.net),
    },
    weakestNet && {
      id: "weakest-sales-day",
      title: t("salesReports.command.pulse.weakestSales"),
      day: weakestNet.day,
      label: weakestNet.label,
      value: money(weakestNet.net),
    },
    busiest && {
      id: "busiest-day",
      title: t("salesReports.command.pulse.busiest"),
      day: busiest.day,
      label: busiest.label,
      value: count(busiest.orders),
    },
    highestTicket && {
      id: "highest-ticket-day",
      title: t("salesReports.command.pulse.highestTicket"),
      day: highestTicket.day,
      label: highestTicket.label,
      value: money(highestTicket.avgTicket),
    },
  ].filter((value): value is DayInsight => value != null);

  return (
    <section className="space-y-4" data-testid="page-executive">
      <section
        className="no-print surface overflow-hidden border-teal-200"
        data-testid="executive-command-center"
      >
        <header className="bg-gradient-to-l from-teal-950 via-teal-900 to-slate-950 px-4 py-4 text-white sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 max-w-3xl">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-teal-200">
                {t("salesReports.command.stepUnderstand")}
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight sm:text-2xl">
                {t("salesReports.command.title")}
              </h2>
              <p className="mt-1.5 text-sm font-medium leading-6 text-teal-50/80">
                {t("salesReports.command.subtitle")}
              </p>
            </div>
            <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
              {(freshness?.pendingDays ?? 0) > 0 && (
                <Badge tone="warning">
                  {t("salesReports.topbar.lateTx", { count: freshness?.pendingDays ?? 0 })}
                </Badge>
              )}
              {freshness?.watermark && (
                <span data-freshness-watermark className="text-xs font-bold text-teal-100/70">
                  {t("salesReports.topbar.refreshedAt", { time: formatDateTime(freshness.watermark) })}
                </span>
              )}
              {!hasCompare && (
                <button
                  type="button"
                  onClick={() => patch({ compare: "prevPeriod" }, { push: true })}
                  className="min-h-11 rounded-xl border border-white/25 bg-white/10 px-3 text-xs font-extrabold text-white transition hover:bg-white/20 focus:outline-none focus-visible:ring-4 focus-visible:ring-white/20"
                >
                  {t("salesReports.command.enableCompare")}
                </button>
              )}
            </div>
          </div>
        </header>
        <DecisionKpis
          items={decisionKpis}
          compareEnabled={hasCompare}
          compareOffLabel={t("salesReports.command.compareOff")}
        />
      </section>

      <div className="no-print grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(19rem,0.9fr)]">
        <DecisionSignals
          signals={signals}
          title={t("salesReports.command.attention.title")}
          subtitle={t("salesReports.command.attention.subtitle")}
          clearTitle={t("salesReports.command.attention.clearTitle")}
          clearBody={t("salesReports.command.attention.clearBody")}
          openLabel={t("salesReports.command.openAnalysis")}
        />
        <PeriodPulse
          insights={periodInsights}
          title={t("salesReports.command.pulse.title")}
          subtitle={t("salesReports.command.pulse.subtitle")}
          openLabel={t("salesReports.command.pulse.openDay")}
          onOpen={(day) => patch({ from: day, to: day, preset: "custom" }, { push: true })}
        />
      </div>

      <ExecutiveDrivers
        filters={filters}
        search={search}
        canViewCashiers={canViewCashierPerformance}
      />

      <section className="no-print surface p-3" data-testid="decision-shortcuts">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-1 px-1">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-teal-700">
              {t("salesReports.command.stepExplain")}
            </p>
            <h3 className="text-sm font-extrabold text-slate-900">
              {t("salesReports.decisions.title")}
            </h3>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {t("salesReports.decisions.subtitle")}
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {decisionShortcuts.map((shortcut, index) => (
            <DecisionShortcut
              key={shortcut.id}
              to={decisionHref(shortcut.center, shortcut.view)}
              icon={shortcut.icon}
              step={index + 1}
              label={t(`salesReports.decisions.${shortcut.id}.title`)}
              description={
                shortcut.id === "items" && !canViewCost
                  ? t("salesReports.decisions.items.descriptionNoCost")
                  : t(`salesReports.decisions.${shortcut.id}.description`)
              }
            />
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-end justify-between gap-2 px-1 pt-1">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-teal-700">
            {t("salesReports.command.stepVerify")}
          </p>
          <h3 className="mt-0.5 text-base font-black text-slate-950">
            {t("salesReports.command.details.title")}
          </h3>
          <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">
            {t("salesReports.command.details.subtitle")}
          </p>
        </div>
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
          {(periodHasUncosted || compareHasUncosted) && (
            <div
              data-testid="cost-provenance-notice"
              className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold leading-5 text-amber-900"
            >
              {t("salesReports.profitability.incompletePeriod")}
            </div>
          )}
          <Statement
            showCompare={hasCompare}
            compareLabel={t("salesReports.topbar.compare")}
            lines={[
              {
                id: "net",
                label: t("salesReports.metrics.net_product_sales_ex_vat"),
                value: f("net_product_sales_ex_vat"),
                compare: c("net_product_sales_ex_vat"),
              },
              {
                id: "cogs",
                label: t("salesReports.metrics.cogs_after_returns"),
                value: trustedCogsAfterReturns,
                compare: trustedCompare("cogs_after_returns"),
                op: "sub",
                explain: metricExplain(t, registry.data, "cogs_after_returns"),
              },
              {
                id: "profit",
                label: t("salesReports.metrics.gross_profit_after_returns"),
                value: trustedGrossProfitAfterReturns,
                compare: trustedCompare("gross_profit_after_returns"),
                op: "eq",
                strong: true,
                explain: metricExplain(t, registry.data, "gross_profit_after_returns"),
              },
            ]}
          />
          <div className="border-t border-slate-100 px-4 py-2.5 text-sm">
            <span className="font-bold text-slate-600">{t("salesReports.metrics.margin_pct_after_returns")}</span>
            <span dir="ltr" className="ms-2 font-extrabold tabular-nums text-slate-900">
              {percent(trustedMarginAfterReturns)}
            </span>
          </div>
        </Section>
      )}

      <Section title={t("salesReports.report.sectionDaily")} note={t(`salesReports.dims.${dayDim}`)}>
        <DataTable<DayRow>
          columns={dayColumns}
          rows={dayRows}
          getRowId={(r) => r.day}
          tableId="sales-hub-executive"
          initialSort={{ columnId: "day", dir: "asc" }}
          onRowClick={(r) => patch({ from: r.day, to: r.day, preset: "custom" }, { push: true })}
          emptyTitle={t("salesReports.states.empty")}
        />
      </Section>
    </section>
  );
}
