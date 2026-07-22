import { useMemo, type ReactNode } from "react";
import { DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
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
  // Tier A.2 corrective gate — a hierarchy CYCLE (A.parent=B, B.parent=A)
  // means neither node ever has parentId=null, so neither ever lands in
  // `roots`, and a walk that only starts from roots never reaches either —
  // both rows would silently vanish from the table (`diagnostics.
  // cycleAccounts` would flag them, but the reader would never actually see
  // the row to investigate). `visited` guards against re-entering a cycle
  // mid-walk; the sweep below catches every row a root-only walk could
  // never reach and renders it as a pseudo-root instead.
  const visited = new Set<string>();
  const visit = (r: TrialBalanceRow, depth: number) => {
    if (visited.has(r.accountId)) return;
    visited.add(r.accountId);
    flat.push({ ...r, depth });
    (childrenOf.get(r.accountId) ?? []).forEach((c) => visit(c, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));
  rows.forEach((r) => visit(r, 0));
  return { flat, roots };
}

export function TrialBalancePage() {
  const t = useT();
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
        title={t("accounting.trialBalance.title")}
        subtitle={t("accounting.trialBalance.subtitle")}
        onPrint={printReport}
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
        isEmpty={flat.length === 0}
        onRetry={() => query.refetch()}
      >
        <PrintArea>
          <div className="surface overflow-x-auto p-4">
            <PrintBanner title={t("accounting.trialBalance.title")} period={period} />
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-extrabold text-slate-500">
                  <th rowSpan={2} className="px-3 py-2 text-right">{t("accounting.common.account")}</th>
                  <th colSpan={2} className="border-r border-slate-100 px-3 py-2 text-center">
                    {t("accounting.trialBalance.openingCol")}
                  </th>
                  <th colSpan={2} className="border-r border-slate-100 px-3 py-2 text-center">
                    {t("accounting.trialBalance.periodCol")}
                  </th>
                  <th colSpan={2} className="border-r border-slate-100 px-3 py-2 text-center">
                    {t("accounting.trialBalance.closingCol")}
                  </th>
                </tr>
                <tr className="border-b border-slate-200 text-[11px] font-bold text-slate-400">
                  <th className="border-r border-slate-100 px-3 py-1.5 text-left">{t("accounting.common.debit")}</th>
                  <th className="px-3 py-1.5 text-left">{t("accounting.common.credit")}</th>
                  <th className="border-r border-slate-100 px-3 py-1.5 text-left">{t("accounting.common.debit")}</th>
                  <th className="px-3 py-1.5 text-left">{t("accounting.common.credit")}</th>
                  <th className="border-r border-slate-100 px-3 py-1.5 text-left">{t("accounting.common.debit")}</th>
                  <th className="px-3 py-1.5 text-left">{t("accounting.common.credit")}</th>
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
              {/* Release integration — accounting's field names and its
                  `{totals && …}` guard, with sprint's t() for the label. The
                  field names are not interchangeable: the rewritten
                  lib/reports/trialBalance.js emits openDebit / openCredit /
                  periodDebit / periodCredit / closeDebit / closeCredit, so
                  sprint's openD/openC/perD/perC/closeD/closeC would every one
                  render blank. ar's accounting.common.total is the identical
                  string ("الإجمالي"), so the Arabic UI is byte-identical. */}
              {totals && (
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
                    <td className="px-3 py-2.5 text-right">{t("accounting.common.total")}</td>
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
// an opening-side imbalance that happens to cancel out). All values come
// straight from the server response — none of this is recomputed here.
function BalanceStatus({
  totals,
  isClean,
  diagnostics,
}: {
  totals: TrialBalanceTotalsForStatus;
  isClean?: boolean;
  diagnostics?: TrialBalanceDiagnostics;
}) {
  const t = useT();
  // `key` is a stable, language-independent React key — the visible `scope`
  // text changes with the active language, so it must not double as the key.
  const chips: Array<{ key: string; scope: string; ok: boolean }> = [
    { key: "opening", scope: t("accounting.trialBalance.balanceStatus.opening"), ok: totals.isOpeningBalanced },
    { key: "period", scope: t("accounting.trialBalance.balanceStatus.period"), ok: totals.isPeriodBalanced },
    { key: "closing", scope: t("accounting.trialBalance.balanceStatus.closing"), ok: totals.isClosingBalanced },
  ];

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <span
            key={c.key}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold ${
              c.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {t(
              c.ok
                ? "accounting.trialBalance.balanceStatus.balanced"
                : "accounting.trialBalance.balanceStatus.unbalanced",
              { scope: c.scope },
            )}
          </span>
        ))}
        {isClean === false && (
          <span className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {t("accounting.trialBalance.balanceStatus.notClean")}
          </span>
        )}
      </div>
      {isClean === false && diagnostics && <DiagnosticsPanel diagnostics={diagnostics} />}
    </div>
  );
}
type TrialBalanceTotalsForStatus = {
  isOpeningBalanced: boolean;
  isPeriodBalanced: boolean;
  isClosingBalanced: boolean;
};

// Tier A.2 corrective gate — this used to be a single sentence ("راجع سجل
// التشخيص") pointing at nothing; there was no log, no page, nothing to
// actually review. Every diagnostic bucket the server computes is now
// itemized here, with its real rows/counts, so "غير Clean" is always
// immediately actionable instead of a dead end.
function DiagnosticsPanel({ diagnostics: d }: { diagnostics: TrialBalanceDiagnostics }) {
  const t = useT();
  const sections: Array<{ key: string; label: string; count: number; render: () => ReactNode }> = [
    {
      key: "nullOpen",
      label: t("accounting.trialBalance.diagnostics.nullAccountOpening"),
      count: d.nullAccountOpening.count,
      render: () => (
        <p>
          {t("accounting.trialBalance.diagnostics.lineCount")} {d.nullAccountOpening.count} —{" "}
          {t("accounting.trialBalance.diagnostics.debit")} <Num value={d.nullAccountOpening.debit} /> —{" "}
          {t("accounting.trialBalance.diagnostics.credit")} <Num value={d.nullAccountOpening.credit} />
        </p>
      ),
    },
    {
      key: "nullPeriod",
      label: t("accounting.trialBalance.diagnostics.nullAccountPeriod"),
      count: d.nullAccountPeriod.count,
      render: () => (
        <p>
          {t("accounting.trialBalance.diagnostics.lineCount")} {d.nullAccountPeriod.count} —{" "}
          {t("accounting.trialBalance.diagnostics.debit")} <Num value={d.nullAccountPeriod.debit} /> —{" "}
          {t("accounting.trialBalance.diagnostics.credit")} <Num value={d.nullAccountPeriod.credit} />
        </p>
      ),
    },
    {
      key: "danglingOpen",
      label: t("accounting.trialBalance.diagnostics.danglingAccountOpening"),
      count: d.danglingAccountOpening.count,
      render: () => (
        <p>
          {t("accounting.trialBalance.diagnostics.lineCount")} {d.danglingAccountOpening.count} —{" "}
          {t("accounting.trialBalance.diagnostics.debit")} <Num value={d.danglingAccountOpening.debit} /> —{" "}
          {t("accounting.trialBalance.diagnostics.credit")} <Num value={d.danglingAccountOpening.credit} />
        </p>
      ),
    },
    {
      key: "danglingPeriod",
      label: t("accounting.trialBalance.diagnostics.danglingAccountPeriod"),
      count: d.danglingAccountPeriod.count,
      render: () => (
        <p>
          {t("accounting.trialBalance.diagnostics.lineCount")} {d.danglingAccountPeriod.count} —{" "}
          {t("accounting.trialBalance.diagnostics.debit")} <Num value={d.danglingAccountPeriod.debit} /> —{" "}
          {t("accounting.trialBalance.diagnostics.credit")} <Num value={d.danglingAccountPeriod.credit} />
        </p>
      ),
    },
    {
      key: "futureOpen",
      label: t("accounting.trialBalance.diagnostics.futureDatedOpening"),
      count: d.futureDatedOpeningJournals.count,
      render: () => (
        <p>
          {t("accounting.trialBalance.diagnostics.journalCount")} {d.futureDatedOpeningJournals.count} —{" "}
          {t("accounting.trialBalance.diagnostics.debit")} <Num value={d.futureDatedOpeningJournals.debit} /> —{" "}
          {t("accounting.trialBalance.diagnostics.credit")} <Num value={d.futureDatedOpeningJournals.credit} />
        </p>
      ),
    },
    {
      key: "orphans",
      label: t("accounting.trialBalance.diagnostics.orphanAccounts"),
      count: d.orphanAccounts.length,
      render: () => (
        <ul className="list-disc pe-4">
          {d.orphanAccounts.map((a) => (
            <li key={a.code}>{a.code} — {a.nameAr} (parent_id={a.parentId})</li>
          ))}
        </ul>
      ),
    },
    {
      key: "nonLeaf",
      label: t("accounting.trialBalance.diagnostics.nonLeafPosting"),
      count: d.nonLeafPostingActivity.length,
      render: () => (
        <ul className="list-disc pe-4">
          {d.nonLeafPostingActivity.map((a) => (
            <li key={a.code}>
              {a.code} — {a.nameAr} — {t("accounting.trialBalance.diagnostics.opening")}{" "}
              <Num value={a.openDebit} />/<Num value={a.openCredit} /> —{" "}
              {t("accounting.trialBalance.diagnostics.period")} <Num value={a.periodDebit} />/
              <Num value={a.periodCredit} />
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "cycles",
      label: t("accounting.trialBalance.diagnostics.cycleAccounts"),
      count: d.cycleAccounts.length,
      render: () => (
        <ul className="list-disc pe-4">
          {d.cycleAccounts.map((a) => (
            <li key={a.code}>{a.code} — {a.nameAr}</li>
          ))}
        </ul>
      ),
    },
    {
      key: "levels",
      label: t("accounting.trialBalance.diagnostics.levelMismatches"),
      count: d.levelMismatches.length,
      render: () => (
        <ul className="list-disc pe-4">
          {d.levelMismatches.map((a) => (
            <li key={a.code}>
              {a.code} — {a.nameAr} ({t("accounting.trialBalance.diagnostics.storedLevel")}={a.storedLevel},{" "}
              {t("accounting.trialBalance.diagnostics.computedLevel")}={a.computedLevel})
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "unbalanced",
      label: t("accounting.trialBalance.diagnostics.unbalancedJournals"),
      count: d.unbalancedJournals.length,
      render: () => (
        <ul className="list-disc pe-4">
          {d.unbalancedJournals.map((j) => (
            <li key={j.id}>
              {j.journalNumber} ({formatDate(j.journalDate)}) — {t("accounting.trialBalance.diagnostics.debit")}{" "}
              <Num value={j.totalDebit} /> — {t("accounting.trialBalance.diagnostics.credit")}{" "}
              <Num value={j.totalCredit} />
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "headerLine",
      label: t("accounting.trialBalance.diagnostics.headerLineMismatches"),
      count: d.headerLineMismatches.length,
      render: () => (
        <ul className="list-disc pe-4">
          {d.headerLineMismatches.map((j) => (
            <li key={j.id}>
              {j.journalNumber} ({formatDate(j.journalDate)}) — {t("accounting.trialBalance.diagnostics.header")}{" "}
              <Num value={j.headerDebit} />/<Num value={j.headerCredit} /> —{" "}
              {t("accounting.trialBalance.diagnostics.lines")} <Num value={j.lineDebit} />/
              <Num value={j.lineCredit} />
            </li>
          ))}
        </ul>
      ),
    },
  ];
  const active = sections.filter((s) => s.count > 0);
  if (active.length === 0) return null;
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-xs text-slate-700">
      {active.map((s) => (
        <div key={s.key}>
          <p className="mb-1 font-extrabold text-rose-700">{s.label} ({s.count})</p>
          {s.render()}
        </div>
      ))}
      <p className="border-t border-rose-200 pt-2 text-slate-500">{d.note}</p>
      <p className="text-slate-400">
        {t("accounting.trialBalance.diagnostics.grossNote")} {t("accounting.common.debit")}{" "}
        <Num value={d.grossHistoricalMovement.debit} /> — {t("accounting.common.credit")}{" "}
        <Num value={d.grossHistoricalMovement.credit} />
      </p>
    </div>
  );
}
