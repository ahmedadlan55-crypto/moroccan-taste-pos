import { DatePicker, Select } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import { useGlLedger, startOfYearISO, todayISO, type GlSection } from "../api";
import {
  Num,
  ReportHeader,
  FilterCard,
  FilterField,
  PrintArea,
  PrintBanner,
  ReportState,
  useAppliedFilter,
  printReport,
} from "../components";

interface GlFilter {
  from: string;
  to: string;
  scope: string;
}

function AccountSection({ s }: { s: GlSection }) {
  const t = useT();
  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <code className="rounded bg-white px-2 py-0.5 text-xs font-bold text-teal-700">{s.code}</code>
          <span className="text-sm font-extrabold text-slate-900">{s.nameAr}</span>
        </div>
        <div className="flex items-center gap-4 text-xs font-bold text-slate-500">
          <span>{t("accounting.common.opening")}: <Num value={s.opening} signed /></span>
          <span>{t("accounting.common.closing")}: <Num value={s.closingBalance} signed strong /></span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-right">{t("accounting.common.date")}</th>
              <th className="px-3 py-2 text-right">{t("accounting.common.journalNo")}</th>
              <th className="px-3 py-2 text-right">{t("accounting.common.statement")}</th>
              <th className="px-3 py-2 text-left">{t("accounting.common.debit")}</th>
              <th className="px-3 py-2 text-left">{t("accounting.common.credit")}</th>
              <th className="px-3 py-2 text-left">{t("accounting.common.balance")}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-50 bg-slate-50/40 text-xs font-bold text-slate-500">
              <td className="px-3 py-1.5" colSpan={5}>{t("accounting.generalLedger.openingBalance")}</td>
              <td className="px-3 py-1.5 text-left"><Num value={s.opening} signed /></td>
            </tr>
            {s.lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                <td className="px-3 py-1.5 tabular-nums text-slate-600" dir="ltr">{formatDate(l.date)}</td>
                <td className="px-3 py-1.5"><code className="text-[11px] text-slate-400">{l.journalNumber}</code></td>
                <td className="px-3 py-1.5 text-slate-700">{l.description}</td>
                <td className="px-3 py-1.5 text-left"><Num value={l.debit} /></td>
                <td className="px-3 py-1.5 text-left"><Num value={l.credit} /></td>
                <td className="px-3 py-1.5 text-left"><Num value={l.runningBalance} signed /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50 text-xs font-extrabold">
              <td className="px-3 py-2" colSpan={3}>{t("accounting.generalLedger.totalMovements", { count: s.lineCount })}</td>
              <td className="px-3 py-2 text-left"><Num value={s.totalDebit} strong /></td>
              <td className="px-3 py-2 text-left"><Num value={s.totalCredit} strong /></td>
              <td className="px-3 py-2 text-left"><Num value={s.closingBalance} signed strong /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function GeneralLedgerPage() {
  const t = useT();
  const filter = useAppliedFilter<GlFilter>({ from: startOfYearISO(), to: todayISO(), scope: "active" });
  const query = useGlLedger(filter.applied, filter.applied.scope);
  const data = query.data;
  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;
  const sections = data?.sections ?? [];

  return (
    <div>
      <ReportHeader
        title={t("accounting.generalLedger.title")}
        subtitle={t("accounting.generalLedger.subtitle")}
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
        <FilterField label={t("accounting.report.scope")}>
          <Select
            value={filter.draft.scope}
            onChange={(e) => filter.patch({ scope: e.target.value })}
            options={[
              { value: "active", label: t("accounting.generalLedger.scope.active") },
              { value: "leaf", label: t("accounting.generalLedger.scope.leaf") },
              { value: "all", label: t("accounting.generalLedger.scope.all") },
            ]}
          />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={sections.length === 0}
        onRetry={() => query.refetch()}
        emptyBody={t("accounting.generalLedger.empty")}
      >
        <PrintArea>
          <div className="surface mb-5 p-4">
            <PrintBanner title={t("accounting.generalLedger.title")} period={period} />
            {data && (
              <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-600">
                <span>{t("accounting.generalLedger.accountCount")} {data.grandTotals.accountCount}</span>
                <span>{t("accounting.generalLedger.lineCount")} {data.grandTotals.lineCount}</span>
                <span>{t("accounting.generalLedger.totalDebit")} <Num value={data.grandTotals.debit} /></span>
                <span>{t("accounting.generalLedger.totalCredit")} <Num value={data.grandTotals.credit} /></span>
              </div>
            )}
          </div>
          <div className="grid gap-5">
            {sections.map((s) => (
              <AccountSection key={s.accountId} s={s} />
            ))}
          </div>
        </PrintArea>
      </ReportState>
    </div>
  );
}
