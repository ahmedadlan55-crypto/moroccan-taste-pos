import { Link } from "react-router-dom";
import { PageHeader, Badge } from "@/shared/ui";
import { useT } from "@/i18n";
import { useIncoming, IncomingList, IncomingStates, type IncomingTxn } from "../incoming";

// "الموافقات المطلوبة" — the subset of the inbox that is awaiting a decision.
export default function ApprovalsPage() {
  const t = useT();
  const query = useIncoming();
  const all: IncomingTxn[] = Array.isArray(query.data) ? query.data : [];
  const approvals = all.filter((txn) => txn.status === "pending" || txn.status === "in_progress");

  return (
    <div>
      <PageHeader
        eyebrow={t("overview.eyebrow")}
        title={t("overview.approvals.title")}
        subtitle={t("overview.approvals.subtitle")}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={approvals.length > 0 ? "warning" : "neutral"}>
              {t("overview.approvals.awaitingCount", { count: approvals.length })}
            </Badge>
            <Link to="/workflow/inbox" className="text-sm font-bold text-teal-700 hover:underline">
              {t("overview.approvals.openTxns")}
            </Link>
          </div>
        }
      />
      <IncomingStates query={query} />
      {!query.isLoading && !query.error && (
        <IncomingList
          items={approvals}
          emptyTitle={t("overview.approvals.emptyTitle")}
          emptyBody={t("overview.approvals.emptyBody")}
        />
      )}
    </div>
  );
}
