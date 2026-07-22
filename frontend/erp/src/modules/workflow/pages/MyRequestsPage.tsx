import { FileClock } from "lucide-react";
import { useTx } from "@/shared/ui/i18n";
import { TxnListScreen } from "../components/TxnListScreen";
import { fetchMyTransactions } from "../lib/api";
import { qk } from "../lib/query-keys";

// طلباتي — read-only list of the transactions I submitted (created_by = me), via
// the workflow /my-transactions endpoint. Row → detail Drawer.
export function MyRequestsPage() {
  const t = useTx();
  return (
    <TxnListScreen
      icon={FileClock}
      description={t("workflow.myRequests.description")}
      tableId="wf-my-requests"
      peopleColumn={{ id: "holder", header: t("workflow.myRequests.holderNow"), value: (r) => r.assigneeName || r.currentAssignee || "" }}
      queryKey={qk.myRequests}
      fetcher={fetchMyTransactions}
      emptyTitle={t("workflow.myRequests.emptyTitle")}
      emptyBody={t("workflow.myRequests.emptyBody")}
    />
  );
}
