import { DatePicker, Button } from "@/shared/ui";
import { Download } from "lucide-react";
import { formatDate } from "@/shared/lib";
import {
  useArAging,
  useApAging,
  todayISO,
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  type AgingBuckets,
} from "../api";
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
  exportRowsCsv,
} from "../components";

// Normalized aging row so one table renders both AR (customers) and AP (suppliers).
interface AgingRow {
  id: string;
  name: string;
  sub?: string;
  total: number;
  buckets: AgingBuckets;
}

function AgingTable({
  title,
  period,
  nameHeader,
  rows,
  grandTotal,
  grandBuckets,
  overdueRatio,
  onExport,
}: {
  title: string;
  period: string;
  nameHeader: string;
  rows: AgingRow[];
  grandTotal: number;
  grandBuckets: AgingBuckets;
  overdueRatio: number;
  onExport: () => void;
}) {
  return (
    <PrintArea>
      <div className="surface mb-5 flex flex-wrap items-center gap-4 p-4">
        <div className="flex-1">
          <PrintBanner title={title} period={period} />
          <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-600">
            <span>الإجمالي المستحق: <Num value={grandTotal} strong /></span>
            <span>نسبة المتأخر (+90 يوم): <span dir="ltr" className="tabular-nums">{fmt(overdueRatio)}%</span></span>
          </div>
        </div>
        <Button className="no-print" variant="secondary" onClick={onExport}>
          <Download className="h-4 w-4" /> تصدير CSV
        </Button>
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-right">{nameHeader}</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b} className="px-3 py-2 text-left">{AGING_BUCKET_LABELS[b]}</th>
              ))}
              <th className="px-3 py-2 text-left">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800">{r.name}</div>
                  {r.sub && <div className="text-[11px] text-slate-400">{r.sub}</div>}
                </td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className="px-3 py-2 text-left"><Num value={r.buckets[b]} /></td>
                ))}
                <td className="px-3 py-2 text-left"><Num value={r.total} strong /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
              <td className="px-3 py-2.5 text-right">الإجمالي</td>
              {AGING_BUCKETS.map((b) => (
                <td key={b} className="px-3 py-2.5 text-left"><Num value={grandBuckets[b]} strong /></td>
              ))}
              <td className="px-3 py-2.5 text-left"><Num value={grandTotal} strong /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </PrintArea>
  );
}

function csvRows(nameHeader: string, rows: AgingRow[]): { header: string[]; body: (string | number)[][] } {
  const header = [nameHeader, ...AGING_BUCKETS.map((b) => AGING_BUCKET_LABELS[b]), "الإجمالي"];
  const body = rows.map((r) => [r.name, ...AGING_BUCKETS.map((b) => r.buckets[b]), r.total]);
  return { header, body };
}

export function ArAgingPage() {
  const filter = useAppliedFilter<{ asOf: string }>({ asOf: todayISO() });
  const query = useArAging(filter.applied.asOf);
  const data = query.data;
  const period = `كما في ${formatDate(filter.applied.asOf)}`;
  const rows: AgingRow[] = (data?.customers ?? []).map((c) => ({
    id: c.customerId,
    name: c.customerName,
    sub: c.customerPhone || undefined,
    total: c.total,
    buckets: c.buckets,
  }));

  return (
    <div>
      <ReportHeader
        title="أعمار الذمم المدينة"
        subtitle="أرصدة العملاء المستحقة موزّعة حسب أعمار الدين — يحسبها الخادم من المبيعات الآجلة."
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label="كما في تاريخ">
          <DatePicker value={filter.draft.asOf} onChange={(asOf) => filter.patch({ asOf })} />
        </FilterField>
      </FilterCard>
      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
        emptyBody="لا توجد ذمم مدينة مستحقة في هذا التاريخ."
      >
        {data && (
          <AgingTable
            title="أعمار الذمم المدينة"
            period={period}
            nameHeader="العميل"
            rows={rows}
            grandTotal={data.grandTotal}
            grandBuckets={data.grandBuckets}
            overdueRatio={data.overdue90PlusRatio}
            onExport={() => {
              const { header, body } = csvRows("العميل", rows);
              exportRowsCsv(`ar-aging-${filter.applied.asOf}.csv`, header, body);
            }}
          />
        )}
      </ReportState>
    </div>
  );
}

export function ApAgingPage() {
  const filter = useAppliedFilter<{ asOf: string }>({ asOf: todayISO() });
  const query = useApAging(filter.applied.asOf);
  const data = query.data;
  const period = `كما في ${formatDate(filter.applied.asOf)}`;
  const rows: AgingRow[] = (data?.suppliers ?? []).map((s, i) => ({
    id: s.supplierId ?? `sup-${i}`,
    name: s.supplierName,
    total: s.total,
    buckets: s.buckets,
  }));

  return (
    <div>
      <ReportHeader
        title="أعمار الذمم الدائنة"
        subtitle="أرصدة الموردين المستحقة موزّعة حسب أعمار الدين — يحسبها الخادم من المشتريات الآجلة."
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label="كما في تاريخ">
          <DatePicker value={filter.draft.asOf} onChange={(asOf) => filter.patch({ asOf })} />
        </FilterField>
      </FilterCard>
      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
        emptyBody="لا توجد ذمم دائنة مستحقة في هذا التاريخ."
      >
        {data && (
          <AgingTable
            title="أعمار الذمم الدائنة"
            period={period}
            nameHeader="المورّد"
            rows={rows}
            grandTotal={data.grandTotal}
            grandBuckets={data.grandBuckets}
            overdueRatio={data.overdue90PlusRatio}
            onExport={() => {
              const { header, body } = csvRows("المورّد", rows);
              exportRowsCsv(`ap-aging-${filter.applied.asOf}.csv`, header, body);
            }}
          />
        )}
      </ReportState>
    </div>
  );
}
