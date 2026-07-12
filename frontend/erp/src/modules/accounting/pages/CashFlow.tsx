import { DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useCashFlow, startOfYearISO, todayISO, type DateRange, type CashFlowSection } from "../api";
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

function Section({ title, section }: { title: string; section: CashFlowSection }) {
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
              <td className="px-5 py-2 text-left">
                <Num value={l.amount} signed />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50 text-sm font-extrabold">
            <td className="px-5 py-2.5 text-slate-900">صافي {title}</td>
            <td className="px-5 py-2.5 text-left">
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
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useCashFlow(filter.applied);
  const data = query.data;
  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;

  return (
    <div>
      <ReportHeader
        title="قائمة التدفقات النقدية"
        subtitle="الطريقة غير المباشرة (IAS 7): تشغيلية، استثمارية، وتمويلية — مع تسوية مع حركة النقد الفعلية."
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
        isEmpty={false}
        onRetry={() => query.refetch()}
      >
        {data && (
          <PrintArea>
            <div className="surface mb-5 p-4">
              <PrintBanner title="قائمة التدفقات النقدية" period={period} />
              <div
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${
                  data.isReconciled
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                }`}
              >
                {data.isReconciled
                  ? "التدفقات مطابقة لحركة النقد الفعلية"
                  : `فرق تسوية: ${fmt(data.reconciliationDiff)}`}
              </div>
            </div>

            <div className="grid gap-5">
              <Section title="الأنشطة التشغيلية" section={data.operating} />
              <Section title="الأنشطة الاستثمارية" section={data.investing} />
              <Section title="الأنشطة التمويلية" section={data.financing} />

              <div className="surface overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3 text-sm font-extrabold text-slate-800">
                  صافي التغيّر في النقد والتسوية
                </div>
                <ReconRow label="صافي التغيّر في النقد" value={data.netChange} signed />
                <div className="border-t border-slate-50" />
                <ReconRow label="النقد أول الفترة" value={data.cashOpening} />
                <ReconRow label="النقد آخر الفترة" value={data.cashClosing} />
                <ReconRow label="الحركة الفعلية للنقد" value={data.actualMovement} signed />
              </div>
            </div>
          </PrintArea>
        )}
      </ReportState>
    </div>
  );
}
