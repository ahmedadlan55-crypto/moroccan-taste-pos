import { common } from "./common";
import { errors } from "./errors";
import { states } from "./states";

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
  errors,
  states,
} as const;
