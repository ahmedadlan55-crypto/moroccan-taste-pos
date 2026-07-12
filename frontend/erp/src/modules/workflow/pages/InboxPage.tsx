import { Inbox } from "lucide-react";
import { TxnListScreen } from "../components/TxnListScreen";
import { fetchIncoming } from "../lib/api";
import { qk } from "../lib/query-keys";

// صندوق الوارد — read-only list of transactions awaiting my attention.
// Row → detail Drawer (transaction + approval path + action log). Acting on an
// item routes back to the legacy engine via the drawer's LegacyActionNote.
export function InboxPage() {
  return (
    <TxnListScreen
      icon={Inbox}
      description="المعاملات الواردة إليك بانتظار الاطلاع أو الإجراء."
      tableId="wf-inbox"
      peopleColumn={{ id: "from", header: "من", value: (r) => r.creatorName || r.createdBy || "" }}
      queryKey={qk.incoming}
      fetcher={fetchIncoming}
      emptyTitle="لا توجد معاملات واردة"
      emptyBody="لا توجد معاملات بانتظار إجراء منك حاليًا."
      showLegacyAction
    />
  );
}
