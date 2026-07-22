/** Zod validation messages for the shared schema primitives
 *  (frontend/erp/src/shared/schemas/primitives.ts). Schemas are built at module
 *  load — BEFORE React, so they can't call useT(). Instead primitives.ts sources
 *  its `.message` strings from THIS (Arabic default) file, and the form renderer
 *  (frontend/erp/src/shared/forms/FieldError.tsx) maps the rendered message back
 *  to a key and re-translates it through t() at display time — so a form under an
 *  English I18nProvider shows English, while a form rendered without a provider
 *  (e.g. a unit test) shows this Arabic verbatim. Templates carrying a runtime
 *  value use {label}/{min}/{max}; those are format()-interpolated in primitives
 *  and are NOT reverse-matchable (they pass through as Arabic). English mirror:
 *  en/validation.ts. */
export const validation = {
  defaultLabel: "هذا الحقل",
  text: {
    required: "هذا الحقل مطلوب",
    requiredNamed: "{label} مطلوب",
    minLength: "{label} يجب أن يكون {min} أحرف على الأقل",
    maxLength: "{label} يتجاوز الحد الأقصى ({max} حرف)",
  },
  money: {
    invalid: "أدخل مبلغًا صحيحًا",
    negative: "المبلغ لا يمكن أن يكون سالبًا",
    positive: "المبلغ يجب أن يكون أكبر من صفر",
  },
  qty: {
    invalid: "أدخل كمية صحيحة",
    negative: "الكمية لا يمكن أن تكون سالبة",
    positive: "الكمية يجب أن تكون أكبر من صفر",
  },
  rate: {
    invalid: "أدخل نسبة صحيحة",
    negative: "النسبة لا يمكن أن تكون سالبة",
    range: "النسبة يجب أن تكون بين 0 و 1",
  },
  date: {
    required: "التاريخ مطلوب",
    invalid: "التاريخ غير صحيح",
  },
  select: {
    required: "الاختيار مطلوب",
  },
  phone: {
    invalid: "رقم الجوال غير صحيح",
  },
  email: {
    invalid: "البريد الإلكتروني غير صحيح",
  },
} as const;
