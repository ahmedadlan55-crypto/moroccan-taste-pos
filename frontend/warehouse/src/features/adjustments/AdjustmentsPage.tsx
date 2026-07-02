import { InvTxListPage } from "@/features/_shared/InvTxListPage";
import { InvTxWizard } from "@/features/_shared/InvTxWizard";
import { INVTX_CONFIG } from "@/features/_shared/invtxConfig";

export function AdjustmentsPage() { return <InvTxListPage config={INVTX_CONFIG.adjustment} />; }
export function AdjustmentWizard() { return <InvTxWizard config={INVTX_CONFIG.adjustment} />; }
