import { Link } from "react-router-dom";
import { PageHeader, Badge } from "@/shared/ui";
import { useIncoming, IncomingList, IncomingStates, type IncomingTxn } from "../incoming";

// "الموافقات المطلوبة" — the subset of the inbox that is awaiting a decision.
export default function ApprovalsPage() {
  const query = useIncoming();
  const all: IncomingTxn[] = Array.isArray(query.data) ? query.data : [];
  const approvals = all.filter((t) => t.status === "pending" || t.status === "in_progress");

  return (
    <div>
      <PageHeader
        eyebrow="الرئيسية"
        title="الموافقات المطلوبة"
        subtitle="المعاملات بانتظار اعتمادك."
        action={
          <div className="flex items-center gap-2">
            <Badge tone={approvals.length > 0 ? "warning" : "neutral"}>{approvals.length} بانتظار الاعتماد</Badge>
            <Link to="/workflow/inbox" className="text-sm font-bold text-teal-700 hover:underline">
              فتح المعاملات
            </Link>
          </div>
        }
      />
      <IncomingStates query={query} />
      {!query.isLoading && !query.error && (
        <IncomingList
          items={approvals}
          emptyTitle="لا توجد موافقات مطلوبة"
          emptyBody="لا توجد معاملات بانتظار اعتمادك حاليًا."
        />
      )}
    </div>
  );
}
