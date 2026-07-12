import { FileClock } from "lucide-react";
import { TxnListScreen } from "../components/TxnListScreen";
import { fetchMyTransactions } from "../lib/api";
import { qk } from "../lib/query-keys";

// طلباتي — read-only list of the transactions I submitted (created_by = me), via
// the workflow /my-transactions endpoint. Row → detail Drawer.
export function MyRequestsPage() {
  return (
    <TxnListScreen
      icon={FileClock}
      description="الطلبات والمعاملات التي قدّمتها ومتابعة مسارها."
      tableId="wf-my-requests"
      peopleColumn={{ id: "holder", header: "لدى الآن", value: (r) => r.assigneeName || r.currentAssignee || "" }}
      queryKey={qk.myRequests}
      fetcher={fetchMyTransactions}
      emptyTitle="لا توجد طلبات"
      emptyBody="لم تقدّم أي طلب بعد."
    />
  );
}
