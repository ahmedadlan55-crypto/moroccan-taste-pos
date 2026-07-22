import { Link } from "react-router-dom";
import { PageHeader, Badge } from "@/shared/ui";
import { useT } from "@/i18n";
import { useIncoming, IncomingList, IncomingStates, type IncomingTxn } from "../incoming";

export default function TasksAlertsPage() {
  const t = useT();
  const query = useIncoming();
  const items: IncomingTxn[] = Array.isArray(query.data) ? query.data : [];
  const overdue = items.filter((txn) => txn.isOverdue).length;

  return (
    <div>
      <PageHeader
        eyebrow={t("overview.eyebrow")}
        title={t("overview.tasks.title")}
        subtitle={t("overview.tasks.subtitle")}
        action={
          <div className="flex items-center gap-2">
            {overdue > 0 && <Badge tone="danger">{t("overview.tasks.overdueCount", { count: overdue })}</Badge>}
            <Link to="/workflow/inbox" className="text-sm font-bold text-teal-700 hover:underline">
              {t("overview.tasks.openInbox")}
            </Link>
          </div>
        }
      />
      <IncomingStates query={query} />
      {!query.isLoading && !query.error && (
        <IncomingList
          items={items}
          emptyTitle={t("overview.tasks.emptyTitle")}
          emptyBody={t("overview.tasks.emptyBody")}
        />
      )}
    </div>
  );
}
