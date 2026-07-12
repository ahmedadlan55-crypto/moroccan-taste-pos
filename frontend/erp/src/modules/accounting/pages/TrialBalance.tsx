import { useMemo } from "react";
import { DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import {
  useTrialBalance,
  startOfYearISO,
  todayISO,
  type DateRange,
  type TrialBalanceRow,
} from "../api";
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

const TYPE_BAR: Record<string, string> = {
  asset: "bg-sky-400",
  liability: "bg-rose-400",
  equity: "bg-violet-400",
  revenue: "bg-emerald-400",
  expense: "bg-amber-400",
};

interface FlatRow extends TrialBalanceRow {
  depth: number;
}

function buildTree(rows: TrialBalanceRow[]): { flat: FlatRow[]; roots: TrialBalanceRow[] } {
  const ids = new Set(rows.map((r) => r.accountId));
  const childrenOf = new Map<string | null, TrialBalanceRow[]>();
  for (const r of rows) {
    const pid = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    const arr = childrenOf.get(pid) ?? [];
    arr.push(r);
    childrenOf.set(pid, arr);
  }
  const byCode = (a: TrialBalanceRow, b: TrialBalanceRow) =>
    String(a.code || "").localeCompare(String(b.code || ""));
  for (const arr of childrenOf.values()) arr.sort(byCode);
  const roots = (childrenOf.get(null) ?? []).slice();
  const flat: FlatRow[] = [];
  const visit = (r: TrialBalanceRow, depth: number) => {
    flat.push({ ...r, depth });
    (childrenOf.get(r.accountId) ?? []).forEach((c) => visit(c, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));
  return { flat, roots };
}

const dr = (v: number) => (v > 0 ? v : 0);
const cr = (v: number) => (v < 0 ? -v : 0);

export function TrialBalancePage() {
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useTrialBalance(filter.applied);

  const { flat, totals } = useMemo(() => {
    const rows = query.data?.rows ?? [];
    const { flat: f, roots } = buildTree(rows);
    const t = roots.reduce(
      (acc, r) => {
        acc.openD += dr(r.opening);
        acc.openC += cr(r.opening);
        acc.perD += r.periodDebit;
        acc.perC += r.periodCredit;
        acc.closeD += dr(r.closing);
        acc.closeC += cr(r.closing);
        return acc;
      },
      { openD: 0, openC: 0, perD: 0, perC: 0, closeD: 0, closeC: 0 },
    );
    return { flat: f, totals: t };
  }, [query.data]);

  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;

  return (
    <div>
      <ReportHeader
        title="ميزان المراجعة"
        subtitle="أرصدة الحسابات: افتتاحي، حركة الفترة، وختامي — مع تحقّق التوازن."
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
        isEmpty={flat.length === 0}
        onRetry={() => query.refetch()}
      >
        <PrintArea>
          <div className="surface overflow-x-auto p-4">
            <PrintBanner title="ميزان المراجعة" period={period} />
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-extrabold text-slate-500">
                  <th rowSpan={2} className="px-3 py-2 text-right">الحساب</th>
                  <th colSpan={2} className="border-r border-slate-100 px-3 py-2 text-center">
                    رصيد أول المدة
                  </th>
                  <th colSpan={2} className="border-r border-slate-100 px-3 py-2 text-center">
                    حركة الفترة
                  </th>
                  <th colSpan={2} className="border-r border-slate-100 px-3 py-2 text-center">
                    رصيد آخر المدة
                  </th>
                </tr>
                <tr className="border-b border-slate-200 text-[11px] font-bold text-slate-400">
                  <th className="border-r border-slate-100 px-3 py-1.5 text-left">مدين</th>
                  <th className="px-3 py-1.5 text-left">دائن</th>
                  <th className="border-r border-slate-100 px-3 py-1.5 text-left">مدين</th>
                  <th className="px-3 py-1.5 text-left">دائن</th>
                  <th className="border-r border-slate-100 px-3 py-1.5 text-left">مدين</th>
                  <th className="px-3 py-1.5 text-left">دائن</th>
                </tr>
              </thead>
              <tbody>
                {flat.map((r) => (
                  <tr key={r.accountId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                    <td className="px-3 py-2" style={{ paddingInlineStart: 12 + r.depth * 22 }}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={`inline-block h-3.5 w-1 rounded-sm ${TYPE_BAR[r.type] ?? "bg-slate-300"}`}
                          aria-hidden="true"
                        />
                        <span className={r.depth === 0 ? "font-extrabold text-slate-900" : "font-semibold text-slate-700"}>
                          {r.nameAr}
                        </span>
                        <code className="text-[11px] text-slate-400">{r.code}</code>
                      </span>
                    </td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={dr(r.opening)} /></td>
                    <td className="px-3 py-2 text-left"><Num value={cr(r.opening)} /></td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.periodDebit} /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.periodCredit} /></td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={dr(r.closing)} strong /></td>
                    <td className="px-3 py-2 text-left"><Num value={cr(r.closing)} strong /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
                  <td className="px-3 py-2.5 text-right">الإجمالي</td>
                  <td className="border-r border-slate-100 px-3 py-2.5 text-left"><Num value={totals.openD} strong /></td>
                  <td className="px-3 py-2.5 text-left"><Num value={totals.openC} strong /></td>
                  <td className="border-r border-slate-100 px-3 py-2.5 text-left"><Num value={totals.perD} strong /></td>
                  <td className="px-3 py-2.5 text-left"><Num value={totals.perC} strong /></td>
                  <td className="border-r border-slate-100 px-3 py-2.5 text-left"><Num value={totals.closeD} strong /></td>
                  <td className="px-3 py-2.5 text-left"><Num value={totals.closeC} strong /></td>
                </tr>
              </tfoot>
            </table>
            <BalanceHint balanced={Math.abs(totals.closeD - totals.closeC) < 0.01} />
          </div>
        </PrintArea>
      </ReportState>
    </div>
  );
}

function BalanceHint({ balanced }: { balanced: boolean }) {
  return (
    <div
      className={`mt-4 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${
        balanced
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-700"
      }`}
    >
      {balanced ? "الميزان متوازن — إجمالي المدين = إجمالي الدائن" : "تنبيه: الميزان غير متوازن"}
    </div>
  );
}
