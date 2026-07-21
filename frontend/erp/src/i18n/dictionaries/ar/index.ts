import { common } from "./common";
import { errors } from "./errors";
import { states } from "./states";

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
  errors,
  states,
} as const;
