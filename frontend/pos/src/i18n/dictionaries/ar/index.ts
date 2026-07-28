import { common } from "./common";
import { errors } from "./errors";
import { header } from "./header";
import { login } from "./login";
import { cartPanel } from "./cartPanel";
import { receipt } from "./receipt";
import { shiftDialog } from "./shiftDialog";
import { paymentDialog } from "./paymentDialog";
import { myInvoicesDialog } from "./myInvoicesDialog";
import { stocktakeDialog } from "./stocktakeDialog";
import { requisitionsDialog } from "./requisitionsDialog";
import { appShell } from "./appShell";
import { categoryRail } from "./categoryRail";
import { productGrid } from "./productGrid";
import { customerPicker } from "./customerPicker";
import { comboDialog } from "./comboDialog";
import { cashMovementDialog } from "./cashMovementDialog";
import { customerAddDialog } from "./customerAddDialog";
import { customerHistoryDialog } from "./customerHistoryDialog";
import { discountDialog } from "./discountDialog";
import { heldOrdersDialog } from "./heldOrdersDialog";
import { managerApprovalDialog } from "./managerApprovalDialog";
import { returnRequestDialog } from "./returnRequestDialog";
import { syncReportDialog } from "./syncReportDialog";
import { voidDialog } from "./voidDialog";
import { numpad } from "./numpad";
import { unitPicker } from "./unitPicker";
import { toasts } from "./toasts";
import { dialog } from "./dialog";
import { ui } from "./ui";
import { cartMath } from "./cartMath";
import { catalogCache } from "./catalogCache";
import { legacyDrain } from "./legacyDrain";
import { syncEngine } from "./syncEngine";

/**
 * Merged Arabic dictionary barrel — one namespace per screen/shared module.
 * English mirror: frontend/pos/src/i18n/dictionaries/en/index.ts
 *
 * Every namespace here must have an identical key-set / leaf-shape twin in
 * the `en` barrel — enforced at runtime by
 * frontend/pos/src/i18n/__tests__/dictionary.test.ts.
 */
export const ar = {
  common,
  errors,
  header,
  login,
  cartPanel,
  receipt,
  shiftDialog,
  paymentDialog,
  myInvoicesDialog,
  stocktakeDialog,
  requisitionsDialog,
  appShell,
  categoryRail,
  productGrid,
  customerPicker,
  comboDialog,
  cashMovementDialog,
  customerAddDialog,
  customerHistoryDialog,
  discountDialog,
  heldOrdersDialog,
  managerApprovalDialog,
  returnRequestDialog,
  syncReportDialog,
  voidDialog,
  numpad,
  unitPicker,
  toasts,
  dialog,
  ui,
  cartMath,
  catalogCache,
  legacyDrain,
  syncEngine,
} as const;
