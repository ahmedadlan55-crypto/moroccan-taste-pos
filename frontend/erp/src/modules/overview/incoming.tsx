// Shared read-only workflow-inbox list for the Tasks and Approvals screens.
// Both read GET /api/workflow/incoming and link into /workflow (which stays a
// placeholder this pass).
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Badge, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { formatDate } from "@/shared/lib";

export interface IncomingTxn {
  id: string;
  txnNumber: string;
  subject: string;
  importance: string;
  status: string;
  createdBy: string;
  createdAt: string;
  typeName?: string;
  isOverdue?: boolean;
}

const IMPORTANCE: Record<string, { label: string; tone: "danger" | "warning" | "info" | "neutral" }> = {
  critical: { label: "حرج", tone: "danger" },
  high: { label: "عالي", tone: "warning" },
  medium: { label: "متوسط", tone: "info" },
  low: { label: "منخفض", tone: "neutral" },
};
const STATUS_AR: Record<string, string> = {
  pending: "بانتظار الاعتماد",
  in_progress: "قيد التنفيذ",
  created: "جديد",
  replied: "تم الرد",
  returned: "مُعاد للتعديل",
  approved: "معتمد",
  rejected: "مرفوض",
};

export function useIncoming() {
  return useQuery({
    queryKey: ["workflow", "incoming"],
    queryFn: ({ signal }) => apiClient.get<IncomingTxn[]>("/workflow/incoming", { signal }),
    staleTime: 30_000,
  });
}

export function IncomingList({
  items,
  emptyTitle,
  emptyBody,
}: {
  items: IncomingTxn[];
  emptyTitle: string;
  emptyBody?: string;
}) {
  if (items.length === 0) return <EmptyState title={emptyTitle} body={emptyBody} />;
  return (
    <ul className="surface divide-y divide-slate-100">
      {items.map((t) => {
        const imp = IMPORTANCE[t.importance] ?? IMPORTANCE.medium;
        return (
          <li key={t.id}>
            <Link
              to="/workflow/inbox"
              className="group flex items-center justify-between gap-3 p-4 transition hover:bg-slate-50/70 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-extrabold text-slate-900">
                    {t.subject || t.typeName || "معاملة"}
                  </span>
                  {t.isOverdue && (
                    <span className="inline-flex items-center gap-0.5 text-xs font-extrabold text-rose-600">
                      <AlertTriangle className="h-3.5 w-3.5" /> متأخرة
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-slate-400" dir="rtl">
                  <span dir="ltr">{t.txnNumber || "—"}</span>
                  <span>{t.createdBy || "—"}</span>
                  <span dir="ltr">{formatDate(t.createdAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={imp.tone}>{imp.label}</Badge>
                <StatusBadge>{STATUS_AR[t.status] ?? t.status}</StatusBadge>
                <ArrowLeft className="h-4 w-4 text-slate-300 transition group-hover:text-teal-600" />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function IncomingStates({
  query,
}: {
  query: ReturnType<typeof useIncoming>;
}) {
  if (query.isLoading) return <LoadingState rows={3} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return null;
}
