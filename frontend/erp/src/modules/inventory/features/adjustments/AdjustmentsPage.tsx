import { InvTxListPage } from "@/modules/inventory/features/_shared/InvTxListPage";
import { InvTxWizard } from "@/modules/inventory/features/_shared/InvTxWizard";
import { INVTX_CONFIG } from "@/modules/inventory/features/_shared/invtxConfig";

export function AdjustmentsPage() { return <InvTxListPage config={INVTX_CONFIG.adjustment} />; }
export function AdjustmentWizard() { return <InvTxWizard config={INVTX_CONFIG.adjustment} />; }
