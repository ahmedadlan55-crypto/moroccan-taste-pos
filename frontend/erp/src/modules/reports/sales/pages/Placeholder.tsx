// Sales Analytics Hub — the temporary generic page body used by ALL 16 tabs
// this wave. Renders the segment's title plus a healthy data-state="empty"
// EmptyState (via the shared EmptyState) so the nav/closure smoke passes — the
// real pages land next wave and replace this per segment.
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/shared/ui";
import { useT } from "@/i18n";

export default function Placeholder({ segment }: { segment: string }) {
  const t = useT();
  return (
    <section aria-labelledby={`sales-hub-page-${segment}`}>
      <div className="mb-4">
        <h2 id={`sales-hub-page-${segment}`} className="text-lg font-extrabold text-slate-900">
          {t(`salesReports.pages.${segment}.title`)}
        </h2>
        <p className="mt-0.5 text-sm font-medium text-slate-500">
          {t(`salesReports.pages.${segment}.subtitle`)}
        </p>
      </div>
      <EmptyState
        icon={<BarChart3 className="h-6 w-6" />}
        title={t("salesReports.placeholder.title")}
        body={t("salesReports.placeholder.body")}
      />
    </section>
  );
}
