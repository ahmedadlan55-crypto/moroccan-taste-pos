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
import { formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import type { AnalyticsFilters } from "../lib/filters";

export interface BasisOfPreparationProps {
  filters: AnalyticsFilters;
  /** The active query's freshness watermark, when the page has data. */
  watermark?: string | null;
  /** Scope labels already resolved by the caller (ids mean nothing on paper). */
  scope?: { brands?: string[]; branches?: string[]; channels?: string[]; orderTypes?: string[] };
}

export function BasisOfPreparation({ filters, watermark, scope }: BasisOfPreparationProps) {
  const t = useT();

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

    // Scope reads as "the whole company" when nothing is pinned — an ABSENT
    // line would leave the reader to assume it, and an assumption is exactly
    // what this block exists to remove.
    const named = [
      ...(scope?.brands ?? []),
      ...(scope?.branches ?? []),
      ...(scope?.channels ?? []),
      ...(scope?.orderTypes ?? []),
    ];
    out.push({
      term: t("salesReports.basis.scope"),
      value: named.length ? named.join("، ") : t("salesReports.basis.scopeAll"),
    });

    out.push({ term: t("salesReports.basis.treatment"), value: t("salesReports.basis.treatmentBody") });

    if (watermark) {
      out.push({ term: t("salesReports.basis.dataAsOf"), value: formatDateTime(watermark) });
    }
    return out;
  }, [filters, watermark, scope, t]);

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
