import { RefreshCw } from "lucide-react";
import { Button, LoadingState, EmptyState, PageHeader } from "@/shared/ui";
import { useT } from "@/i18n";
import { useDashboardOverview, KpiGrid, OpsGrid } from "../_common";

export default function KpisPage() {
  const t = useT();
  const query = useDashboardOverview();
  return (
    <div>
      <PageHeader
        eyebrow={t("overview.eyebrow")}
        title={t("overview.kpis.title")}
        subtitle={t("overview.kpis.subtitle")}
        action={
          <Button variant="secondary" onClick={() => query.refetch()} loading={query.isFetching}>
            <RefreshCw className="h-4 w-4" /> {t("states.refreshBtn")}
          </Button>
        }
      />
      {query.isLoading ? (
        <LoadingState />
      ) : query.error || !query.data ? (
        <EmptyState
          title={t("overview.kpis.loadError")}
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
    </div>
  );
}
