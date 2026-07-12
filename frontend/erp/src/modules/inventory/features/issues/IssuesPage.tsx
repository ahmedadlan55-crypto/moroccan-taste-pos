import { InvTxListPage } from "@/modules/inventory/features/_shared/InvTxListPage";
import { InvTxWizard } from "@/modules/inventory/features/_shared/InvTxWizard";
import { INVTX_CONFIG } from "@/modules/inventory/features/_shared/invtxConfig";

export function IssuesPage() { return <InvTxListPage config={INVTX_CONFIG.issue} />; }
export function IssueWizard() { return <InvTxWizard config={INVTX_CONFIG.issue} />; }
