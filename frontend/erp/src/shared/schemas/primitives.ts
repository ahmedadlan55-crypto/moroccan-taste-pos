import { z } from "zod";

// Shared zod primitives with Arabic validation messages. Domain modules extend
// these so money/qty/date/text rules (and their error copy) stay consistent.

/** A required, trimmed Arabic/Latin text field with a min length. */
export function arabicText(opts: { min?: number; max?: number; label?: string } = {}) {
  const { min = 1, max = 200, label = "هذا الحقل" } = opts;
  return z
    .string({ required_error: `${label} مطلوب` })
    .trim()
    .min(min, min === 1 ? `${label} مطلوب` : `${label} يجب أن يكون ${min} أحرف على الأقل`)
    .max(max, `${label} يتجاوز الحد الأقصى (${max} حرف)`);
}

/** Non-negative money value (2 decimals). Accepts a number or numeric string. */
export const money = z.coerce
  .number({ invalid_type_error: "أدخل مبلغًا صحيحًا" })
  .finite("أدخل مبلغًا صحيحًا")
  .min(0, "المبلغ لا يمكن أن يكون سالبًا");

/** Positive money value (> 0) — for amounts that must not be zero. */
export const positiveMoney = money.gt(0, "المبلغ يجب أن يكون أكبر من صفر");

/** Non-negative quantity. */
export const qty = z.coerce
  .number({ invalid_type_error: "أدخل كمية صحيحة" })
  .finite("أدخل كمية صحيحة")
  .min(0, "الكمية لا يمكن أن تكون سالبة");

/** Positive quantity (> 0) — for document lines that require a real amount. */
export const positiveQty = qty.gt(0, "الكمية يجب أن تكون أكبر من صفر");

/** A ratio 0..1 (e.g. a tax/discount rate). */
export const rate = z.coerce
  .number({ invalid_type_error: "أدخل نسبة صحيحة" })
  .min(0, "النسبة لا يمكن أن تكون سالبة")
  .max(1, "النسبة يجب أن تكون بين 0 و 1");

/** An ISO date string "YYYY-MM-DD" (Gregorian; matches the DatePicker output). */
export const dateISO = z
  .string({ required_error: "التاريخ مطلوب" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ غير صحيح")
  .refine((s) => !Number.isNaN(new Date(s).getTime()), "التاريخ غير صحيح");

/** An optional ISO date (empty string → undefined). */
export const optionalDateISO = z
  .string()
  .optional()
  .transform((s) => (s && s.length > 0 ? s : undefined))
  .refine((s) => s === undefined || /^\d{4}-\d{2}-\d{2}$/.test(s), "التاريخ غير صحيح");

/** A required foreign-key id (string, non-empty) — e.g. a selected entity. */
export const requiredId = z
  .string({ required_error: "الاختيار مطلوب" })
  .min(1, "الاختيار مطلوب");

/** Saudi phone number (05XXXXXXXX or +9665XXXXXXXX), optional. */
export const saudiPhone = z
  .string()
  .trim()
  .regex(/^(?:\+?9665|05)\d{8}$/, "رقم الجوال غير صحيح")
  .optional()
  .or(z.literal(""));

/** Email, optional (empty string allowed). */
export const optionalEmail = z
  .string()
  .trim()
  .email("البريد الإلكتروني غير صحيح")
  .optional()
  .or(z.literal(""));
