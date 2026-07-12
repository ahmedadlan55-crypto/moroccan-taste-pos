import { DatePicker, Select } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
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
  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <code className="rounded bg-white px-2 py-0.5 text-xs font-bold text-teal-700">{s.code}</code>
          <span className="text-sm font-extrabold text-slate-900">{s.nameAr}</span>
        </div>
        <div className="flex items-center gap-4 text-xs font-bold text-slate-500">
          <span>افتتاحي: <Num value={s.opening} signed /></span>
          <span>ختامي: <Num value={s.closingBalance} signed strong /></span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-right">التاريخ</th>
              <th className="px-3 py-2 text-right">القيد</th>
              <th className="px-3 py-2 text-right">البيان</th>
              <th className="px-3 py-2 text-left">مدين</th>
              <th className="px-3 py-2 text-left">دائن</th>
              <th className="px-3 py-2 text-left">الرصيد</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-50 bg-slate-50/40 text-xs font-bold text-slate-500">
              <td className="px-3 py-1.5" colSpan={5}>رصيد افتتاحي</td>
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
              <td className="px-3 py-2" colSpan={3}>الإجمالي ({s.lineCount} حركة)</td>
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
  const filter = useAppliedFilter<GlFilter>({ from: startOfYearISO(), to: todayISO(), scope: "active" });
  const query = useGlLedger(filter.applied, filter.applied.scope);
  const data = query.data;
  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;
  const sections = data?.sections ?? [];

  return (
    <div>
      <ReportHeader
        title="الأستاذ العام"
        subtitle="حركات الحسابات مع الرصيد الجاري لكل حساب — قابلة للتصفية بالنطاق والفترة."
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label="من تاريخ">
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label="إلى تاريخ">
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
        <FilterField label="النطاق">
          <Select
            value={filter.draft.scope}
            onChange={(e) => filter.patch({ scope: e.target.value })}
            options={[
              { value: "active", label: "الحسابات ذات الحركة" },
              { value: "leaf", label: "الحسابات النهائية فقط" },
              { value: "all", label: "كل الحسابات" },
            ]}
          />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={sections.length === 0}
        onRetry={() => query.refetch()}
        emptyBody="لا توجد حركات ضمن الفترة والنطاق المحدّدين."
      >
        <PrintArea>
          <div className="surface mb-5 p-4">
            <PrintBanner title="الأستاذ العام" period={period} />
            {data && (
              <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-600">
                <span>عدد الحسابات: {data.grandTotals.accountCount}</span>
                <span>عدد الحركات: {data.grandTotals.lineCount}</span>
                <span>إجمالي مدين: <Num value={data.grandTotals.debit} /></span>
                <span>إجمالي دائن: <Num value={data.grandTotals.credit} /></span>
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
