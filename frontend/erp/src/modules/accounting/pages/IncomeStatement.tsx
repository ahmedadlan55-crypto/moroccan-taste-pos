// /accounting/income-statement — the Income Statement, as a STATEMENT.
//
// WHAT CHANGED, AND WHY IT HAD TO
//   This page used to be two side-by-side lists: every revenue account in one
//   card, every expense account in the other, four KPI tiles above them and a
//   net-profit strip below. That is a pair of account listings, not an income
//   statement. It had no cost of sales, therefore no gross profit, therefore no
//   operating income — the three subtotals a reader actually looks for — and
//   the two columns sat side by side, so nothing on the page was in the order
//   the figures are read in.
//
//   The subtotals are not derivable from what /reports/pnl returns. Splitting
//   cost of sales out of "expenses" needs gl_accounts.report_section, which is
//   what lib/coa/classify.js reads and what /reports/income already buckets by.
//   So this reads /reports/income (same capability, see api.ts) and renders it
//   through the shared StatementTable in statement order:
//
//     Revenue → Cost of sales → GROSS PROFIT → Operating expenses → G&A
//       → OPERATING INCOME → Other income → Other expenses → NET INCOME
//
//   Every subtotal on the page is the server's own figure. Nothing here sums a
//   column: `grossProfit`, `operatingIncome` and `netIncome` are read straight
//   off the response, and the bottom line goes through StatementTable's
//   server-totals footer.
//
// THE COMPARATIVE COLUMN
//   This file used to end with: "/reports/income accepts startDate/endDate and
//   nothing else… When the endpoint gains a comparative, this is a `groups`
//   array and a second column, and nothing else." The endpoint has gained one
//   (compareStart/compareEnd, per-account `prior` plus a full prior ladder), and
//   that is exactly what this is.
//
//   Nothing here computes a prior figure. Every value in the comparison column
//   is the server's, produced by the SAME aggregate as the current column — so
//   the two can never be built on different bases, which is the one way a
//   comparison becomes worse than no comparison at all.
//
//   The Δ column IS computed here, and only here: it is presentation
//   arithmetic over two server figures, not a third opinion about the books.
//   Where either side is absent it prints nothing rather than a difference from
//   an assumed zero.
//
// THE URL IS THE REPORT
//   Period, comparison mode and its custom window all live in the query string
//   (`useUrlFilters`), so a copied link reproduces the exact statement in
//   someone else's browser — the acceptance criterion the spec states outright.
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  ComparePicker,
  DatePicker,
  PrintDocument,
  computeCompareRange,
  type CompareMode,
  type CompareRange,
} from "@/shared/ui";
import { formatForPeriod } from "@/shared/lib";
import { StatementTable, statementCsv, type StatementRowBase } from "@/shared/reports";
import { useUrlFilters, makeCodec, stringParam } from "@/shared/hooks/useUrlFilters";
import { useT, type TFunction } from "@/i18n";
import {
  useIncomeStatement,
  startOfYearISO,
  todayISO,
  type DateRange,
  type IncomeLine,
  type IncomeStatementResponse,
} from "../api";
import {
  Num,
  ReportHeader,
  exportRowsCsv,
  FilterCard,
  FilterField,
  ReportState,
  useAppliedFilter,
  printReport,
} from "../components";

interface PnlRowModel extends StatementRowBase {
  amount: number | null;
  /** The same line in the comparison period. null = no figure, not zero. */
  prior?: number | null;
}

/** Δ, computed only where BOTH sides exist. */
function delta(row: PnlRowModel): number | null {
  if (row.amount == null || row.prior == null) return null;
  return row.amount - row.prior;
}

/**
 * Zero prints as `—` on a DETAIL line and as `0.00` on a subtotal.
 *
 * This is the spec's rule, and it exists to stop exactly what a live check
 * caught here: a comparison row reading `4,581.25 | — | 4,581.25`. The prior
 * was a real, server-computed ZERO, but `Num`'s zero-as-dash made it look
 * ABSENT — so the Δ beside it read as a difference taken against nothing.
 * A subtotal of zero is a measured fact and must say so.
 */
function isSubtotal(row: PnlRowModel): boolean {
  return row.kind !== "line";
}

/**
 * One section of the statement: a heading, its account lines, and the server's
 * total for the section.
 *
 * A section with no lines AND a zero total is omitted entirely rather than
 * printed as an empty heading over a dash — an income statement lists what
 * happened, and "Other expenses ……… —" is a line that says nothing. A section
 * that is empty but carries a total is still printed, because then the total is
 * a real figure whose detail the classifier could not place.
 */
function section(
  rows: PnlRowModel[],
  id: string,
  heading: string,
  totalLabel: string,
  lines: IncomeLine[] | undefined,
  total: number,
  priorTotal?: number | null,
): void {
  const items = lines ?? [];
  // A section that is empty in BOTH columns is omitted. Judging on the current
  // period alone would hide a section that existed only last year — which is
  // the change a reader opened the comparison to see.
  const emptyNow = items.length === 0 && Math.abs(total) < 0.005;
  const emptyThen = priorTotal == null || Math.abs(priorTotal) < 0.005;
  if (emptyNow && emptyThen) return;

  rows.push({
    id, depth: 0, label: heading, kind: "line",
    hasChildren: items.length > 0, amount: null, prior: null,
  });
  for (const line of items) {
    rows.push({
      id: `${id}:${line.id ?? line.code}`,
      parentId: id,
      depth: 1,
      label: line.name,
      labelText: line.name,
      kind: "line",
      amount: line.balance,
      prior: line.prior ?? null,
    });
  }
  rows.push({
    id: `${id}:total`, depth: 0, label: totalLabel, kind: "subtotal",
    amount: total, prior: priorTotal ?? null,
  });
}

/** A standalone measure line — gross profit, operating income. */
function measure(
  rows: PnlRowModel[], id: string, label: string, amount: number, prior?: number | null,
): void {
  rows.push({ id, depth: 0, label, kind: "subtotal", amount, prior: prior ?? null });
}

function buildRows(t: TFunction, data: IncomeStatementResponse): PnlRowModel[] {
  const rows: PnlRowModel[] = [];
  const totalOf = (name: string) => t("accounting.incomeStatement.totalOf", { section: name });

  const revenue = t("accounting.incomeStatement.sections.revenue");
  const cogs = t("accounting.incomeStatement.sections.cogs");
  const opex = t("accounting.incomeStatement.sections.opex");
  const gAndA = t("accounting.incomeStatement.sections.gAndA");
  const otherIncome = t("accounting.incomeStatement.sections.otherIncome");
  const otherExpense = t("accounting.incomeStatement.sections.otherExpense");

  // Every prior figure comes off `data.comparison` — the server's ladder,
  // computed by the same code as the current one. `c?.x ?? null` keeps "no
  // comparison" as an absence rather than collapsing it to zero.
  const c = data.comparison ?? null;

  section(rows, "revenue", revenue, totalOf(revenue), data.revenue, data.totalRevenue, c?.totalRevenue ?? null);
  section(rows, "cogs", cogs, totalOf(cogs), data.cogs, data.totalCOGS, c?.totalCOGS ?? null);
  measure(rows, "gross-profit", t("accounting.incomeStatement.grossProfit"), data.grossProfit, c?.grossProfit ?? null);
  section(rows, "opex", opex, totalOf(opex), data.opex, data.totalOpex, c?.totalOpex ?? null);
  section(rows, "g-and-a", gAndA, totalOf(gAndA), data.gAndA, data.totalGAndA, c?.totalGAndA ?? null);
  measure(rows, "operating-income", t("accounting.incomeStatement.operatingIncome"), data.operatingIncome, c?.operatingIncome ?? null);
  section(rows, "other-income", otherIncome, totalOf(otherIncome), data.otherIncome, data.totalOtherInc, c?.totalOtherInc ?? null);
  section(rows, "other-expense", otherExpense, totalOf(otherExpense), data.otherExpense, data.totalOtherExp, c?.totalOtherExp ?? null);

  return rows;
}

/**
 * The report's whole state, in the query string.
 *
 * Canonical names are deliberately the ones the rest of the product already
 * uses for a period (`from`/`to`), so a link pasted between reports keeps its
 * meaning. `useUrlFilters` touches only these keys, leaving anything else in
 * the URL untouched.
 */
const pnlCodec = makeCodec({
  from: stringParam(startOfYearISO()),
  to: stringParam(todayISO()),
  cmp: stringParam("none"),
  cmpFrom: stringParam(""),
  cmpTo: stringParam(""),
});

export function IncomeStatementPage() {
  const t = useT();
  const url = useUrlFilters(pnlCodec);
  const applied: DateRange = { from: url.filters.from, to: url.filters.to };

  // Draft state for the date fields, so typing a date does not refetch on every
  // keystroke; Run commits it to the URL, which is what the query reads.
  const filter = useAppliedFilter<DateRange>(applied);

  const compareMode = (url.filters.cmp || "none") as CompareMode;
  const compareRange: CompareRange | null = useMemo(() => {
    if (compareMode === "none") return null;
    if (compareMode === "custom") {
      return url.filters.cmpFrom && url.filters.cmpTo
        ? { from: url.filters.cmpFrom, to: url.filters.cmpTo }
        : null;   // half-specified is not a comparison
    }
    return computeCompareRange(compareMode, applied);
  }, [compareMode, url.filters.cmpFrom, url.filters.cmpTo, applied.from, applied.to]);

  const query = useIncomeStatement(applied, compareRange);
  const data = query.data;
  const period = formatForPeriod(applied.from, applied.to);
  const comparing = !!data?.comparison;
  const rows = data ? buildRows(t, data) : [];
  // Collapse is a SCREEN preference only — StatementTable still prints and
  // exports every row, so a folded section can never fall out of the paper copy.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // The columns, built once so the table, the CSV and the footer cannot drift.
  const columns = [
    {
      id: "amount",
      header: t("accounting.incomeStatement.amountHeader"),
      groupId: comparing ? "current" : undefined,
      align: "end" as const,
      render: (row: PnlRowModel) =>
        row.amount == null ? null : <Num value={row.amount} signed strong={isSubtotal(row)} dash={!isSubtotal(row)} />,
      csv: (row: PnlRowModel) => row.amount ?? "",
    },
    ...(comparing
      ? [
          {
            id: "prior",
            header: t("accounting.incomeStatement.amountHeader"),
            groupId: "prior",
            align: "end" as const,
            render: (row: PnlRowModel) =>
              row.prior == null ? null : <Num value={row.prior} signed strong={isSubtotal(row)} dash={!isSubtotal(row)} />,
            csv: (row: PnlRowModel) => row.prior ?? "",
          },
          {
            id: "delta",
            header: t("accounting.incomeStatement.deltaHeader"),
            align: "end" as const,
            render: (row: PnlRowModel) => {
              const d = delta(row);
              return d == null ? null : <Num value={d} signed strong={isSubtotal(row)} dash={!isSubtotal(row)} />;
            },
            csv: (row: PnlRowModel) => delta(row) ?? "",
          },
        ]
      : []),
  ];

  function exportCsv() {
    if (!data) return;
    const { header, rows: body } = statementCsv(rows, columns, t("accounting.incomeStatement.lineHeader"));
    exportRowsCsv(`income-statement-${applied.from}_${applied.to}`, header, body);
  }

  return (
    <div>
      <ReportHeader
        title={t("accounting.incomeStatement.title")}
        subtitle={t("accounting.incomeStatement.subtitle")}
        onPrint={printReport}
        extraActions={
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {t("table.exportCsv")}
          </button>
        }
      />
      <FilterCard
        onRun={() => {
          filter.run();
          url.patch({ from: filter.draft.from, to: filter.draft.to });
        }}
        running={query.isFetching}
      >
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
        <FilterField label={t("accounting.incomeStatement.compareLabel")}>
          <ComparePicker
            value={compareMode}
            customRange={
              url.filters.cmpFrom && url.filters.cmpTo
                ? { from: url.filters.cmpFrom, to: url.filters.cmpTo }
                : undefined
            }
            onChange={(mode, custom) =>
              url.patch({
                cmp: mode,
                cmpFrom: mode === "custom" ? (custom?.from ?? "") : "",
                cmpTo: mode === "custom" ? (custom?.to ?? "") : "",
              })
            }
            labels={{
              modes: {
                none: t("accounting.incomeStatement.compare.none"),
                prevPeriod: t("accounting.incomeStatement.compare.prevPeriod"),
                prevYear: t("accounting.incomeStatement.compare.prevYear"),
                custom: t("accounting.incomeStatement.compare.custom"),
              },
              from: t("accounting.common.fromDate"),
              to: t("accounting.common.toDate"),
            }}
          />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
      >
        {data && (
          <PrintDocument title={t("accounting.incomeStatement.title")} subtitle={period}>
            <div className="surface p-4">
              <StatementTable<PnlRowModel>
                rows={rows}
                labelHeader={t("accounting.incomeStatement.lineHeader")}
                collapsedIds={collapsed}
                onToggleRow={toggleRow}
                expandLabel={t("accounting.coa.expand")}
                collapseLabel={t("accounting.coa.collapse")}
                columns={columns}
                // The two-tier header the shared table has always supported and
                // no page had ever used. Each period names its own dates, so a
                // printed copy states which windows are being compared rather
                // than leaving the reader to infer it.
                groups={
                  comparing
                    ? [
                        { id: "current", header: period },
                        {
                          id: "prior",
                          header: formatForPeriod(data.comparison!.from, data.comparison!.to),
                        },
                      ]
                    : undefined
                }
                totals={{
                  label: t("accounting.incomeStatement.netIncome"),
                  values: {
                    amount: <Num value={data.netIncome} signed strong />,
                    ...(comparing
                      ? {
                          prior: <Num value={data.comparison!.netIncome} signed strong />,
                          delta: <Num value={data.netIncome - data.comparison!.netIncome} signed strong />,
                        }
                      : {}),
                  },
                }}
              />
            </div>
          </PrintDocument>
        )}
      </ReportState>
    </div>
  );
}
