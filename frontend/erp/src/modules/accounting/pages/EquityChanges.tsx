import { Download } from "lucide-react";
import { Button, DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import {
  useEquityChanges,
  startOfYearISO,
  todayISO,
  type DateRange,
  type EquityBucket,
  type EquityChangesResponse,
  type EquityStatementLine,
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

// /accounting/equity-changes — converted from the legacy-only equity-changes
// report. The server owns every bucket, line and the balance-sheet cross-check;
// this screen only renders the pinned /erp/reports/equity-changes payload.

function BucketSection({ bucket }: { bucket: EquityBucket }) {
  return (
    <div className="surface mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-teal-50/60 px-4 py-3">
        <span className="text-sm font-extrabold text-teal-800">{bucket.label}</span>
        <span className="flex items-center gap-4 text-xs font-bold text-slate-600">
          <span>
            افتتاحي: <Num value={bucket.opening} signed />
          </span>
          <span>
            ختامي: <Num value={bucket.closing} signed strong />
          </span>
        </span>
      </div>
      {bucket.accounts.length === 0 ? (
        // An empty bucket is stated honestly — no fabricated zero rows.
        <div className="px-4 py-4 text-sm font-semibold text-slate-400">لا يوجد</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
                <th className="px-4 py-2 text-right">الحساب</th>
                <th className="px-4 py-2 text-left">افتتاحي</th>
                <th className="px-4 py-2 text-left">حركة مدين</th>
                <th className="px-4 py-2 text-left">حركة دائن</th>
                <th className="px-4 py-2 text-left">ختامي</th>
              </tr>
            </thead>
            <tbody>
              {bucket.accounts.map((a) => (
                <tr key={a.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                  <td className="px-4 py-2">
                    <span className="font-semibold text-slate-700">{a.name}</span>{" "}
                    <code className="text-[11px] text-slate-400">{a.code}</code>
                  </td>
                  <td className="px-4 py-2 text-left"><Num value={a.opening} signed /></td>
                  <td className="px-4 py-2 text-left"><Num value={a.periodDebit} /></td>
                  <td className="px-4 py-2 text-left"><Num value={a.periodCredit} /></td>
                  <td className="px-4 py-2 text-left"><Num value={a.closing} signed strong /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Net-income / closing-entries statement line — visually distinct from buckets. */
function StatementLine({
  line,
  fallbackLabel,
  tone,
}: {
  line: EquityStatementLine | null;
  fallbackLabel: string;
  tone: "emerald" | "violet";
}) {
  if (!line) return null;
  const cls =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-violet-200 bg-violet-50 text-violet-800";
  return (
    <div className={`mb-3 flex items-center justify-between rounded-xl border px-4 py-3 ${cls}`}>
      <span className="text-sm font-extrabold">{line.label || fallbackLabel}</span>
      <Num value={line.amount} signed strong />
    </div>
  );
}

function ReconciliationBadge({ rec, closing }: { rec: EquityChangesResponse["reconciliation"]; closing: number }) {
  if (rec.matches) {
    return (
      <div className="mb-5 inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
        مطابق للميزانية ✓
      </div>
    );
  }
  // A mismatch is a books problem — it is NEVER hidden or softened.
  return (
    <div className="mb-5 rounded-xl border-2 border-rose-300 bg-rose-50 px-4 py-3 text-sm font-extrabold text-rose-800">
      <div>تحذير: القائمة غير مطابقة للميزانية!</div>
      <div className="mt-1 text-xs font-bold">
        ختامي حقوق الملكية في هذه القائمة: <span dir="ltr" className="tabular-nums">{fmt(closing)}</span>
        {" — "}
        حقوق الملكية في الميزانية: <span dir="ltr" className="tabular-nums">{fmt(rec.bsTotEq)}</span>
        {" — "}
        الفرق: <span dir="ltr" className="tabular-nums">{fmt(closing - rec.bsTotEq)}</span>
      </div>
    </div>
  );
}

function exportCsv(data: EquityChangesResponse) {
  const header = ["البند", "الحساب", "الرمز", "افتتاحي", "حركة مدين", "حركة دائن", "ختامي"];
  const rows: (string | number)[][] = [];
  for (const b of data.buckets) {
    if (b.accounts.length === 0) {
      rows.push([b.label, "لا يوجد", "", b.opening, "", "", b.closing]);
      continue;
    }
    for (const a of b.accounts) {
      rows.push([b.label, a.name, a.code, a.opening, a.periodDebit, a.periodCredit, a.closing]);
    }
    rows.push([`إجمالي ${b.label}`, "", "", b.opening, "", "", b.closing]);
  }
  if (data.netIncomeLine) {
    rows.push([data.netIncomeLine.label || "صافي دخل الفترة", "", "", "", "", "", data.netIncomeLine.amount]);
  }
  if (data.closingEntriesLine) {
    rows.push([data.closingEntriesLine.label || "قيود الإقفال", "", "", "", "", "", data.closingEntriesLine.amount]);
  }
  rows.push(["إجمالي حقوق الملكية", "", "", data.totals.opening, "", "", data.totals.closing]);
  exportRowsCsv(`equity-changes-${data.from}-${data.to}.csv`, header, rows);
}

export function EquityChangesPage() {
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useEquityChanges(filter.applied);
  const data = query.data;
  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;

  return (
    <div>
      <ReportHeader
        title="التغيرات في حقوق الملكية"
        subtitle="حركة حقوق الملكية خلال الفترة: رأس المال، الأرباح المحتجزة، المسحوبات، الاحتياطيات والزكاة — مع مطابقة الميزانية."
        onPrint={printReport}
        extraActions={
          data && (
            <Button variant="secondary" onClick={() => exportCsv(data)}>
              <Download className="h-4 w-4" /> تصدير CSV
            </Button>
          )
        }
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
        isEmpty={!!data && data.buckets.length === 0}
        onRetry={() => query.refetch()}
        emptyBody="لا توجد حسابات حقوق ملكية في هذه الفترة."
      >
        {data && (
          <PrintArea>
            <div className="surface mb-5 p-4">
              <PrintBanner title="قائمة التغيرات في حقوق الملكية" period={period} />
              <ReconciliationBadge rec={data.reconciliation} closing={data.totals.closing} />
            </div>

            {data.buckets.map((b) => (
              <BucketSection key={b.key} bucket={b} />
            ))}

            <StatementLine line={data.netIncomeLine} fallbackLabel="صافي دخل الفترة" tone="emerald" />
            <StatementLine line={data.closingEntriesLine} fallbackLabel="قيود الإقفال" tone="violet" />

            <div className="surface flex flex-wrap items-center justify-between gap-3 border-t-2 border-slate-300 bg-slate-50 px-4 py-3">
              <span className="text-sm font-extrabold text-slate-900">إجمالي حقوق الملكية</span>
              <span className="flex items-center gap-6 text-sm font-bold text-slate-700">
                <span>
                  افتتاحي: <Num value={data.totals.opening} signed strong />
                </span>
                <span>
                  ختامي: <Num value={data.totals.closing} signed strong />
                </span>
              </span>
            </div>
          </PrintArea>
        )}
      </ReportState>
    </div>
  );
}
