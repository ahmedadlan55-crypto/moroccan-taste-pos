import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/shared/ui";
import { useT, useLang } from "@/i18n";
import type { ReportSection } from "../reportLinks";

// A hub landing page: a grid of cards, each linking to a canonical report route
// owned by another module. The Reports center never re-implements those pages.
// `section.title` / `link.label` etc. hold i18n key paths (see reportLinks.tsx).
export default function ReportsHub({ section }: { section: ReportSection }) {
  const t = useT();
  const lang = useLang();
  // The card "go" chevron points along the reading direction: start→end.
  const GoArrow = lang === "ar" ? ArrowLeft : ArrowRight;
  return (
    <div>
      <PageHeader eyebrow={t("misc.reports.eyebrow")} title={t(section.title)} subtitle={t(section.subtitle)} />
      {section.links.length === 0 ? (
        <EmptyState title={t("misc.reports.emptyTitle")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {section.links.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.to}
                to={link.to}
                className="surface group flex items-start gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-lift focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-extrabold text-slate-900">{t(link.label)}</span>
                    <GoArrow className="h-4 w-4 text-slate-300 transition group-hover:text-teal-600" />
                  </div>
                  <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{t(link.description)}</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
