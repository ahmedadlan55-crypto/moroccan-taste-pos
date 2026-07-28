/**
 * Intl formatting helpers for the ERP — numbers, SAR currency, and dates.
 *
 * DIGIT CONVENTION: LATIN digits (0-9) in BOTH languages, matching the POS
 * (frontend/pos/src/lib/format.ts, which formats every UI number with the
 * en-US locale precisely so Arabic never renders Eastern-Arabic digits ٠-٩).
 *
 * We honour `lang` for locale conventions (English uses en-US; Arabic uses the
 * ar-SA locale so currency shows ر.س. in its natural RTL position), but pin the
 * numbering system to Latin via the BCP-47 `-u-nu-latn` extension so the DIGITS
 * stay Latin in both — identical numeric glyphs and ASCII separators to en-US
 * ("1,234.50"), never "١٬٢٣٤٫٥٠". The extension lives in the locale string, so
 * this needs no `numberingSystem`/`calendar` Intl options (keeping it robust
 * across TS lib targets). The Gregorian calendar is likewise pinned for Arabic
 * (`-ca-gregory`) so dates don't switch to Hijri.
 */
import type { Lang } from "./I18nProvider";

// Latin-digit locales. English → en-US. Arabic → ar-SA with the Latin numbering
// system forced, so digits match the POS convention exactly.
const NUMBER_LOCALE: Record<Lang, string> = {
  en: "en-US",
  ar: "ar-SA-u-nu-latn",
};

// DATE POLICY (owner's instruction): dates render in ENGLISH in BOTH UI
// languages — English month names AND Latin digits. The Arabic entry used to
// be `ar-SA-u-nu-latn-ca-gregory`, which produced Latin digits but ARABIC
// month/era text, so the same date read differently on an Arabic screen than
// on an English one, and looked wrong in a document a bank, an auditor or
// ZATCA may read.
//
// `en-GB` over `en-US` deliberately: day-first ("28/07/2026", "28 Jul 2026")
// is how dates are written in Saudi, and a day-first order cannot be misread
// the way the US month-first order can.
//
// `-ca-gregory` stays pinned on both — a financial date is never Hijri.
const DATE_LOCALE: Record<Lang, string> = {
  en: "en-GB-u-ca-gregory",
  ar: "en-GB-u-ca-gregory",
};

/** Plain number — grouped, up to 2 fraction digits. Latin digits in both
 *  languages. `formatNumber(1234.5, "ar")` → "1,234.5". */
export function formatNumber(n: number, lang: Lang): string {
  const value = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat(NUMBER_LOCALE[lang], {
    maximumFractionDigits: 2,
  }).format(value);
}

/** Money in SAR — `formatCurrency(1234.5, "en")` → "SAR 1,234.50",
 *  `formatCurrency(1234.5, "ar")` → "‏1,234.50 ر.س.‏". Latin digits in both. */
export function formatCurrency(n: number, lang: Lang): string {
  const value = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat(NUMBER_LOCALE[lang], {
    style: "currency",
    currency: "SAR",
  }).format(value);
}

/** Date — day/month/year, 2-digit day+month, Latin digits, Gregorian in both.
 *  Accepts a Date, epoch ms, or a parseable string; returns "—" for invalid
 *  input rather than "Invalid Date". */
export function formatDate(d: Date | number | string, lang: Lang): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(DATE_LOCALE[lang], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
