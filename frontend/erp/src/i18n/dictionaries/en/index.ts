import { common } from "./common";
import { confirmDialog } from "./confirmDialog";
import { errors } from "./errors";
import { sharedUi } from "./sharedUi";
import { states } from "./states";
import { status } from "./status";
import { table } from "./table";
import { validation } from "./validation";
import { nav } from "./nav";
import { shell } from "./shell";
import { login } from "./login";

/**
 * Merged English dictionary barrel — one namespace per shared concern / module.
 * Arabic mirror: frontend/erp/src/i18n/dictionaries/ar/index.ts
 *
 * This is the A1 base set (common / errors / states). Other agents append a
 * namespace per module (tables, inventory, menu, …) here and in the `ar`
 * mirror. Every namespace must have an identical key-set / leaf-shape twin in
 * the `ar` barrel — enforced at runtime by
 * frontend/erp/src/i18n/__tests__/dictionary.test.ts.
 */
export const en = {
  common,
  confirmDialog,
  errors,
  sharedUi,
  states,
  status,
  table,
  validation,
  nav,
  shell,
  login,
} as const;
