import { InvTxListPage } from "@/features/_shared/InvTxListPage";
import { InvTxWizard } from "@/features/_shared/InvTxWizard";
import { INVTX_CONFIG } from "@/features/_shared/invtxConfig";

export function IssuesPage() { return <InvTxListPage config={INVTX_CONFIG.issue} />; }
export function IssueWizard() { return <InvTxWizard config={INVTX_CONFIG.issue} />; }
