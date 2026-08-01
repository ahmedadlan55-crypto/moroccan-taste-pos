// Centralized, locale-aware formatters — the ONLY place numbers/dates are
// formatted in the ADLAN Back-Office app.
//
// NUMBERING POLICY (approved): every numeral renders as ENGLISH digits 0-9
// (en-US grouping "1,234.50"), while labels and page direction stay Arabic RTL.
// Dates keep Arabic month names but Latin digits (ar + numberingSystem 'latn').
// Wrap numeric cells in dir="ltr" + tabular-nums at the call site for clean
// alignment inside RTL text.

const _currencyNum = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const _number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const _percentNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * "1,234.50 ر.س" in Arabic, "SAR 1,234.50" in English.
 *
 * The suffix used to be the literal `ر.س`, unconditionally — so the English UI
 * printed an Arabic currency symbol on every money figure in the product: every
 * report, every KPI card, every invoice total. A number whose unit is written
 * in a script the reader cannot read is not a formatting blemish; it is a
 * figure they cannot safely act on.
 *
 * WHY IT READS THE DOCUMENT INSTEAD OF TAKING A `lang` ARGUMENT
 *   There are 73 call sites across the ERP, most of them in `columns` arrays
 *   and other non-hook contexts where `useLang()` cannot be called. Adding a
 *   required parameter would be a 73-file change whose failure mode is a
 *   forgotten call site silently reverting to the wrong locale. The provider
 *   already stamps `document.documentElement.lang` on every language switch
 *   (i18n/I18nProvider.tsx), so reading it here is the one place that cannot
 *   drift. `i18n/format.ts` keeps the explicit `formatCurrency(n, lang)` for
 *   code that does have the language in hand.
 *
 * Digits stay English in both languages — the approved numbering policy above.
 */
export function formatCurrency(value: number | null | undefined): string {
  const n = _currencyNum.format(Number(value) || 0);
  const ar = typeof document === "undefined" || document.documentElement.lang !== "en";
  return ar ? `${n} ر.س` : `SAR ${n}`;
}

export function formatNumber(value: number | null | undefined): string {
  return _number.format(Number(value) || 0);
}

/** value is a ratio (0..1) → "95.25%". */
export function formatPercent(value: number | null | undefined): string {
  return `${_percentNum.format((Number(value) || 0) * 100)}%`;
}

export function formatQty(value: number | null | undefined, unit?: string): string {
  const n = _number.format(Number(value) || 0);
  return unit ? `${n} ${unit}` : n;
}

// DATE POLICY (owner's instruction): every date in the product renders in
// ENGLISH — English month names AND Latin digits — regardless of UI language.
//
// It used to be `Intl.DateTimeFormat("ar", …)`, which gave Latin digits but
// ARABIC month names ("28 يوليو 2026"). Mixing an Arabic month name into a
// financial document that a bank, an auditor or ZATCA may read is a
// readability problem, and it made the same date look different depending on
// which screen you opened.
//
// `en-GB` is the deliberate choice over `en-US`: day-first ("28 Jul 2026")
// matches how dates are written in Saudi, and a spelled month can never be
// misread the way 03/04 can.
//
// GREGORIAN is pinned explicitly — financial documents are never Hijri.
const _dateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  numberingSystem: "latn",
  calendar: "gregory",
  hour12: false,
});
const _date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", numberingSystem: "latn", calendar: "gregory" });

function _parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | null | undefined): string {
  const d = _parse(value);
  return d ? _dateTime.format(d) : "—";
}

export function formatDate(value: string | null | undefined): string {
  const d = _parse(value);
  return d ? _date.format(d) : "—";
}
