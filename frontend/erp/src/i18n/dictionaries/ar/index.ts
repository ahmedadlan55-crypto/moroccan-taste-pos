import { accounting } from "./accounting";
import { administration } from "./administration";
import { banking } from "./banking";
import { common } from "./common";
import { confirmDialog } from "./confirmDialog";
import { errors } from "./errors";
import { inventoryRest } from "./inventoryRest";
import { items } from "./items";
import { login } from "./login";
import { menu } from "./menu";
import { menuRest } from "./menuRest";
import { misc } from "./misc";
import { nav } from "./nav";
import { overview } from "./overview";
import { people } from "./people";
import { posAdmin } from "./posAdmin";
import { production } from "./production";
import { purchasing } from "./purchasing";
import { sales } from "./sales";
import { sharedUi } from "./sharedUi";
import { shell } from "./shell";
import { states } from "./states";
import { status } from "./status";
import { table } from "./table";
import { validation } from "./validation";
import { workflow } from "./workflow";

/**
 * Merged Arabic dictionary barrel — one namespace per shared concern / module.
 * English mirror: frontend/erp/src/i18n/dictionaries/en/index.ts
 *
 * Every namespace file in this folder is wired here in alphabetical order. Each
 * namespace must have an identical key-set / leaf-shape twin in the `en` barrel
 * — enforced at runtime by
 * frontend/erp/src/i18n/__tests__/dictionary.test.ts.
 */
export const ar = {
  accounting,
  administration,
  banking,
  common,
  confirmDialog,
  errors,
  inventoryRest,
  items,
  login,
  menu,
  menuRest,
  misc,
  nav,
  overview,
  people,
  posAdmin,
  production,
  purchasing,
  sales,
  sharedUi,
  shell,
  states,
  status,
  table,
  validation,
  workflow,
} as const;
