import { InvTxListPage } from "@/features/_shared/InvTxListPage";
import { InvTxWizard } from "@/features/_shared/InvTxWizard";
import { INVTX_CONFIG } from "@/features/_shared/invtxConfig";

export function ReceiptsPage() { return <InvTxListPage config={INVTX_CONFIG.receipt} />; }
export function ReceiptWizard() { return <InvTxWizard config={INVTX_CONFIG.receipt} />; }
