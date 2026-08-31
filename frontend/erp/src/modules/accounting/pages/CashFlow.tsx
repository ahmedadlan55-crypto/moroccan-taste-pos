import { DatePicker, PrintDocument } from "@/shared/ui";
import { formatForPeriod } from "@/shared/lib";
import { useT } from "@/i18n";
import { useCashFlow, startOfYearISO, todayISO, type DateRange, type CashFlowSection } from "../api";
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

function Section({ title, section }: { title: string; section: CashFlowSection }) {
  const t = useT();
  return (
    <div className="surface overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3 text-sm font-extrabold text-slate-800">
        {title}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {section.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-50 last:border-0">
              <td className="px-5 py-2 font-semibold text-slate-700">{l.label}</td>
              <td className="px-5 py-2 text-end">
                <Num value={l.amount} signed />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50 text-sm font-extrabold">
            <td className="px-5 py-2.5 text-slate-900">{t("accounting.cashFlow.netPrefix", { title })}</td>
            <td className="px-5 py-2.5 text-end">
              <Num value={section.total} signed strong />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ReconRow({ label, value, signed = false }: { label: string; value: number; signed?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-2 text-sm">
      <span className="font-semibold text-slate-600">{label}</span>
      <Num value={value} signed={signed} />
    </div>
  );
}

export function CashFlowPage() {
  const t = useT();
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useCashFlow(filter.applied);
  const data = query.data;
  const period = formatForPeriod(filter.applied.from, filter.applied.to);

  return (
    <div>
      <ReportHeader
        title={t("accounting.cashFlow.title")}
        subtitle={t("accounting.cashFlow.subtitle")}
        onPrint={printReport}
        pdf={{ filename: "cash-flow" }}
        printDisabled={query.isError}
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
        isEmpty={false}
        onRetry={() => query.refetch()}
      >
        {data && (
          <>
            {/* The reconciliation verdict is a fact about THIS RUN — whether
                the three activity sections add up to the cash the ledger really
                moved — not a line of the statement. It stays on screen and off
                the paper. */}
            <div
              className={`no-print mb-4 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${
                data.isReconciled
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              {data.isReconciled
                ? t("accounting.cashFlow.reconciled")
                : t("accounting.cashFlow.reconDiff", { amount: fmt(data.reconciliationDiff) })}
            </div>

            <PrintDocument title={t("accounting.cashFlow.title")} subtitle={period}>
            <div className="grid gap-5">
              <Section title={t("accounting.cashFlow.operating")} section={data.operating} />
              <Section title={t("accounting.cashFlow.investing")} section={data.investing} />
              <Section title={t("accounting.cashFlow.financing")} section={data.financing} />

              <div className="surface overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3 text-sm font-extrabold text-slate-800">
                  {t("accounting.cashFlow.netChangeTitle")}
                </div>
                <ReconRow label={t("accounting.cashFlow.netChange")} value={data.netChange} signed />
                <div className="border-t border-slate-50" />
                <ReconRow label={t("accounting.cashFlow.cashOpening")} value={data.cashOpening} />
                <ReconRow label={t("accounting.cashFlow.cashClosing")} value={data.cashClosing} />
                <ReconRow label={t("accounting.cashFlow.actualMovement")} value={data.actualMovement} signed />
              </div>
            </div>
            </PrintDocument>
          </>
        )}
      </ReportState>
    </div>
  );
}
