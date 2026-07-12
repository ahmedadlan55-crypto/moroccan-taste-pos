import { Send } from "lucide-react";
import { TxnListScreen } from "../components/TxnListScreen";
import { fetchOutbox } from "../lib/api";
import { qk } from "../lib/query-keys";

// صندوق الصادر — read-only list of transactions I created/sent, all statuses.
// Row → detail Drawer. No actions here (view only).
export function OutboxPage() {
  return (
    <TxnListScreen
      icon={Send}
      description="المعاملات التي أنشأتها وأرسلتها، وحالة كل منها."
      tableId="wf-outbox"
      peopleColumn={{ id: "holder", header: "لدى", value: (r) => r.assigneeName || r.currentAssignee || "" }}
      queryKey={qk.outbox}
      fetcher={fetchOutbox}
      emptyTitle="لا توجد معاملات صادرة"
      emptyBody="لم تُنشئ أي معاملة بعد."
    />
  );
}
