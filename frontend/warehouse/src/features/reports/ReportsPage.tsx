import { Link } from "react-router-dom";
import { FileBarChart, ChevronLeft, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/states/States";
import { useReportCatalog } from "@/lib/hooks/useReport";

// Reports center — a catalog grid linking to each report's detail page.
export function ReportsPage() {
  const { data, isLoading, isError, error, refetch } = useReportCatalog();

  return (
    <div>
      <PageHeader
        eyebrow="التقارير"
        title="مركز التقارير"
        subtitle="تقارير المخزون للقراءة فقط — تحترم نطاق المستودع المحدد، مع فلاتر وتصدير CSV وطباعة عربية."
      />

      {isLoading && <LoadingState />}
      {isError && <ErrorState error={error} onRetry={refetch} />}

      {data && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((r) => (
            <Link
              key={r.type}
              to={`/reports/${r.type}`}
              className="surface group flex items-center justify-between gap-3 p-5 transition hover:border-teal-300 hover:shadow-md"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
                  <FileBarChart className="h-5 w-5" />
                </span>
                <div>
                  <div className="text-sm font-extrabold text-slate-900">{r.label}</div>
                  {r.adminOnly && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                      <ShieldAlert className="h-3 w-3" /> للإدارة فقط
                    </div>
                  )}
                </div>
              </div>
              <ChevronLeft className="h-5 w-5 shrink-0 text-slate-300 transition group-hover:text-teal-600" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
