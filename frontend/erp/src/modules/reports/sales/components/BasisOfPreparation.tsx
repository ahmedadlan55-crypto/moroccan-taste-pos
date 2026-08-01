// Sales Analytics Hub — the basis of preparation, printed with every report.
//
// WHY THIS IS NOT DECORATION
//   Every number in this hub is conditional on choices that live in the filter
//   bar and nowhere else: business day vs calendar day, tax-inclusive vs
//   ex-VAT, which brands and branches, which channel. The filter bar is
//   `.no-print`, so a printed report carried NONE of that. Two printouts of
//   "sales, July" could differ by a full day's takings — the business day runs
//   past midnight — and nothing on either page said which one you were holding.
//   An auditor cannot accept a figure whose basis is not stated on the same
//   page as the figure.
//
//   The treatments below are not preferences either. They are what the engine
//   actually does, and a reader who assumes otherwise reads the report wrong:
//     • voided orders are excluded from every population (planner.js:356)
//     • returns are netted within the period they were RECORDED, not the period
//       of the original sale
//     • cost is the at-sale snapshot, never today's cost — so re-running last
//       month's profit next year gives the same answer
//
// It renders on screen too (collapsed to one line), because the same reader
// checking a number on screen has the same question.
import { useMemo } from "react";
import { formatDateTime, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import type { AnalyticsFilters } from "../lib/filters";
import { useListSeparator } from "../lib/listSeparator";

export interface BasisOfPreparationProps {
  filters: AnalyticsFilters;
  /** The active query's freshness watermark, when the page has data. */
  watermark?: string | null;
}

/**
 * Scope dimensions, in the order the filter bar presents them. Read from
 * `filters` DIRECTLY — an earlier version took the scope as an optional prop,
 * the hub never passed it, and the block confidently printed "All brands,
 * branches, channels and order types" on a report filtered to one branch. A
 * disclosure that can be wrong because a caller forgot a prop is a worse
 * design than no disclosure: it converts an open question into a confident
 * false answer, on a document someone files.
 */
const SCOPE_KEYS = [
  { key: "brandId", label: "salesReports.topbar.brand" },
  { key: "branchId", label: "salesReports.topbar.branch" },
  { key: "channel", label: "salesReports.topbar.channel" },
  { key: "orderType", label: "salesReports.topbar.orderType" },
  { key: "paymentMethod", label: "salesReports.dims.payment_method" },
  { key: "menuItemId", label: "salesReports.dims.menu_item" },
  { key: "categoryId", label: "salesReports.dims.category" },
  { key: "cashierId", label: "salesReports.dims.cashier" },
] as const;

export function BasisOfPreparation({ filters, watermark }: BasisOfPreparationProps) {
  const t = useT();
  const listSeparator = useListSeparator();

  const lines = useMemo(() => {
    const out: Array<{ term: string; value: string }> = [
      { term: t("salesReports.basis.period"), value: `${filters.from} — ${filters.to}` },
      {
        term: t("salesReports.basis.dateBasis"),
        value: filters.businessDay
          ? t("salesReports.basis.dateBasisBusiness")
          : t("salesReports.basis.dateBasisCalendar"),
      },
      {
        term: t("salesReports.basis.taxBasis"),
        value: filters.taxIncl ? t("salesReports.basis.taxBasisIncl") : t("salesReports.basis.taxBasisExcl"),
      },
    ];

    // Scope reads as "the whole company" ONLY when nothing is pinned. Counts,
    // not names: the filter values are ids, and the block must never resolve
    // them with a second round-trip that could fail and silently turn a
    // filtered report back into "all". "Branch: 1 selected" is less pleasant
    // than "Branch: Riyadh" and it is never wrong.
    const pinned = SCOPE_KEYS.map(({ key, label }) => {
      const v = (filters as unknown as Record<string, unknown>)[key];
      const n = Array.isArray(v) ? v.length : v ? 1 : 0;
      return n > 0 ? `${t(label)}: ${formatNumber(n)}` : null;
    }).filter(Boolean) as string[];
    if (filters.hour) pinned.push(`${t("salesReports.dims.hour")}: ${filters.hour}`);

    out.push({
      term: t("salesReports.basis.scope"),
      value: pinned.length ? pinned.join(listSeparator) : t("salesReports.basis.scopeAll"),
    });

    out.push({ term: t("salesReports.basis.treatment"), value: t("salesReports.basis.treatmentBody") });

    if (watermark) {
      out.push({ term: t("salesReports.basis.dataAsOf"), value: formatDateTime(watermark) });
    }
    return out;
  }, [filters, watermark, listSeparator, t]);

  return (
    <section
      data-testid="basis-of-preparation"
      // print:block — the screen keeps it compact at the foot of the report;
      // on paper it is a full block, because paper has no tooltip.
      className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-[11px] leading-relaxed text-slate-500"
      aria-label={t("salesReports.basis.title")}
    >
      <h2 className="mb-1 text-[11px] font-extrabold text-slate-600">{t("salesReports.basis.title")}</h2>
      <dl className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
        {lines.map((l) => (
          <div key={l.term} className="flex flex-wrap gap-1.5">
            <dt className="shrink-0 font-bold text-slate-500">{l.term}:</dt>
            <dd className="min-w-0 text-slate-500">{l.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
