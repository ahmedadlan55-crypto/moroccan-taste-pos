import { useMemo, useState } from "react";
import { DatePicker, Input, Select } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useT } from "@/i18n";
import { useGlLedger, startOfYearISO, todayISO, type GlAccountKind, type GlSection } from "../api";
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
  /** main = root accounts · sub = accounts with a parent · both = everything. */
  accType: GlAccountKind;
}

/**
 * Account search. Deliberately CLIENT-side over the already-fetched sections
 * rather than a server round-trip: the ledger response is one payload for the
 * whole period, so filtering it in the browser is instant and — more
 * importantly — searching must NEVER re-run the query and silently change the
 * opening balances or the grand totals underneath the operator. The server
 * decides WHICH accounts are in scope; the search box decides which of them
 * are on screen, and the header says so.
 *
 * Matches on code or Arabic name, accent-insensitively for the alef/hamza and
 * taa-marbuta variants an Arabic keyboard produces (بضاعه vs بضاعة, احمد vs
 * أحمد), because an owner types what he hears, not what was stored.
 */
function normalizeAr(s: string): string {
  return String(s || "")
    .replace(/[ً-ْٰ]/g, "")   // harakat
    .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ → ا
    .replace(/ى/g, "ي")            // ى → ي
    .replace(/ة/g, "ه")            // ة → ه
    .replace(/ـ/g, "")                  // tatweel
    .toLowerCase()
    .trim();
}

function matchesSearch(s: GlSection, needle: string): boolean {
  if (!needle) return true;
  const q = normalizeAr(needle);
  return normalizeAr(s.code).includes(q) || normalizeAr(s.nameAr).includes(q);
}

function AccountSection({ s }: { s: GlSection }) {
  const t = useT();
  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <code className="rounded bg-white px-2 py-0.5 text-xs font-bold text-teal-700">{s.code}</code>
          <span className="text-sm font-extrabold text-slate-900">{s.nameAr}</span>
        </div>
        <div className="flex items-center gap-4 text-xs font-bold text-slate-500">
          <span>{t("accounting.common.opening")}: <Num value={s.opening} signed /></span>
          <span>{t("accounting.common.closing")}: <Num value={s.closingBalance} signed strong /></span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-right">{t("accounting.common.date")}</th>
              <th className="px-3 py-2 text-right">{t("accounting.common.journalNo")}</th>
              <th className="px-3 py-2 text-right">{t("accounting.common.statement")}</th>
              <th className="px-3 py-2 text-left">{t("accounting.common.debit")}</th>
              <th className="px-3 py-2 text-left">{t("accounting.common.credit")}</th>
              <th className="px-3 py-2 text-left">{t("accounting.common.balance")}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-50 bg-slate-50/40 text-xs font-bold text-slate-500">
              <td className="px-3 py-1.5" colSpan={5}>{t("accounting.generalLedger.openingBalance")}</td>
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
              <td className="px-3 py-2" colSpan={3}>{t("accounting.generalLedger.totalMovements", { count: s.lineCount })}</td>
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
  const t = useT();
  const filter = useAppliedFilter<GlFilter>({
    from: startOfYearISO(), to: todayISO(), scope: "active", accType: "both",
  });
  const query = useGlLedger(filter.applied, filter.applied.scope, filter.applied.accType);
  const data = query.data;
  const period = `${formatDate(filter.applied.from)} — ${formatDate(filter.applied.to)}`;
  const allSections = data?.sections ?? [];

  // Search applies to the fetched result, not the query — see matchesSearch.
  // It is intentionally OUTSIDE useAppliedFilter (no "run" button): typing
  // should narrow the list as you type, not require a round-trip.
  const [search, setSearch] = useState("");
  const sections = useMemo(
    () => allSections.filter((s) => matchesSearch(s, search)),
    [allSections, search],
  );
  const hidden = allSections.length - sections.length;

  return (
    <div>
      <ReportHeader
        title={t("accounting.generalLedger.title")}
        subtitle={t("accounting.generalLedger.subtitle")}
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label={t("accounting.common.fromDate")}>
          <DatePicker value={filter.draft.from} onChange={(from) => filter.patch({ from })} />
        </FilterField>
        <FilterField label={t("accounting.common.toDate")}>
          <DatePicker value={filter.draft.to} onChange={(to) => filter.patch({ to })} />
        </FilterField>
        <FilterField label={t("accounting.report.scope")}>
          <Select
            value={filter.draft.scope}
            onChange={(e) => filter.patch({ scope: e.target.value })}
            options={[
              { value: "active", label: t("accounting.generalLedger.scope.active") },
              { value: "leaf", label: t("accounting.generalLedger.scope.leaf") },
              { value: "all", label: t("accounting.generalLedger.scope.all") },
            ]}
          />
        </FilterField>
        {/* Account category. The server has always honoured `accType`; the UI
            simply never sent anything but "both". */}
        <FilterField label={t("accounting.generalLedger.accType.label")}>
          <Select
            value={filter.draft.accType}
            onChange={(e) => filter.patch({ accType: e.target.value as GlAccountKind })}
            options={[
              { value: "both", label: t("accounting.generalLedger.accType.both") },
              { value: "main", label: t("accounting.generalLedger.accType.main") },
              { value: "sub", label: t("accounting.generalLedger.accType.sub") },
            ]}
          />
        </FilterField>
      </FilterCard>

      {/* Search sits OUTSIDE the filter card on purpose: it narrows what is
          already on screen and must never re-run the query, because a refetch
          would move the opening balances and grand totals under the operator
          mid-read. */}
      {allSections.length > 0 && (
        <div className="no-print mb-4 flex flex-wrap items-center gap-3">
          <Input
            className="w-full sm:w-80"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("accounting.generalLedger.searchPlaceholder")}
            aria-label={t("accounting.generalLedger.searchPlaceholder")}
          />
          <span className="text-xs font-bold text-slate-500">
            {t("accounting.generalLedger.shownOf", {
              shown: String(sections.length),
              total: String(allSections.length),
            })}
          </span>
          {search && (
            <button type="button" className="text-xs font-bold text-teal-700 underline"
              onClick={() => setSearch("")}>
              {t("accounting.generalLedger.clearSearch")}
            </button>
          )}
        </div>
      )}

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={allSections.length === 0}
        onRetry={() => query.refetch()}
        emptyBody={t("accounting.generalLedger.empty")}
      >
        <PrintArea>
          <div className="surface mb-5 p-4">
            <PrintBanner title={t("accounting.generalLedger.title")} period={period} />
            {data && (
              <div className="flex flex-wrap gap-4 text-xs font-bold text-slate-600">
                <span>{t("accounting.generalLedger.accountCount")} {data.grandTotals.accountCount}</span>
                <span>{t("accounting.generalLedger.lineCount")} {data.grandTotals.lineCount}</span>
                <span>{t("accounting.generalLedger.totalDebit")} <Num value={data.grandTotals.debit} /></span>
                <span>{t("accounting.generalLedger.totalCredit")} <Num value={data.grandTotals.credit} /></span>
              </div>
            )}
            {/* The grand totals above are the SERVER's, for the full scope.
                When a search is narrowing the view, say so on the page and on
                the printout — a printed ledger whose sections do not add up to
                its own header is worse than no header at all. */}
            {hidden > 0 && (
              <p className="mt-2 text-xs font-bold text-amber-700">
                {t("accounting.generalLedger.filteredNotice", { hidden: String(hidden) })}
              </p>
            )}
          </div>

          {sections.length === 0 && (
            <div className="surface p-6 text-center text-sm font-bold text-slate-500">
              {t("accounting.generalLedger.noSearchMatch")}
            </div>
          )}
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
