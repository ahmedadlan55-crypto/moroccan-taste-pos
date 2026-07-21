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
 * Merged Arabic dictionary barrel — one namespace per shared concern / module.
 * English mirror: frontend/erp/src/i18n/dictionaries/en/index.ts
 *
 * This is the A1 base set (common / errors / states). Other agents append a
 * namespace per module (tables, inventory, menu, …) here and in the `en`
 * mirror. Every namespace must have an identical key-set / leaf-shape twin in
 * the `en` barrel — enforced at runtime by
 * frontend/erp/src/i18n/__tests__/dictionary.test.ts.
 */
export const ar = {
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
