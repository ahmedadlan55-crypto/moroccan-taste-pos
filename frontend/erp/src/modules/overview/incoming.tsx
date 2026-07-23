// Shared read-only workflow-inbox list for the Tasks and Approvals screens.
// Both read GET /api/workflow/incoming and link into /workflow (which stays a
// placeholder this pass).
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowRight } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Badge, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useT, useLang } from "@/i18n";

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

// Importance → Badge tone. The label is resolved at render via
// t("overview.importance.<key>") so it localizes with the active language.
const IMPORTANCE_TONE: Record<string, "danger" | "warning" | "info" | "neutral"> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};
// Workflow status → canonical status.* code, so <StatusBadge> localizes the
// label AND picks the right tone (see status-badge.tsx CODE_TONE). Statuses with
// no canonical code (created/replied/returned) fall back to the neutral-toned
// overview.txnStatus.* labels below.
const STATUS_CODE: Record<string, string> = {
  pending: "pendingApproval",
  in_progress: "inProgress",
  approved: "approved",
  rejected: "rejected",
};
const EXTRA_STATUS = ["created", "replied", "returned"] as const;

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
  const t = useT();
  const lang = useLang();
  // The "open" affordance points along the reading direction: start-ward in RTL
  // (ArrowLeft) and end-ward in LTR (ArrowRight).
  const DirArrow = lang === "ar" ? ArrowLeft : ArrowRight;
  if (items.length === 0) return <EmptyState title={emptyTitle} body={emptyBody} />;
  return (
    <ul className="surface divide-y divide-slate-100">
      {items.map((txn) => {
        const impKey = txn.importance in IMPORTANCE_TONE ? txn.importance : "medium";
        const canonCode = STATUS_CODE[txn.status];
        const isExtraStatus = (EXTRA_STATUS as readonly string[]).includes(txn.status);
        return (
          <li key={txn.id}>
            <Link
              to="/workflow/inbox"
              className="group flex items-center justify-between gap-3 p-4 transition hover:bg-slate-50/70 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-extrabold text-slate-900">
                    {txn.subject || txn.typeName || t("overview.inbox.txnFallback")}
                  </span>
                  {txn.isOverdue && (
                    <span className="inline-flex items-center gap-0.5 text-xs font-extrabold text-rose-600">
                      <AlertTriangle className="h-3.5 w-3.5" /> {t("overview.inbox.overdue")}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-slate-400">
                  <span dir="ltr">{txn.txnNumber || "—"}</span>
                  <span>{txn.createdBy || "—"}</span>
                  <span dir="ltr">{formatDate(txn.createdAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={IMPORTANCE_TONE[impKey]}>{t(`overview.importance.${impKey}`)}</Badge>
                {canonCode ? (
                  <StatusBadge>{canonCode}</StatusBadge>
                ) : isExtraStatus ? (
                  <StatusBadge tone="neutral">{t(`overview.txnStatus.${txn.status}`)}</StatusBadge>
                ) : (
                  <StatusBadge>{txn.status}</StatusBadge>
                )}
                <DirArrow className="h-4 w-4 text-slate-300 transition group-hover:text-teal-600" />
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
