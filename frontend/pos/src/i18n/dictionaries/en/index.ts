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

/**
 * Merged English dictionary barrel — one namespace per screen/shared module.
 * Arabic mirror: frontend/pos/src/i18n/dictionaries/ar/index.ts
 *
 * Every namespace here must have an identical key-set / leaf-shape twin in
 * the `ar` barrel — enforced at runtime by
 * frontend/pos/src/i18n/__tests__/dictionary.test.ts.
 */
export const en = {
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
} as const;
