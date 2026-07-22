import { Inbox } from "lucide-react";
import { useTx } from "@/shared/ui/i18n";
import { TxnListScreen } from "../components/TxnListScreen";
import { fetchIncoming } from "../lib/api";
import { qk } from "../lib/query-keys";

// صندوق الوارد — the transactions awaiting my attention. Row → detail Drawer
// (transaction + approval path + action log) with the REAL action bar
// (اعتماد/رفض/إرجاع/إحالة) posting to /workflow/:id/action — gated by the
// workflow.actions.act capability AND the server's per-transaction permissions.
export function InboxPage() {
  const t = useTx();
  return (
    <TxnListScreen
      icon={Inbox}
      description={t("workflow.inbox.description")}
      tableId="wf-inbox"
      peopleColumn={{ id: "from", header: t("workflow.inbox.from"), value: (r) => r.creatorName || r.createdBy || "" }}
      queryKey={qk.incoming}
      fetcher={fetchIncoming}
      emptyTitle={t("workflow.inbox.emptyTitle")}
      emptyBody={t("workflow.inbox.emptyBody")}
      canAct
    />
  );
}
