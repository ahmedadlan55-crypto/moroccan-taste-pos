import { Send } from "lucide-react";
import { useTx } from "@/shared/ui/i18n";
import { TxnListScreen } from "../components/TxnListScreen";
import { fetchOutbox } from "../lib/api";
import { qk } from "../lib/query-keys";

// صندوق الصادر — read-only list of transactions I created/sent, all statuses.
// Row → detail Drawer. No actions here (view only).
export function OutboxPage() {
  const t = useTx();
  return (
    <TxnListScreen
      icon={Send}
      title={t("nav.items.wf-outbox")}
      description={t("workflow.outbox.description")}
      tableId="wf-outbox"
      peopleColumn={{ id: "holder", header: t("workflow.outbox.holder"), value: (r) => r.assigneeName || r.currentAssignee || "" }}
      queryKey={qk.outbox}
      fetcher={fetchOutbox}
      emptyTitle={t("workflow.outbox.emptyTitle")}
      emptyBody={t("workflow.outbox.emptyBody")}
    />
  );
}
