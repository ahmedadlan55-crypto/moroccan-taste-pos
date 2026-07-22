import { Link } from "react-router-dom";
import { CheckCheck, ListTodo, RefreshCw, ArrowLeft, ArrowRight } from "lucide-react";
import { Button, LoadingState, EmptyState, PageHeader } from "@/shared/ui";
import { useT, useLang } from "@/i18n";
import { useDashboardOverview, KpiGrid, OpsGrid } from "../_common";

const QUICK_LINKS = [
  { to: "/overview/tasks", labelKey: "overview.tasks.title", descKey: "overview.home.quickTasksDesc", icon: ListTodo },
  { to: "/overview/approvals", labelKey: "overview.approvals.title", descKey: "overview.approvals.subtitle", icon: CheckCheck },
] as const;

export default function OverviewPage() {
  const t = useT();
  const lang = useLang();
  const query = useDashboardOverview();
  // Card "open" chevron follows the reading direction.
  const DirArrow = lang === "ar" ? ArrowLeft : ArrowRight;

  return (
    <div>
      <PageHeader
        eyebrow={t("overview.eyebrow")}
        title={t("overview.home.title")}
        subtitle={t("overview.home.subtitle")}
        action={
          <Button variant="secondary" onClick={() => query.refetch()} loading={query.isFetching}>
            <RefreshCw className="h-4 w-4" /> {t("states.refreshBtn")}
          </Button>
        }
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.error || !query.data ? (
        // Resilient: never crash the home screen — offer a retry.
        <EmptyState
          title={t("overview.home.loadErrorTitle")}
          body={t("overview.home.loadErrorBody")}
          action={
            <Button variant="secondary" onClick={() => query.refetch()}>
              <RefreshCw className="h-4 w-4" /> {t("common.retry")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <KpiGrid data={query.data} />
          <section className="space-y-3">
            <h2 className="text-sm font-extrabold text-slate-500">{t("overview.opsHeading")}</h2>
            <OpsGrid data={query.data} />
          </section>
        </div>
      )}

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        {QUICK_LINKS.map((link) => {
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
                  <span className="text-sm font-extrabold text-slate-900">{t(link.labelKey)}</span>
                  <DirArrow className="h-4 w-4 text-slate-300 transition group-hover:text-teal-600" />
                </div>
                <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{t(link.descKey)}</p>
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
