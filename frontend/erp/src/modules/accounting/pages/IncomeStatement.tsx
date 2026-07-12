import { DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { usePnl, startOfYearISO, todayISO, type DateRange, type PnlRow } from "../api";
import {
  Num,
  fmt,
  ReportHeader,
  FilterCard,
  FilterField,
  PrintArea,
  PrintBanner,
  ReportState,
  useAppliedFilter,
  printReport,
} from "../components";

function Kpi({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="surface p-4">
      <div className="text-xs font-bold text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${tone}`} dir="ltr">
        {value}
      </div>
    </div>
  );
}

function Section({ title, rows, total, totalTone }: { title: string; rows: PnlRow[]; total: number; totalTone: string }) {
  return (
    <div className="surface overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h3 className="text-sm font-extrabold text-slate-900">{title}</h3>
        <span className={`text-sm font-extrabold tabular-nums ${totalTone}`} dir="ltr">
          {fmt(total)}
        </span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-5 py-3 text-sm font-medium text-slate-400">لا توجد حسابات بحركة</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.accountId ?? r.code} className="border-b border-slate-50 last:border-0">
                <td className="px-5 py-2">
                  <span className="font-semibold text-slate-700">{r.nameAr}</span>{" "}
                  <code className="text-[11px] text-slate-400">{r.code}</code>
                </td>
                <td className="px-5 py-2 text-left">
                  <Num value={r.amount} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function IncomeStatementPage() {
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = usePnl(filter.applied);
  const data = query.data;
  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;
  const isEmpty = !!data && data.revenue.length === 0 && data.expenses.length === 0;

  return (
    <div>
      <ReportHeader
        title="قائمة الدخل"
        subtitle="الإيرادات مطروحًا منها المصروفات لفترة محدّدة — يحسبها الخادم من القيود المُرحَّلة."
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label="من تاريخ">
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label="إلى تاريخ">
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={isEmpty}
        onRetry={() => query.refetch()}
      >
        {data && (
          <PrintArea>
            <div className="surface mb-5 p-4">
              <PrintBanner title="قائمة الدخل" period={period} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi label="إجمالي الإيرادات" value={fmt(data.summary.totalRevenue)} tone="text-emerald-600" />
                <Kpi label="إجمالي المصروفات" value={fmt(data.summary.totalExpense)} tone="text-rose-600" />
                <Kpi
                  label="صافي الربح"
                  value={fmt(data.summary.netProfit)}
                  tone={data.summary.netProfit >= 0 ? "text-teal-700" : "text-rose-600"}
                />
                <Kpi label="هامش الربح" value={`${fmt(data.summary.grossMargin)}%`} tone="text-slate-900" />
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Section title="الإيرادات" rows={data.revenue} total={data.summary.totalRevenue} totalTone="text-emerald-600" />
              <Section title="المصروفات" rows={data.expenses} total={data.summary.totalExpense} totalTone="text-rose-600" />
            </div>

            <div className="surface mt-5 flex items-center justify-between px-5 py-4">
              <span className="text-base font-extrabold text-slate-900">صافي ربح الفترة</span>
              <span
                className={`text-xl font-extrabold tabular-nums ${
                  data.summary.netProfit >= 0 ? "text-teal-700" : "text-rose-600"
                }`}
                dir="ltr"
              >
                {fmt(data.summary.netProfit)}
              </span>
            </div>
          </PrintArea>
        )}
      </ReportState>
    </div>
  );
}
