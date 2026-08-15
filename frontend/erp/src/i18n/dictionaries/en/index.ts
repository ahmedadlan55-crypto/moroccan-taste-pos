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
import { operationalReports } from "./operationalReports";
import { operations } from "./operations";
import { overview } from "./overview";
import { people } from "./people";
import { posAdmin } from "./posAdmin";
import { production } from "./production";
import { purchasing } from "./purchasing";
import { receivablesReports } from "./receivablesReports";
import { recipes } from "./recipes";
import { sales } from "./sales";
import { salesReports } from "./salesReports";
import { sharedUi } from "./sharedUi";
import { shell } from "./shell";
import { states } from "./states";
import { status } from "./status";
import { table } from "./table";
import { validation } from "./validation";
import { workflow } from "./workflow";
import { warehouseIntelligence } from "./warehouseIntelligence";

/**
 * Merged English dictionary barrel — one namespace per shared concern / module.
 * Arabic mirror: frontend/erp/src/i18n/dictionaries/ar/index.ts
 *
 * Every namespace file in this folder is wired here in alphabetical order. Each
 * namespace must have an identical key-set / leaf-shape twin in the `ar` barrel
 * — enforced at runtime by
 * frontend/erp/src/i18n/__tests__/dictionary.test.ts.
 */
export const en = {
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
  operationalReports,
  operations,
  overview,
  people,
  posAdmin,
  production,
  purchasing,
  receivablesReports,
  recipes,
  sales,
  salesReports,
  sharedUi,
  shell,
  states,
  status,
  table,
  validation,
  workflow,
  warehouseIntelligence,
} as const;
