import { useMemo } from "react";
import { DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import {
  useTrialBalance,
  startOfYearISO,
  todayISO,
  type DateRange,
  type TrialBalanceRow,
  type TrialBalanceDiagnostics,
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

export function TrialBalancePage() {
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useTrialBalance(filter.applied);

  // Tier A.1 corrective gate: this used to recompute the footer totals by
  // summing root-level rows client-side (`roots.reduce(...)`), which not
  // only duplicated logic the server already computed correctly, but was
  // ALSO WRONG the moment the tree had more than one meaningful depth of
  // rollup or any non-leaf posting activity — the server's totals come from
  // a tree-independent raw-ledger sum (see lib/reports/trialBalance.js) and
  // the two numbers are not guaranteed to agree. `buildTree` below is used
  // ONLY to order/indent rows for display — never to derive a total.
  const flat = useMemo(() => buildTree(query.data?.rows ?? []).flat, [query.data]);
  const totals = query.data?.totals;
  const diagnostics = query.data?.diagnostics;
  const isClean = query.data?.isClean;

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
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.openDebit} /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.openCredit} /></td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.periodDebit} /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.periodCredit} /></td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.closeDebit} strong /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.closeCredit} strong /></td>
                  </tr>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
                    <td className="px-3 py-2.5 text-right">الإجمالي</td>
                    <td className="border-r border-slate-100 px-3 py-2.5 text-left"><Num value={totals.openDebit} strong /></td>
                    <td className="px-3 py-2.5 text-left"><Num value={totals.openCredit} strong /></td>
                    <td className="border-r border-slate-100 px-3 py-2.5 text-left"><Num value={totals.periodDebit} strong /></td>
                    <td className="px-3 py-2.5 text-left"><Num value={totals.periodCredit} strong /></td>
                    <td className="border-r border-slate-100 px-3 py-2.5 text-left"><Num value={totals.closeDebit} strong /></td>
                    <td className="px-3 py-2.5 text-left"><Num value={totals.closeCredit} strong /></td>
                  </tr>
                </tfoot>
              )}
            </table>
            {totals && <BalanceStatus totals={totals} isClean={isClean} diagnostics={diagnostics} />}
          </div>
        </PrintArea>
      </ReportState>
    </div>
  );
}

// Tier A.1 corrective gate — three INDEPENDENT balance checks (Opening/
// Period/Closing can each be off separately; a closing-only check can miss
// an opening-side imbalance that happens to cancel out), plus a diagnostics
// warning. All values come straight from the server response — none of
// this is recomputed here.
function BalanceStatus({
  totals,
  isClean,
  diagnostics,
}: {
  totals: TrialBalanceTotalsForStatus;
  isClean?: boolean;
  diagnostics?: TrialBalanceDiagnostics;
}) {
  const chips: Array<{ label: string; ok: boolean }> = [
    { label: "أول المدة", ok: totals.isOpeningBalanced },
    { label: "حركة الفترة", ok: totals.isPeriodBalanced },
    { label: "آخر المدة", ok: totals.isClosingBalanced },
  ];
  const diagCount =
    (diagnostics?.nullAccountEntries ?? 0) +
    (diagnostics?.futureDatedOpeningJournals.count ?? 0) +
    (diagnostics?.nonLeafPostingActivity.length ?? 0) +
    (diagnostics?.cycleAccounts.length ?? 0);

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span
          key={c.label}
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold ${
            c.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
        >
          {c.ok ? `متوازن — ${c.label}` : `غير متوازن — ${c.label}`}
        </span>
      ))}
      {isClean === false && diagCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          تنبيه: التقرير غير Clean — {diagCount} بند يحتاج مراجعة (قيود بحساب غير معروف، ترحيل على Folder/Parent،
          دورة في الشجرة، أو قيد افتتاحي مؤرَّخ بعد الفترة). راجع سجل التشخيص.
        </span>
      )}
    </div>
  );
}
type TrialBalanceTotalsForStatus = {
  isOpeningBalanced: boolean;
  isPeriodBalanced: boolean;
  isClosingBalanced: boolean;
};
