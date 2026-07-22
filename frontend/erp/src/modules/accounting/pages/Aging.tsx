import { DatePicker, Button } from "@/shared/ui";
import { Download } from "lucide-react";
import { formatDate } from "@/shared/lib";
import { useT, type TFunction } from "@/i18n";
import {
  useArAging,
  useApAging,
  todayISO,
  AGING_BUCKETS,
  agingBucketLabel,
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
  const t = useT();
  return (
    <PrintArea>
      <div className="surface mb-5 flex flex-wrap items-center gap-4 p-4">
        <div className="flex-1">
          <PrintBanner title={title} period={period} />
          <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-600">
            <span>{t("accounting.aging.grandTotal")} <Num value={grandTotal} strong /></span>
            <span>{t("accounting.aging.overdueRatio")} <span dir="ltr" className="tabular-nums">{fmt(overdueRatio)}%</span></span>
          </div>
        </div>
        <Button className="no-print" variant="secondary" onClick={onExport}>
          <Download className="h-4 w-4" /> {t("table.exportCsv")}
        </Button>
      </div>

      <div className="surface overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-right">{nameHeader}</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b} className="px-3 py-2 text-left">{agingBucketLabel(t, b)}</th>
              ))}
              <th className="px-3 py-2 text-left">{t("accounting.common.total")}</th>
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
              <td className="px-3 py-2.5 text-right">{t("accounting.common.total")}</td>
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

function csvRows(t: TFunction, nameHeader: string, rows: AgingRow[]): { header: string[]; body: (string | number)[][] } {
  const header = [nameHeader, ...AGING_BUCKETS.map((b) => agingBucketLabel(t, b)), t("accounting.common.total")];
  const body = rows.map((r) => [r.name, ...AGING_BUCKETS.map((b) => r.buckets[b]), r.total]);
  return { header, body };
}

export function ArAgingPage() {
  const t = useT();
  const filter = useAppliedFilter<{ asOf: string }>({ asOf: todayISO() });
  const query = useArAging(filter.applied.asOf);
  const data = query.data;
  const period = `${t("accounting.common.asOfPrefix")} ${formatDate(filter.applied.asOf)}`;
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
        title={t("accounting.aging.ar.title")}
        subtitle={t("accounting.aging.ar.subtitle")}
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
        emptyBody={t("accounting.aging.ar.empty")}
      >
        {data && (
          <AgingTable
            title={t("accounting.aging.ar.title")}
            period={period}
            nameHeader={t("accounting.aging.ar.name")}
            rows={rows}
            grandTotal={data.grandTotal}
            grandBuckets={data.grandBuckets}
            overdueRatio={data.overdue90PlusRatio}
            onExport={() => {
              const { header, body } = csvRows(t, t("accounting.aging.ar.name"), rows);
              exportRowsCsv(`ar-aging-${filter.applied.asOf}.csv`, header, body);
            }}
          />
        )}
      </ReportState>
    </div>
  );
}

export function ApAgingPage() {
  const t = useT();
  const filter = useAppliedFilter<{ asOf: string }>({ asOf: todayISO() });
  const query = useApAging(filter.applied.asOf);
  const data = query.data;
  const period = `${t("accounting.common.asOfPrefix")} ${formatDate(filter.applied.asOf)}`;
  const rows: AgingRow[] = (data?.suppliers ?? []).map((s, i) => ({
    id: s.supplierId ?? `sup-${i}`,
    name: s.supplierName,
    total: s.total,
    buckets: s.buckets,
  }));

  return (
    <div>
      <ReportHeader
        title={t("accounting.aging.ap.title")}
        subtitle={t("accounting.aging.ap.subtitle")}
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
        emptyBody={t("accounting.aging.ap.empty")}
      >
        {data && (
          <AgingTable
            title={t("accounting.aging.ap.title")}
            period={period}
            nameHeader={t("accounting.aging.ap.name")}
            rows={rows}
            grandTotal={data.grandTotal}
            grandBuckets={data.grandBuckets}
            overdueRatio={data.overdue90PlusRatio}
            onExport={() => {
              const { header, body } = csvRows(t, t("accounting.aging.ap.name"), rows);
              exportRowsCsv(`ap-aging-${filter.applied.asOf}.csv`, header, body);
            }}
          />
        )}
      </ReportState>
    </div>
  );
}
