import { useState, type ReactNode } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { Button, DatePicker, Select } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  useSalesAnalytics,
  useBrands,
  useBranches,
  todayISO,
  type SalesAnalyticsFilter,
  type SalesAnalyticsResponse,
} from "../api";
import {
  Num,
  fmt,
  ReportHeader,
  FilterField,
  PrintArea,
  PrintBanner,
  ReportState,
  printReport,
  exportRowsCsv,
} from "../components";

// /accounting/sales-analytics — converted from the legacy-only erpRptSalesAnalytics.
// EVERY number on this screen comes from the server as-is: no client-side VAT,
// cost or margin math, ever. Unknown-breakdown counts are surfaced loudly rather
// than silently folded into the totals.

const TOP_PRODUCTS = 20;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function startOfMonthISO(): string {
  return `${todayISO().slice(0, 7)}-01`;
}

const PRESETS: Array<{ key: string; range: () => { from: string; to: string } }> = [
  { key: "today", range: () => ({ from: todayISO(), to: todayISO() }) },
  { key: "yesterday", range: () => ({ from: isoDaysAgo(1), to: isoDaysAgo(1) }) },
  { key: "week", range: () => ({ from: isoDaysAgo(6), to: todayISO() }) },
  { key: "month", range: () => ({ from: startOfMonthISO(), to: todayISO() }) },
];

function Kpi({ label, value, tone = "plain" }: { label: string; value: number; tone?: "plain" | "signed" }) {
  const negative = tone === "signed" && value < 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-bold text-slate-500">{label}</div>
      <div
        dir="ltr"
        className={`mt-1 text-xl font-extrabold tabular-nums ${negative ? "text-rose-600" : "text-slate-900"}`}
      >
        {negative ? `(${fmt(Math.abs(value))})` : fmt(value)}
      </div>
    </div>
  );
}

/** Amber warning strip for server-reported unknown-breakdown counts (>0 only). */
function UnknownWarning({ count, text }: { count: number; text: string }) {
  if (!(count > 0)) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <span dir="ltr" className="tabular-nums">{count}</span> {text}
      </span>
    </div>
  );
}

/** A titled report table section with its own CSV export button. */
function Section({
  title,
  note,
  onExport,
  children,
}: {
  title: string;
  note?: string;
  onExport?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="surface mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <span className="text-sm font-extrabold text-slate-900">{title}</span>
          {note && <span className="mr-3 text-[11px] font-bold text-slate-400">{note}</span>}
        </div>
        {onExport && (
          <Button className="no-print" variant="ghost" size="sm" onClick={onExport}>
            <Download className="h-4 w-4" /> CSV
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

const TH = "px-3 py-2 text-[11px] font-extrabold text-slate-500";
const TD = "px-3 py-2";

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function csvSuffix(f: SalesAnalyticsFilter): string {
  return `${f.from}-${f.to}`;
}

export function SalesAnalyticsPage() {
  // Local draft/applied state (not useAppliedFilter) so a quick preset can set
  // the dates AND apply them in one click.
  const defaults: SalesAnalyticsFilter = {
    from: startOfMonthISO(),
    to: todayISO(),
    brandId: "",
    branchId: "",
  };
  const [draft, setDraft] = useState<SalesAnalyticsFilter>(defaults);
  const [applied, setApplied] = useState<SalesAnalyticsFilter>(defaults);
  const patch = (part: Partial<SalesAnalyticsFilter>) => setDraft((d) => ({ ...d, ...part }));
  const applyPreset = (range: { from: string; to: string }) => {
    const next = { ...draft, ...range };
    setDraft(next);
    setApplied(next);
  };

  const t = useT();
  const query = useSalesAnalytics(applied);
  const brands = useBrands();
  const branches = useBranches();
  const data = query.data;
  const period = `${formatDate(applied.from)} — ${formatDate(applied.to)}`;

  return (
    <div>
      <ReportHeader
        title={t("accounting.salesAnalytics.title")}
        subtitle={t("accounting.salesAnalytics.subtitle")}
        onPrint={printReport}
      />

      <div className="no-print surface mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-500">{t("accounting.salesAnalytics.quickRanges")}</span>
          {PRESETS.map((p) => (
            <Button key={p.key} variant="secondary" size="sm" onClick={() => applyPreset(p.range())}>
              {t(`accounting.salesAnalytics.preset.${p.key}`)}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label={t("accounting.common.fromDate")}>
            <DatePicker value={draft.from} onChange={(from) => patch({ from })} />
          </FilterField>
          <FilterField label={t("accounting.common.toDate")}>
            <DatePicker value={draft.to} onChange={(to) => patch({ to })} />
          </FilterField>
          <FilterField label={t("accounting.salesAnalytics.brand")}>
            <Select value={draft.brandId} onChange={(e) => patch({ brandId: e.target.value })}>
              <option value="">{t("accounting.salesAnalytics.allBrands")}</option>
              {(brands.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label={t("accounting.salesAnalytics.branch")}>
            <Select value={draft.branchId} onChange={(e) => patch({ branchId: e.target.value })}>
              <option value="">{t("accounting.salesAnalytics.allBranches")}</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </FilterField>
          <Button variant="primary" onClick={() => setApplied(draft)} loading={query.isFetching}>
            {t("accounting.common.viewReport")}
          </Button>
        </div>
      </div>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={!!data && data.headline.invoiceCount === 0}
        onRetry={() => query.refetch()}
        emptyBody={t("accounting.salesAnalytics.empty")}
      >
        {data && <Results data={data} applied={applied} period={period} />}
      </ReportState>
    </div>
  );
}

function Results({
  data,
  applied,
  period,
}: {
  data: SalesAnalyticsResponse;
  applied: SalesAnalyticsFilter;
  period: string;
}) {
  const t = useT();
  const rev = data.revenue;
  const topProducts = data.byProduct.slice(0, TOP_PRODUCTS);

  return (
    <PrintArea>
      <div className="surface mb-5 p-4">
        <PrintBanner title={t("accounting.salesAnalytics.title")} period={period} />
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-bold text-slate-600">
          <span>
            {t("accounting.salesAnalytics.invoiceCount")} <span dir="ltr" className="tabular-nums">{data.headline.invoiceCount.toLocaleString("en-US")}</span>
          </span>
          <span>
            {t("accounting.salesAnalytics.avgTicket")} <Num value={data.headline.avgTicket} strong />
          </span>
        </div>
        <div className="mt-3 space-y-2">
          <UnknownWarning
            count={rev.netUnknownCount}
            text={t("accounting.salesAnalytics.netUnknown")}
          />
          <UnknownWarning
            count={rev.costUnknownCount}
            text={t("accounting.salesAnalytics.costUnknown")}
          />
        </div>
      </div>

      {/* The six headline money figures — rendered exactly as the server sent them. */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi label={t("accounting.salesAnalytics.grossInclVat")} value={rev.grossInclVat} />
        <Kpi label={t("accounting.salesAnalytics.net")} value={rev.net} />
        <Kpi label={t("accounting.salesAnalytics.vat")} value={rev.vat} />
        <Kpi label={t("accounting.salesAnalytics.discounts")} value={rev.discounts} />
        <Kpi label={t("accounting.salesAnalytics.cost")} value={rev.cost} />
        <Kpi label={t("accounting.salesAnalytics.profit")} value={rev.profit} tone="signed" />
      </div>

      <Section
        title={t("accounting.salesAnalytics.topProducts", { count: TOP_PRODUCTS })}
        note={
          data.byProduct.length > TOP_PRODUCTS
            ? t("accounting.salesAnalytics.topProductsNote", { count: data.byProduct.length })
            : undefined
        }
        onExport={() =>
          exportRowsCsv(
            `sales-by-product-${csvSuffix(applied)}.csv`,
            [
              t("accounting.salesAnalytics.col.product"),
              t("accounting.salesAnalytics.col.qty"),
              t("accounting.salesAnalytics.col.total"),
              t("accounting.salesAnalytics.col.net"),
              t("accounting.salesAnalytics.col.vat"),
              t("accounting.salesAnalytics.col.cost"),
              t("accounting.salesAnalytics.col.profit"),
              t("accounting.salesAnalytics.col.margin"),
            ],
            data.byProduct.map((p) => [p.name, p.qty, p.gross, p.net, p.vat, p.cost, p.profit, p.margin]),
          )
        }
      >
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={`${TH} text-right`}>{t("accounting.salesAnalytics.col.product")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.qty")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.total")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.net")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.vat")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.cost")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.profit")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.margin")}</th>
            </tr>
          </thead>
          <tbody>
            {topProducts.map((p, i) => (
              <tr key={`${p.name}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                <td className={`${TD} font-semibold text-slate-800`}>{p.name || "—"}</td>
                <td className={`${TD} text-left`}><span dir="ltr" className="tabular-nums font-semibold text-slate-700">{p.qty.toLocaleString("en-US")}</span></td>
                <td className={`${TD} text-left`}><Num value={p.gross} /></td>
                <td className={`${TD} text-left`}><Num value={p.net} /></td>
                <td className={`${TD} text-left`}><Num value={p.vat} /></td>
                <td className={`${TD} text-left`}><Num value={p.cost} /></td>
                <td className={`${TD} text-left`}><Num value={p.profit} signed strong /></td>
                <td className={`${TD} text-left`}>
                  <span dir="ltr" className="tabular-nums font-semibold text-slate-700">{fmt(p.margin)}%</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={t("accounting.salesAnalytics.dailySales")}
        onExport={() =>
          exportRowsCsv(
            `sales-daily-${csvSuffix(applied)}.csv`,
            [t("accounting.common.date"), t("accounting.salesAnalytics.col.invoiceCount"), t("accounting.salesAnalytics.col.total")],
            data.daily.map((d) => [d.date, d.count, d.total]),
          )
        }
      >
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={`${TH} text-right`}>{t("accounting.common.date")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.invoiceCount")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.total")}</th>
            </tr>
          </thead>
          <tbody>
            {data.daily.map((d) => (
              <tr key={d.date} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                <td className={`${TD} font-semibold text-slate-800`}>{formatDate(d.date)}</td>
                <td className={`${TD} text-left`}><span dir="ltr" className="tabular-nums font-semibold text-slate-700">{d.count.toLocaleString("en-US")}</span></td>
                <td className={`${TD} text-left`}><Num value={d.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section
          title={t("accounting.salesAnalytics.byPayment")}
          onExport={() =>
            exportRowsCsv(
              `sales-by-payment-${csvSuffix(applied)}.csv`,
              [t("accounting.salesAnalytics.col.paymentMethod"), t("accounting.salesAnalytics.col.invoiceCount"), t("accounting.salesAnalytics.col.total")],
              data.byPayment.map((p) => [p.method, p.count, p.total]),
            )
          }
        >
          <table className="w-full min-w-[24rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className={`${TH} text-right`}>{t("accounting.salesAnalytics.col.paymentMethod")}</th>
                <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.invoiceCount")}</th>
                <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.total")}</th>
              </tr>
            </thead>
            <tbody>
              {data.byPayment.map((p, i) => (
                <tr key={`${p.method}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                  <td className={`${TD} font-semibold text-slate-800`}>{p.method || "—"}</td>
                  <td className={`${TD} text-left`}><span dir="ltr" className="tabular-nums font-semibold text-slate-700">{p.count.toLocaleString("en-US")}</span></td>
                  <td className={`${TD} text-left`}><Num value={p.total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section
          title={t("accounting.salesAnalytics.byCashier")}
          onExport={() =>
            exportRowsCsv(
              `sales-by-cashier-${csvSuffix(applied)}.csv`,
              [t("accounting.salesAnalytics.col.cashier"), t("accounting.salesAnalytics.col.invoiceCount"), t("accounting.salesAnalytics.col.total"), t("accounting.salesAnalytics.col.avgTicket")],
              data.byCashier.map((c) => [c.cashier, c.count, c.total, c.avgTicket]),
            )
          }
        >
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className={`${TH} text-right`}>{t("accounting.salesAnalytics.col.cashier")}</th>
                <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.invoiceCount")}</th>
                <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.total")}</th>
                <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.avgTicket")}</th>
              </tr>
            </thead>
            <tbody>
              {data.byCashier.map((c, i) => (
                <tr key={`${c.cashier}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                  <td className={`${TD} font-semibold text-slate-800`}>{c.cashier || "—"}</td>
                  <td className={`${TD} text-left`}><span dir="ltr" className="tabular-nums font-semibold text-slate-700">{c.count.toLocaleString("en-US")}</span></td>
                  <td className={`${TD} text-left`}><Num value={c.total} /></td>
                  <td className={`${TD} text-left`}><Num value={c.avgTicket} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      <Section
        title={t("accounting.salesAnalytics.byHour")}
        onExport={() =>
          exportRowsCsv(
            `sales-by-hour-${csvSuffix(applied)}.csv`,
            [t("accounting.salesAnalytics.col.hour"), t("accounting.salesAnalytics.col.invoiceCount"), t("accounting.salesAnalytics.col.total")],
            data.byHour.map((h) => [hourLabel(h.hour), h.count, h.total]),
          )
        }
      >
        <table className="w-full min-w-[24rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className={`${TH} text-right`}>{t("accounting.salesAnalytics.col.hour")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.invoiceCount")}</th>
              <th className={`${TH} text-left`}>{t("accounting.salesAnalytics.col.total")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byHour.map((h) => (
              <tr key={h.hour} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                <td className={TD}>
                  <span dir="ltr" className="tabular-nums font-semibold text-slate-800">{hourLabel(h.hour)}</span>
                </td>
                <td className={`${TD} text-left`}><span dir="ltr" className="tabular-nums font-semibold text-slate-700">{h.count.toLocaleString("en-US")}</span></td>
                <td className={`${TD} text-left`}><Num value={h.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </PrintArea>
  );
}
