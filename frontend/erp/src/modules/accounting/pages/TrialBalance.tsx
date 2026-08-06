import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, ChevronDown, ChevronLeft, ChevronsDownUp, ChevronsUpDown, Download, Search } from "lucide-react";
import { Button, DatePicker, Input, PrintDocument, Select, Toggle } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
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
  ReportState,
  exportRowsCsv,
  useAppliedFilter,
  printReport,
} from "../components";

interface FlatRow extends TrialBalanceRow {
  depth: number;
}

interface TreeViewOptions {
  collapsed: Set<string>;
  search: string;
  maxLevel: number | null;
  hideZero: boolean;
}

const ZERO = 0.005;

function normalizeSearch(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
}

function isZeroRow(row: TrialBalanceRow): boolean {
  return [row.openDebit, row.openCredit, row.periodDebit, row.periodCredit, row.closeDebit, row.closeCredit]
    .every((value) => Math.abs(Number(value) || 0) < ZERO);
}

function isMainRow(row: TrialBalanceRow): boolean {
  return row.isFolder || row.hasChildren;
}

function buildTree(rows: TrialBalanceRow[], options: TreeViewOptions): { flat: FlatRow[]; roots: TrialBalanceRow[] } {
  const ids = new Set(rows.map((r) => r.accountId));
  const rowById = new Map(rows.map((r) => [r.accountId, r]));
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
  const query = normalizeSearch(options.search);
  const directMatch = new Set(
    rows
      .filter((r) => {
        if (options.maxLevel != null && r.level > options.maxLevel) return false;
        // Retired skeleton rows with no accounting footprint add noise but no
        // audit value. Archived accounts that DO carry an opening, movement or
        // closing figure remain visible regardless of the hide-zero toggle.
        if (!r.isActive && isZeroRow(r)) return false;
        if (options.hideZero && isZeroRow(r)) return false;
        if (!query) return true;
        return normalizeSearch(`${r.code} ${r.nameAr} ${r.nameEn || ""}`).includes(query);
      })
      .map((r) => r.accountId),
  );

  // Keep ancestors of a matching row so search/hide-zero never tears a leaf
  // away from the hierarchy that gives the account its accounting meaning.
  const included = new Set(directMatch);
  for (const id of directMatch) {
    let cursor = rowById.get(id)?.parentId ?? null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      included.add(cursor);
      cursor = rowById.get(cursor)?.parentId ?? null;
    }
  }
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
    if (!included.has(r.accountId)) return;
    flat.push({ ...r, depth });
    if (!query && options.collapsed.has(r.accountId)) return;
    (childrenOf.get(r.accountId) ?? []).forEach((c) => visit(c, depth + 1));
  };
  roots.forEach((r) => visit(r, 0));
  rows.forEach((r) => visit(r, 0));
  return { flat, roots };
}

export function TrialBalancePage() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const filter = useAppliedFilter<DateRange>({ from: startOfYearISO(), to: todayISO() });
  const query = useTrialBalance(filter.applied);
  const [search, setSearch] = useState("");
  const [maxLevel, setMaxLevel] = useState<number | null>(3);
  const [hideZero, setHideZero] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Tier A.1 corrective gate: this used to recompute the footer totals by
  // summing root-level rows client-side (`roots.reduce(...)`), which not
  // only duplicated logic the server already computed correctly, but was
  // ALSO WRONG the moment the tree had more than one meaningful depth of
  // rollup or any non-leaf posting activity — the server's totals come from
  // a tree-independent raw-ledger sum (see lib/reports/trialBalance.js) and
  // the two numbers are not guaranteed to agree. `buildTree` below is used
  // ONLY to order/indent rows for display — never to derive a total.
  const rows = query.data?.rows ?? [];
  const flat = useMemo(
    () => buildTree(rows, { collapsed, search, maxLevel, hideZero }).flat,
    [rows, collapsed, search, maxLevel, hideZero],
  );
  // Printing/exporting must never inherit a transient collapse state. A
  // collapsed branch is a screen-navigation preference, not an accounting
  // filter, so paper/CSV always receives the complete filtered hierarchy.
  const outputFlat = useMemo(
    () => buildTree(rows, { collapsed: new Set<string>(), search, maxLevel, hideZero }).flat,
    [rows, search, maxLevel, hideZero],
  );
  const visibleIds = useMemo(() => new Set(flat.map((row) => row.accountId)), [flat]);
  const totals = query.data?.totals;
  const diagnostics = query.data?.diagnostics;
  const isClean = query.data?.isClean;

  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;
  const levels = useMemo(
    () => [...new Set(rows.map((r) => r.level))].sort((a, b) => a - b),
    [rows],
  );
  const rowName = (row: TrialBalanceRow) =>
    lang === "en" ? row.nameEn || row.nameAr : row.nameAr || row.nameEn || row.code;
  const viewRestricted = !!search.trim() || maxLevel != null || hideZero || collapsed.size > 0;

  const openLedger = (row: TrialBalanceRow) => {
    const params = new URLSearchParams();
    params.set(isMainRow(row) ? "parentId" : "accountId", row.accountId);
    params.set("from", filter.applied.from);
    params.set("to", filter.applied.to);
    navigate(`/accounting/general-ledger?${params.toString()}`);
  };

  const exportCsv = () => {
    const header = [
      t("accounting.coa.col.code"),
      t("accounting.coa.form.nameAr"),
      t("accounting.coa.form.nameEn"),
      t("accounting.coa.col.level"),
      t("accounting.coa.col.kind"),
      `${t("accounting.trialBalance.openingCol")} - ${t("accounting.common.debit")}`,
      `${t("accounting.trialBalance.openingCol")} - ${t("accounting.common.credit")}`,
      `${t("accounting.trialBalance.periodCol")} - ${t("accounting.common.debit")}`,
      `${t("accounting.trialBalance.periodCol")} - ${t("accounting.common.credit")}`,
      `${t("accounting.trialBalance.closingCol")} - ${t("accounting.common.debit")}`,
      `${t("accounting.trialBalance.closingCol")} - ${t("accounting.common.credit")}`,
    ];
    exportRowsCsv(
      `trial-balance-${filter.applied.from}-${filter.applied.to}.csv`,
      header,
      outputFlat.map((row) => [
        row.code,
        row.nameAr,
        row.nameEn || "",
        row.level,
        t(isMainRow(row) ? "accounting.coa.kpi.control" : "accounting.coa.kpi.posting"),
        row.openDebit,
        row.openCredit,
        row.periodDebit,
        row.periodCredit,
        row.closeDebit,
        row.closeCredit,
      ]),
    );
  };

  const toggleRow = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <ReportHeader
        title={t("accounting.trialBalance.title")}
        subtitle={t("accounting.trialBalance.subtitle")}
        onPrint={printReport}
        extraActions={
          <Button variant="secondary" onClick={exportCsv} disabled={outputFlat.length === 0}>
            <Download className="h-4 w-4" /> {t("table.exportCsv")}
          </Button>
        }
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
      </FilterCard>

      {rows.length > 0 && (
        <div className="no-print mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="grid gap-3 md:grid-cols-[minmax(16rem,1fr)_12rem_auto] xl:grid-cols-[minmax(20rem,1fr)_12rem_auto_auto_auto] xl:items-end">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("accounting.trialBalance.searchPlaceholder")}
              aria-label={t("accounting.trialBalance.searchPlaceholder")}
              leading={<Search className="h-4 w-4" />}
            />
            <Select
              value={maxLevel == null ? "all" : String(maxLevel)}
              aria-label={t("accounting.trialBalance.maxLevel")}
              onChange={(e) => setMaxLevel(e.target.value === "all" ? null : Number(e.target.value))}
            >
              <option value="all">{t("accounting.trialBalance.allLevels")}</option>
              {levels.map((level) => (
                <option key={level} value={level}>
                  {t("accounting.trialBalance.upToLevel", { level })}
                </option>
              ))}
            </Select>
            <label className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-700">
              <Toggle
                checked={hideZero}
                onChange={setHideZero}
                aria-label={t("accounting.trialBalance.hideZero")}
              />
              {t("accounting.trialBalance.hideZero")}
            </label>
            <Button
              variant="secondary"
              onClick={() => setCollapsed(new Set(rows.filter((r) => r.hasChildren).map((r) => r.accountId)))}
            >
              <ChevronsDownUp className="h-4 w-4" /> {t("accounting.coa.collapseAll")}
            </Button>
            <Button variant="secondary" onClick={() => setCollapsed(new Set())}>
              <ChevronsUpDown className="h-4 w-4" /> {t("accounting.coa.expandAll")}
            </Button>
          </div>
          <p className="mt-2 text-xs font-bold text-slate-500">
            {t("accounting.trialBalance.shownOf", { shown: flat.length, total: rows.length })}
          </p>
        </div>
      )}

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => query.refetch()}
      >
        <PrintDocument
          title={t("accounting.trialBalance.title")}
          subtitle={period}
          meta={t("accounting.generalLedger.postedOnly")}
          className="print-landscape print-long-report print-single-total"
        >
          <div className="surface p-4">
            {viewRestricted && (
              <p className="mb-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs font-bold leading-5 text-blue-900">
                {t("accounting.trialBalance.filteredTotalsNotice", {
                  shown: flat.length,
                  total: rows.length,
                })}
              </p>
            )}
            {flat.length === 0 && rows.length > 0 && (
              <p className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-5 text-center text-sm font-bold text-slate-600">
                {t("accounting.trialBalance.noFilterMatch")}
              </p>
            )}
            <div className="hidden overflow-x-auto xl:block print:block">
            <table className="w-full min-w-[58rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-extrabold text-slate-500">
                  <th rowSpan={2} className="w-28 px-3 py-2 text-start">{t("accounting.coa.col.code")}</th>
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
                {outputFlat.map((r) => {
                  const main = isMainRow(r);
                  const visible = visibleIds.has(r.accountId);
                  return (
                  <tr
                    key={r.accountId}
                    data-account-kind={main ? "main" : "posting"}
                    className={`${visible ? "" : "hidden print:table-row"} border-b border-slate-100 last:border-0 ${
                      main ? "bg-blue-50/70 hover:bg-blue-50" : "bg-white hover:bg-slate-50/70"
                    }`}
                  >
                    <td className="px-3 py-2 text-start">
                      <code dir="ltr" className={`text-xs font-bold tabular-nums ${main ? "text-blue-700" : "text-slate-500"}`}>
                        {r.code}
                      </code>
                    </td>
                    <td className="px-3 py-2" style={{ paddingInlineStart: 12 + r.depth * 22 }}>
                      <span className="inline-flex items-center gap-2">
                        {r.hasChildren ? (
                          <button
                            type="button"
                            className="no-print grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
                            aria-label={collapsed.has(r.accountId) ? t("accounting.coa.expand") : t("accounting.coa.collapse")}
                            onClick={() => toggleRow(r.accountId)}
                          >
                            {collapsed.has(r.accountId) ? (
                              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                          </button>
                        ) : (
                          <span className="no-print inline-block h-7 w-7" />
                        )}
                        <button
                          type="button"
                          onClick={() => navigate(`/accounting/chart-of-accounts/${encodeURIComponent(r.accountId)}`)}
                          className={`${main ? "font-extrabold text-blue-900" : "font-semibold text-slate-800"} text-start hover:text-teal-700 hover:underline`}
                        >
                          {rowName(r)}
                        </button>
                        {main && (
                          <span className="rounded-md border border-blue-200 bg-white/80 px-1.5 py-0.5 text-[10px] font-bold text-blue-800">
                            {t("accounting.coa.kpi.control")}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openLedger(r)}
                          className="no-print inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-bold text-teal-700 hover:bg-teal-50"
                          aria-label={t("accounting.trialBalance.openLedgerFor", { account: rowName(r) })}
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                          <span className="hidden xl:inline">{t("accounting.trialBalance.openLedger")}</span>
                        </button>
                      </span>
                    </td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.openDebit} strong={main} /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.openCredit} strong={main} /></td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.periodDebit} strong={main} /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.periodCredit} strong={main} /></td>
                    <td className="border-r border-slate-100 px-3 py-2 text-left"><Num value={r.closeDebit} strong /></td>
                    <td className="px-3 py-2 text-left"><Num value={r.closeCredit} strong /></td>
                  </tr>
                  );
                })}
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
                    <td colSpan={2} className="px-3 py-2.5 text-right">
                      {viewRestricted
                        ? t("accounting.trialBalance.fullScopeTotal")
                        : t("accounting.common.total")}
                    </td>
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
            </div>

            <div className="grid gap-3 xl:hidden print:hidden">
              {flat.map((r) => (
                <article
                  key={r.accountId}
                  className={`rounded-2xl border p-3 shadow-sm ${
                    isMainRow(r) ? "border-blue-200 bg-blue-50/70" : "border-slate-200 bg-white"
                  }`}
                  aria-label={t("accounting.trialBalance.mobileAccountLevel", {
                    account: rowName(r),
                    level: r.level,
                  })}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => navigate(`/accounting/chart-of-accounts/${encodeURIComponent(r.accountId)}`)}
                      className="min-w-0 text-start"
                    >
                      <span className={`block truncate text-sm font-extrabold ${isMainRow(r) ? "text-blue-900" : "text-slate-900"}`}>
                        {rowName(r)}
                      </span>
                      <code dir="ltr" className={`text-[11px] ${isMainRow(r) ? "text-blue-700" : "text-slate-500"}`}>
                        {r.code}
                      </code>
                      <span className="ms-2 text-[10px] font-bold text-slate-400">
                        {t("accounting.trialBalance.level", { level: r.level })}
                      </span>
                    </button>
                    {r.hasChildren && (
                      <button
                        type="button"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-600"
                        aria-label={collapsed.has(r.accountId) ? t("accounting.coa.expand") : t("accounting.coa.collapse")}
                        onClick={() => toggleRow(r.accountId)}
                      >
                        {collapsed.has(r.accountId) ? <ChevronLeft className="h-4 w-4 rtl:rotate-180" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openLedger(r)}
                    className="no-print mb-2 inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-teal-50 px-3 text-xs font-bold text-teal-700"
                  >
                    <BookOpen className="h-4 w-4" /> {t("accounting.trialBalance.openLedger")}
                  </button>
                  {[
                    [t("accounting.trialBalance.openingCol"), r.openDebit, r.openCredit],
                    [t("accounting.trialBalance.periodCol"), r.periodDebit, r.periodCredit],
                    [t("accounting.trialBalance.closingCol"), r.closeDebit, r.closeCredit],
                  ].map(([label, debit, credit]) => (
                    <div key={String(label)} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-t border-slate-100 py-2 text-xs">
                      <span className="font-bold text-slate-500">{label}</span>
                      <span className="min-w-20 text-end"><span className="block text-[10px] text-slate-400">{t("accounting.common.debit")}</span><Num value={Number(debit)} /></span>
                      <span className="min-w-20 text-end"><span className="block text-[10px] text-slate-400">{t("accounting.common.credit")}</span><Num value={Number(credit)} /></span>
                    </div>
                  ))}
                </article>
              ))}
            </div>
            {totals && <BalanceStatus totals={totals} isClean={isClean} diagnostics={diagnostics} />}
          </div>
        </PrintDocument>
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
