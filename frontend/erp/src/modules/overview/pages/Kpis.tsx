import { RefreshCw } from "lucide-react";
import { Button, LoadingState, EmptyState, PageHeader } from "@/shared/ui";
import { useDashboardOverview, KpiGrid, OpsGrid } from "../_common";

export default function KpisPage() {
  const query = useDashboardOverview();
  return (
    <div>
      <PageHeader
        eyebrow="الرئيسية"
        title="مؤشرات الأداء"
        subtitle="أهم مؤشرات الأداء المالية والتشغيلية للفترة الحالية."
        action={
          <Button variant="secondary" onClick={() => query.refetch()} loading={query.isFetching}>
            <RefreshCw className="h-4 w-4" /> تحديث
          </Button>
        }
      />
      {query.isLoading ? (
        <LoadingState />
      ) : query.error || !query.data ? (
        <EmptyState
          title="تعذّر تحميل المؤشرات"
          action={
            <Button variant="secondary" onClick={() => query.refetch()}>
              <RefreshCw className="h-4 w-4" /> إعادة المحاولة
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <KpiGrid data={query.data} />
          <section className="space-y-3">
            <h2 className="text-sm font-extrabold text-slate-500">الأرصدة التشغيلية</h2>
            <OpsGrid data={query.data} />
          </section>
        </div>
      )}
    </div>
  );
}
