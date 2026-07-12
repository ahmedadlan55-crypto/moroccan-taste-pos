import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader, EmptyState } from "@/shared/ui";
import type { ReportSection } from "../reportLinks";

// A hub landing page: a grid of cards, each linking to a canonical report route
// owned by another module. The Reports center never re-implements those pages.
export default function ReportsHub({ section }: { section: ReportSection }) {
  return (
    <div>
      <PageHeader eyebrow="التقارير" title={section.title} subtitle={section.subtitle} />
      {section.links.length === 0 ? (
        <EmptyState title="لا توجد تقارير في هذا القسم بعد" />
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
                    <span className="text-sm font-extrabold text-slate-900">{link.label}</span>
                    <ArrowLeft className="h-4 w-4 text-slate-300 transition group-hover:text-teal-600" />
                  </div>
                  <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{link.description}</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
