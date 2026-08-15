import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { Badge, Button, DatePicker, Input, PrintDocument, Select } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import {
  useGlLedger,
  useStatementSections,
  startOfYearISO,
  todayISO,
  type GlAccountKind,
  type GlSection,
  type StatementSection,
} from "../api";
import {
  Num,
  ReportHeader,
  FilterCard,
  FilterField,
  ReportState,
  useAppliedFilter,
  printReport,
  exportRowsCsv,
} from "../components";

interface GlFilter {
  from: string;
  to: string;
  scope: string;
  /** main = root accounts · sub = accounts with a parent · both = everything. */
  accType: GlAccountKind;
  addedBy: string;
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
  return [s.code, s.nameAr, s.nameEn, s.reportSection ?? ""]
    .some((value) => normalizeAr(value).includes(q));
}

const SECTION_ALIASES: Record<string, string> = {
  vat_input: "input_vat",
  vat_output: "output_vat",
  prepaid: "prepayments",
  customer_deposits: "customer_advances",
  retained: "retained_earnings",
};

function sectionLabel(
  id: string | null,
  catalog: StatementSection[],
  lang: "ar" | "en",
): string | null {
  if (!id) return null;
  const canonical = SECTION_ALIASES[id] || id;
  const section = catalog.find((item) => item.id === canonical);
  return section ? (lang === "en" ? section.nameEn : section.nameAr) : null;
}

function AccountSection({
  s,
  lang,
  catalog,
}: {
  s: GlSection;
  lang: "ar" | "en";
  catalog: StatementSection[];
}) {
  const t = useT();
  const primaryName = lang === "en" && s.nameEn ? s.nameEn : s.nameAr;
  const secondaryName = lang === "en" ? s.nameAr : s.nameEn;
  const statementSection = sectionLabel(s.reportSection, catalog, lang);
  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="rounded bg-white px-2 py-0.5 text-xs font-bold text-teal-700">{s.code}</code>
          <div className="min-w-0">
            <Link
              to={`/accounting/chart-of-accounts/${encodeURIComponent(s.accountId)}`}
              className="block truncate text-sm font-extrabold text-slate-900 hover:text-teal-700 hover:underline"
            >
              {primaryName}
            </Link>
            {secondaryName && secondaryName !== primaryName && (
              <span className="block truncate text-[11px] font-semibold text-slate-500" dir={lang === "en" ? "rtl" : "ltr"}>
                {secondaryName}
              </span>
            )}
          </div>
          <Badge tone="neutral">{t("accounting.generalLedger.level", { level: String(s.level) })}</Badge>
          {statementSection && <Badge tone="info">{statementSection}</Badge>}
          {s.isContra && <Badge tone="warning">{t("accounting.generalLedger.contra")}</Badge>}
          {!s.isActive && <Badge tone="neutral">{t("accounting.generalLedger.archived")}</Badge>}
        </div>
        <div className="flex items-center gap-4 text-xs font-bold text-slate-500">
          <span>{t("accounting.common.opening")}: <Num value={s.opening} signed /></span>
          <span>{t("accounting.common.closing")}: <Num value={s.closingBalance} signed strong /></span>
        </div>
      </div>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
              <th className="px-3 py-2 text-start">{t("accounting.common.date")}</th>
              <th className="px-3 py-2 text-start">{t("accounting.common.journalNo")}</th>
              <th className="px-3 py-2 text-start">{t("accounting.common.statement")}</th>
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
                <td className="px-3 py-1.5"><code className="text-[11px] font-bold text-teal-700">{l.journalNumber}</code></td>
                <td className="px-3 py-1.5 text-slate-700">
                  <span className="block">{l.description || "—"}</span>
                  {(l.referenceType || l.referenceId) && (
                    <span className="mt-0.5 block text-[10px] font-semibold text-slate-400" dir="ltr">
                      {[l.referenceType, l.referenceId].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </td>
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
      <div className="divide-y divide-slate-100 sm:hidden">
        <div className="grid grid-cols-2 gap-2 bg-slate-50/50 px-4 py-3 text-xs font-bold text-slate-600">
          <span>{t("accounting.generalLedger.openingBalance")}</span>
          <span className="text-left"><Num value={s.opening} signed /></span>
        </div>
        {s.lines.map((line) => (
          <article key={line.id} className="space-y-3 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <code className="text-xs font-extrabold text-teal-700">{line.journalNumber}</code>
                <p className="mt-1 truncate text-sm font-bold text-slate-800">{line.description || "—"}</p>
              </div>
              <time className="shrink-0 text-xs font-semibold tabular-nums text-slate-500" dir="ltr">
                {formatDate(line.date)}
              </time>
            </div>
            {(line.referenceType || line.referenceId) && (
              <p className="text-[11px] font-semibold text-slate-400" dir="ltr">
                {[line.referenceType, line.referenceId].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div><span className="block text-slate-400">{t("accounting.common.debit")}</span><Num value={line.debit} /></div>
              <div><span className="block text-slate-400">{t("accounting.common.credit")}</span><Num value={line.credit} /></div>
              <div><span className="block text-slate-400">{t("accounting.common.balance")}</span><Num value={line.runningBalance} signed strong /></div>
            </div>
          </article>
        ))}
        <div className="grid grid-cols-2 gap-2 bg-slate-50 px-4 py-3 text-xs font-extrabold">
          <span>{t("accounting.generalLedger.totalMovements", { count: s.lineCount })}</span>
          <span className="text-left"><Num value={s.closingBalance} signed strong /></span>
        </div>
      </div>
    </div>
  );
}

export function GeneralLedgerPage() {
  const t = useT();
  const lang = useLang();
  const [searchParams] = useSearchParams();
  const dateParam = (key: string, fallback: string) => {
    const value = searchParams.get(key) || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
  };
  const accountId = (searchParams.get("accountId") || "").trim();
  const parentId = (searchParams.get("parentId") || "").trim();
  const filter = useAppliedFilter<GlFilter>({
    from: dateParam("from", startOfYearISO()),
    to: dateParam("to", todayISO()),
    scope: "active",
    accType: "both",
    addedBy: "",
  });
  const statementSections = useStatementSections();
  const query = useGlLedger(
    filter.applied,
    filter.applied.scope,
    filter.applied.accType,
    filter.applied.addedBy,
    accountId,
    parentId,
  );
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

  // Export the complete server result, not the client-side search subset and
  // not a rendered/paginated slice. Monetary cells stay numeric so Excel can
  // sum them; names/references remain ordinary text columns.
  const exportRows = useMemo<(string | number)[][]>(() =>
    allSections.flatMap((section) => {
      const account = [
        section.code,
        section.nameAr,
        section.nameEn,
        section.level,
        section.opening,
        section.totalDebit,
        section.totalCredit,
        section.closingBalance,
      ];
      if (section.lines.length === 0) {
        return [[...account, "", "", "", "", "", "", 0, 0, section.closingBalance]];
      }
      return section.lines.map((line) => [
        ...account,
        line.date,
        line.journalNumber,
        line.description,
        line.referenceType,
        line.referenceId,
        line.addedBy,
        line.debit,
        line.credit,
        line.runningBalance,
      ]);
    }), [allSections]);

  const onExport = () => exportRowsCsv(
    `general-ledger-${filter.applied.from}-${filter.applied.to}.csv`,
    [
      t("accounting.coa.col.code"),
      t("accounting.coa.form.nameAr"),
      t("accounting.coa.form.nameEn"),
      t("accounting.coa.col.level"),
      t("accounting.generalLedger.openingBalance"),
      t("accounting.generalLedger.totalDebit"),
      t("accounting.generalLedger.totalCredit"),
      t("accounting.common.closing"),
      t("accounting.common.date"),
      t("accounting.common.journalNo"),
      t("accounting.common.statement"),
      t("accounting.generalLedger.export.referenceType"),
      t("accounting.generalLedger.export.referenceId"),
      t("accounting.generalLedger.addedBy"),
      t("accounting.common.debit"),
      t("accounting.common.credit"),
      t("accounting.common.balance"),
    ],
    exportRows,
  );

  return (
    <div>
      <ReportHeader
        title={t("accounting.generalLedger.title")}
        subtitle={t("accounting.generalLedger.subtitle")}
        onPrint={printReport}
        extraActions={
          <Button variant="secondary" onClick={onExport} disabled={allSections.length === 0}>
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
        <FilterField label={t("accounting.generalLedger.addedBy")}>
          <Input
            value={filter.draft.addedBy}
            onChange={(e) => filter.patch({ addedBy: e.target.value })}
            placeholder={t("accounting.generalLedger.addedByPlaceholder")}
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
        <PrintDocument
          title={t("accounting.generalLedger.title")}
          subtitle={period}
          meta={parentId
            ? t("accounting.generalLedger.printScope.parent")
            : accountId
              ? t("accounting.generalLedger.printScope.single")
              : t("accounting.generalLedger.printScope.all")}
          className="print-landscape print-long-report"
        >
          <div className="surface mb-5 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone="success">{t("accounting.generalLedger.postedOnly")}</Badge>
              <Badge tone="neutral">{t("accounting.generalLedger.identityAccountId")}</Badge>
              {data?.pagination?.bounded && (
                <Badge tone="info">
                  {t("accounting.generalLedger.bounded", {
                    accounts: String(data.pagination.maxAccounts),
                    lines: String(data.pagination.maxLines),
                  })}
                </Badge>
              )}
              {accountId && (
                <>
                  <Badge tone="info">{t("accounting.generalLedger.singleAccountScope")}</Badge>
                  <Link
                    to="/reports/financial/general-ledger"
                    className="no-print text-xs font-bold text-teal-700 underline"
                  >
                    {t("accounting.generalLedger.clearAccountScope")}
                  </Link>
                </>
              )}
              {parentId && (
                <>
                  <Badge tone="info">{t("accounting.generalLedger.parentAccountScope")}</Badge>
                  <Link
                    to="/reports/financial/general-ledger"
                    className="no-print text-xs font-bold text-teal-700 underline"
                  >
                    {t("accounting.generalLedger.clearAccountScope")}
                  </Link>
                </>
              )}
            </div>
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
              <AccountSection
                key={s.accountId}
                s={s}
                lang={lang}
                catalog={statementSections.data ?? []}
              />
            ))}
          </div>
        </PrintDocument>
      </ReportState>
    </div>
  );
}
