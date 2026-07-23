import { z } from "zod";
import { validation as V } from "@/i18n/dictionaries/ar/validation";
import { format } from "@/i18n/interpolate";

// Shared zod primitives. Domain modules extend these so money/qty/date/text rules
// (and their error copy) stay consistent.
//
// i18n: schemas are built at module load — before React — so they can't call
// useT(). Instead the user-facing `.message` strings are sourced from the Arabic
// `validation` namespace (i18n/dictionaries/ar/validation.ts) as the default, and
// the form renderer (shared/forms/FieldError.tsx) reverse-maps each message back
// to its key and re-translates it through t() at display time — so a form under an
// English provider shows English, and one rendered without a provider (unit tests)
// shows this Arabic verbatim. Parametric messages (arabicText) carry a runtime
// {label}/{min}/{max} and are format()-interpolated here; being interpolated they
// are not reverse-matchable and stay Arabic (a documented, minor exception).

/** A required, trimmed Arabic/Latin text field with a min length. */
export function arabicText(opts: { min?: number; max?: number; label?: string } = {}) {
  const { min = 1, max = 200, label } = opts;
  const named = label !== undefined;
  const L = named ? label : V.defaultLabel;
  const required = named ? format(V.text.requiredNamed, { label: L }) : V.text.required;
  return z
    .string({ required_error: required })
    .trim()
    .min(min, min === 1 ? required : format(V.text.minLength, { label: L, min }))
    .max(max, format(V.text.maxLength, { label: L, max }));
}

/** Non-negative money value (2 decimals). Accepts a number or numeric string. */
export const money = z.coerce
  .number({ invalid_type_error: V.money.invalid })
  .finite(V.money.invalid)
  .min(0, V.money.negative);

/** Positive money value (> 0) — for amounts that must not be zero. */
export const positiveMoney = money.gt(0, V.money.positive);

/** Non-negative quantity. */
export const qty = z.coerce
  .number({ invalid_type_error: V.qty.invalid })
  .finite(V.qty.invalid)
  .min(0, V.qty.negative);

/** Positive quantity (> 0) — for document lines that require a real amount. */
export const positiveQty = qty.gt(0, V.qty.positive);

/** A ratio 0..1 (e.g. a tax/discount rate). */
export const rate = z.coerce
  .number({ invalid_type_error: V.rate.invalid })
  .min(0, V.rate.negative)
  .max(1, V.rate.range);

/** An ISO date string "YYYY-MM-DD" (Gregorian; matches the DatePicker output). */
export const dateISO = z
  .string({ required_error: V.date.required })
  .regex(/^\d{4}-\d{2}-\d{2}$/, V.date.invalid)
  .refine((s) => !Number.isNaN(new Date(s).getTime()), V.date.invalid);

/** An optional ISO date (empty string → undefined). */
export const optionalDateISO = z
  .string()
  .optional()
  .transform((s) => (s && s.length > 0 ? s : undefined))
  .refine((s) => s === undefined || /^\d{4}-\d{2}-\d{2}$/.test(s), V.date.invalid);

/** A required foreign-key id (string, non-empty) — e.g. a selected entity. */
export const requiredId = z
  .string({ required_error: V.select.required })
  .min(1, V.select.required);

/** Saudi phone number (05XXXXXXXX or +9665XXXXXXXX), optional. */
export const saudiPhone = z
  .string()
  .trim()
  .regex(/^(?:\+?9665|05)\d{8}$/, V.phone.invalid)
  .optional()
  .or(z.literal(""));

/** Email, optional (empty string allowed). */
export const optionalEmail = z
  .string()
  .trim()
  .email(V.email.invalid)
  .optional()
  .or(z.literal(""));
