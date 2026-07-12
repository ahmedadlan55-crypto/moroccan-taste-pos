import { Link } from "react-router-dom";
import { PageHeader, Badge } from "@/shared/ui";
import { useIncoming, IncomingList, IncomingStates, type IncomingTxn } from "../incoming";

export default function TasksAlertsPage() {
  const query = useIncoming();
  const items: IncomingTxn[] = Array.isArray(query.data) ? query.data : [];
  const overdue = items.filter((t) => t.isOverdue).length;

  return (
    <div>
      <PageHeader
        eyebrow="الرئيسية"
        title="المهام والتنبيهات"
        subtitle="المعاملات الواردة التي تحتاج إلى إجراء منك."
        action={
          <div className="flex items-center gap-2">
            {overdue > 0 && <Badge tone="danger">{overdue} متأخرة</Badge>}
            <Link to="/workflow/inbox" className="text-sm font-bold text-teal-700 hover:underline">
              فتح صندوق الوارد
            </Link>
          </div>
        }
      />
      <IncomingStates query={query} />
      {!query.isLoading && !query.error && (
        <IncomingList
          items={items}
          emptyTitle="لا توجد مهام معلّقة"
          emptyBody="صندوق الوارد فارغ — لا شيء يحتاج انتباهك الآن."
        />
      )}
    </div>
  );
}
