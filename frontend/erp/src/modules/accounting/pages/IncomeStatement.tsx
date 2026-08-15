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
// NO COMPARATIVE COLUMN
//   /reports/income accepts startDate/endDate and nothing else — there is no
//   prior-period parameter and no prior figure anywhere in its response. A
//   comparative column would have to be invented on the client, so the table
//   renders a single period. When the endpoint gains a comparative, this is a
//   `groups` array and a second column, and nothing else.
import { useState } from "react";
import { DatePicker, PrintDocument } from "@/shared/ui";
import { formatForPeriod } from "@/shared/lib";
import { StatementTable, type StatementRowBase } from "@/shared/reports";
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
  FilterCard,
  FilterField,
  ReportState,
  useAppliedFilter,
  printReport,
} from "../components";

interface PnlRowModel extends StatementRowBase {
  amount: number | null;
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
): void {
  const items = lines ?? [];
  if (items.length === 0 && Math.abs(total) < 0.005) return;

  rows.push({ id, depth: 0, label: heading, kind: "line", hasChildren: items.length > 0, amount: null });
  for (const line of items) {
    rows.push({
      id: `${id}:${line.id ?? line.code}`,
      parentId: id,
      depth: 1,
      label: line.name,
      labelText: line.name,
      kind: "line",
      amount: line.balance,
    });
  }
  rows.push({ id: `${id}:total`, depth: 0, label: totalLabel, kind: "subtotal", amount: total });
}

/** A standalone measure line — gross profit, operating income. */
function measure(rows: PnlRowModel[], id: string, label: string, amount: number): void {
  rows.push({ id, depth: 0, label, kind: "subtotal", amount });
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

  section(rows, "revenue", revenue, totalOf(revenue), data.revenue, data.totalRevenue);
  section(rows, "cogs", cogs, totalOf(cogs), data.cogs, data.totalCOGS);
  measure(rows, "gross-profit", t("accounting.incomeStatement.grossProfit"), data.grossProfit);
  section(rows, "opex", opex, totalOf(opex), data.opex, data.totalOpex);
  section(rows, "g-and-a", gAndA, totalOf(gAndA), data.gAndA, data.totalGAndA);
  measure(rows, "operating-income", t("accounting.incomeStatement.operatingIncome"), data.operatingIncome);
  section(rows, "other-income", otherIncome, totalOf(otherIncome), data.otherIncome, data.totalOtherInc);
  section(rows, "other-expense", otherExpense, totalOf(otherExpense), data.otherExpense, data.totalOtherExp);

  return rows;
}

export function IncomeStatementPage() {
  const t = useT();
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useIncomeStatement(filter.applied);
  const data = query.data;
  const period = formatForPeriod(filter.applied.from, filter.applied.to);
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

  return (
    <div>
      <ReportHeader
        title={t("accounting.incomeStatement.title")}
        subtitle={t("accounting.incomeStatement.subtitle")}
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
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
                columns={[
                  {
                    id: "amount",
                    header: t("accounting.incomeStatement.amountHeader"),
                    align: "end",
                    render: (row) =>
                      row.amount == null ? null : (
                        <Num value={row.amount} signed strong={row.kind !== "line"} />
                      ),
                    csv: (row) => row.amount ?? "",
                  },
                ]}
                totals={{
                  label: t("accounting.incomeStatement.netIncome"),
                  values: { amount: <Num value={data.netIncome} signed strong /> },
                }}
              />
            </div>
          </PrintDocument>
        )}
      </ReportState>
    </div>
  );
}
