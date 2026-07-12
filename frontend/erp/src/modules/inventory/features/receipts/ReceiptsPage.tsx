import { InvTxListPage } from "@/modules/inventory/features/_shared/InvTxListPage";
import { InvTxWizard } from "@/modules/inventory/features/_shared/InvTxWizard";
import { INVTX_CONFIG } from "@/modules/inventory/features/_shared/invtxConfig";

export function ReceiptsPage() { return <InvTxListPage config={INVTX_CONFIG.receipt} />; }
export function ReceiptWizard() { return <InvTxWizard config={INVTX_CONFIG.receipt} />; }
