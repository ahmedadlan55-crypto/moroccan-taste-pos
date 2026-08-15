// /accounting/balance-sheet — the Statement of Financial Position, in REPORT
// FORM.
//
// WHAT CHANGED, AND WHY IT HAD TO
//   This page used to be two cards side by side — assets on one side,
//   liabilities and equity on the other — each an ungrouped list of accounts
//   with a grey strip per sub-group. Account form (two facing sides) is the
//   older presentation and it does not survive contact with A4: at print width
//   the two columns compress into an unreadable pair, and a reader comparing
//   "total current assets" with "total current liabilities" has to look across
//   the page instead of down it. IAS 1 does not require either form, but every
//   statement this system issues is printed, so report form — one column,
//   top to bottom, indented, with a subtotal after every section — is the one
//   that works.
//
//     Current assets → Non-current assets → TOTAL ASSETS
//     Current liabilities → Non-current liabilities → TOTAL LIABILITIES
//     Equity → TOTAL EQUITY
//     footer: TOTAL LIABILITIES AND EQUITY
//
//   Every subtotal is the server's own figure (totCA / totNCA / totalAssets /
//   totCL / totNCL / totalLiabilities / totEq). Nothing here sums a column.
//
// NO COMPARATIVE COLUMN — AND THAT IS A SERVER FACT, NOT AN OMISSION
//   /reports/balance-sheet-ifrs does accept `?compareDate=`, but read what it
//   returns: routes/erp/reports/balance-sheet.js runs a deliberately slim
//   second snapshot and produces prior figures for the TOP TOTALS and the
//   report_section buckets only — "the full per-account drilldown is NOT
//   duplicated". There is no prior balance for any individual account, so a
//   per-line comparative column would be blank on every line that carries an
//   account. That file also documents an unfixed sign defect in the snapshot's
//   equity branch. Rendering a comparative from it would put figures on a
//   signed statement that the server itself flags as wrong, so this asks for no
//   comparison and prints one period.
//
// THE BALANCE CHECK IS A CHIP, NOT A PARAGRAPH
//   `isBalanced` is genuinely load-bearing — a statement that does not tie is
//   the one thing a reader must be told. It is not, however, part of the
//   document: it is a fact about this run of the report. So it renders as one
//   compact chip ABOVE the printed document, and the sheet that comes out of
//   the printer is the statement alone.
import { useState } from "react";
import { DatePicker, PrintDocument } from "@/shared/ui";
import { formatAsAt } from "@/shared/lib";
import { StatementTable, type StatementRowBase } from "@/shared/reports";
import { useT, type TFunction } from "@/i18n";
import { useBalanceSheet, todayISO, type BsFlatItem, type BalanceSheetResponse } from "../api";
import {
  Num,
  fmt,
  ReportHeader,
  FilterCard,
  FilterField,
  ReportState,
  useAppliedFilter,
  printReport,
} from "../components";

interface BsRowModel extends StatementRowBase {
  code: string;
  amount: number | null;
}

/** A section heading, its account lines, and the server's total for it. */
function section(
  rows: BsRowModel[],
  id: string,
  heading: string,
  totalLabel: string,
  items: BsFlatItem[] | undefined,
  total: number,
): void {
  const lines = items ?? [];
  // An absent section with a zero total is left out; see the note in
  // IncomeStatement.tsx — an empty heading over a dash states nothing.
  if (lines.length === 0 && Math.abs(total) < 0.005) return;

  rows.push({ id, depth: 0, code: "", label: heading, kind: "line", hasChildren: lines.length > 0, amount: null });
  for (const item of lines) {
    rows.push({
      id: `${id}:${item.id ?? item.code}`,
      parentId: id,
      depth: 1,
      code: item.code,
      label: item.name,
      labelText: item.name,
      kind: "line",
      amount: item.balance,
    });
  }
  rows.push({ id: `${id}:total`, depth: 0, code: "", label: totalLabel, kind: "subtotal", amount: total });
}

function measure(rows: BsRowModel[], id: string, label: string, amount: number): void {
  rows.push({ id, depth: 0, code: "", label, kind: "total", amount });
}

function buildRows(t: TFunction, data: BalanceSheetResponse): BsRowModel[] {
  const rows: BsRowModel[] = [];
  const totalOf = (name: string) => t("accounting.balanceSheet.totalOf", { section: name });

  const currentAssets = t("accounting.balanceSheet.currentAssets");
  const nonCurrentAssets = t("accounting.balanceSheet.nonCurrentAssets");
  const currentLiab = t("accounting.balanceSheet.currentLiab");
  const nonCurrentLiab = t("accounting.balanceSheet.nonCurrentLiab");
  const equity = t("accounting.balanceSheet.equity");

  section(rows, "current-assets", currentAssets, totalOf(currentAssets), data.currentAssets, data.totCA);
  section(rows, "non-current-assets", nonCurrentAssets, totalOf(nonCurrentAssets), data.nonCurrentAssets, data.totNCA);
  measure(rows, "total-assets", t("accounting.balanceSheet.totalAssets"), data.totalAssets);

  section(rows, "current-liab", currentLiab, totalOf(currentLiab), data.currentLiab, data.totCL);
  section(rows, "non-current-liab", nonCurrentLiab, totalOf(nonCurrentLiab), data.nonCurrentLiab, data.totNCL);
  measure(rows, "total-liabilities", t("accounting.balanceSheet.totalLiabilities"), data.totalLiabilities);

  section(rows, "equity", equity, totalOf(equity), data.equityItems, data.totEq);
  measure(rows, "total-equity", t("accounting.balanceSheet.totalEquity"), data.totEq);

  return rows;
}

export function BalanceSheetPage() {
  const t = useT();
  const filter = useAppliedFilter<{ asOf: string }>({ asOf: todayISO() });
  const query = useBalanceSheet(filter.applied.asOf);
  const data = query.data;
  const period = formatAsAt(filter.applied.asOf);
  // Adds two figures the server computed independently. NOT a client-side
  // rollup of the rows — it is the same right-hand side the server's own
  // `isBalanced` compares total assets against, and the server publishes no
  // single "liabilities and equity" total to use instead.
  const rhs = data ? data.totalLiabilities + data.totEq : 0;
  const rows = data ? buildRows(t, data) : [];
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
        title={t("accounting.balanceSheet.title")}
        subtitle={t("accounting.balanceSheet.subtitle")}
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.common.asOfDate")}>
          <DatePicker value={filter.draft.asOf} onChange={(asOf) => filter.patch({ asOf })} />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
      >
        {data && (
          <>
            <div
              className={`no-print mb-4 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${
                data.isBalanced
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              {data.isBalanced
                ? t("accounting.balanceSheet.balanced", { assets: fmt(data.totalAssets), rhs: fmt(rhs) })
                : t("accounting.balanceSheet.unbalanced", { assets: fmt(data.totalAssets), rhs: fmt(rhs) })}
            </div>

            <PrintDocument title={t("accounting.balanceSheet.title")} subtitle={period}>
              <div className="surface p-4">
                <StatementTable<BsRowModel>
                  rows={rows}
                  labelHeader={t("accounting.balanceSheet.lineHeader")}
                  leadHeader={t("accounting.common.account")}
                  renderLead={(row) => (
                    <code dir="ltr" className="text-[11px] text-slate-400">
                      {row.code}
                    </code>
                  )}
                  collapsedIds={collapsed}
                  onToggleRow={toggleRow}
                  expandLabel={t("accounting.coa.expand")}
                  collapseLabel={t("accounting.coa.collapse")}
                  columns={[
                    {
                      id: "amount",
                      header: t("accounting.balanceSheet.amountHeader"),
                      align: "end",
                      render: (row) =>
                        row.amount == null ? null : (
                          <Num value={row.amount} signed strong={row.kind !== "line"} />
                        ),
                      csv: (row) => row.amount ?? "",
                    },
                  ]}
                  totals={{
                    label: t("accounting.balanceSheet.totalLiabEquity"),
                    values: { amount: <Num value={rhs} signed strong /> },
                  }}
                />
              </div>
            </PrintDocument>
          </>
        )}
      </ReportState>
    </div>
  );
}
