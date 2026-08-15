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

/** Scaled statement figures (thousands/millions) — see formatScaled below. */
const _scaledNum = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

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

// ─── statement headings ─────────────────────────────────────────────────────
//
// A financial statement names its own time basis, and the wording is not
// decorative: "as at 31 Jul 2026" is a POSITION (a balance sheet, a trial
// balance closing column, an ageing snapshot) and "for the period from … to …"
// is a FLOW (an income statement, a movement column, a cash-flow). Every report
// page in the ERP hand-concatenated `${formatDate(from)} — ${formatDate(to)}`
// instead, which states a range and nothing about what the range means, and put
// the em dash inside a right-to-left line where it reads ambiguously.
//
// These read `document.documentElement.lang` for exactly the reason
// formatCurrency does, and are worded here rather than in the dictionaries for
// the same reason: they are called from `columns` arrays, CSV filenames and
// other non-hook contexts where `useT()` does not exist.

function _isArabic(): boolean {
  return typeof document === "undefined" || document.documentElement.lang !== "en";
}

/** "كما في 31 Jul 2026" / "As at 31 Jul 2026" — a position at an instant. */
export function formatAsAt(date: string | null | undefined): string {
  const d = formatDate(date);
  return _isArabic() ? `كما في ${d}` : `As at ${d}`;
}

/**
 * "للفترة من 1 Jan 2026 إلى 31 Jul 2026" / "For the period from … to …".
 *
 * With only an end date it degrades to the "ended" wording rather than printing
 * a range with a missing half.
 */
export function formatForPeriod(from: string | null | undefined, to: string | null | undefined): string {
  const start = _parse(from);
  const end = formatDate(to);
  if (!start) return _isArabic() ? `للفترة المنتهية في ${end}` : `For the period ended ${end}`;
  const begin = formatDate(from);
  return _isArabic() ? `للفترة من ${begin} إلى ${end}` : `For the period from ${begin} to ${end}`;
}

// ─── amount scale ───────────────────────────────────────────────────────────
//
// A statement states its unit ONCE, in the heading ("All amounts in thousands of
// Saudi Riyals"), and then prints bare numbers. Repeating "ر.س" on every line of
// a 300-row ledger is noise that also destroys column alignment, and printing
// 12,481,905.00 in a column where every neighbour is eight digits wide makes the
// figures unreadable at a glance. Scale is a property of the STATEMENT, so it is
// chosen once from the largest magnitude the statement carries — never per cell,
// which would put two different units in one column.

export type AmountScaleKey = "units" | "thousands" | "millions";

export interface AmountScale {
  key: AmountScaleKey;
  /** Divide a raw amount by this before formatting. */
  factor: number;
}

const _SCALES: Record<AmountScaleKey, AmountScale> = {
  units: { key: "units", factor: 1 },
  thousands: { key: "thousands", factor: 1_000 },
  millions: { key: "millions", factor: 1_000_000 },
};

/**
 * Pick the scale for a whole statement from the amounts it will print.
 *
 * Thresholds are deliberately high: scaling too eagerly turns 1,250 into "1.3"
 * and loses the reader more precision than it saves them width. Non-finite and
 * missing values are ignored rather than counted as zero.
 */
export function chooseAmountScale(values: Iterable<number | null | undefined>): AmountScale {
  let max = 0;
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const abs = Math.abs(n);
    if (abs > max) max = abs;
  }
  if (max >= 100_000_000) return _SCALES.millions;
  if (max >= 1_000_000) return _SCALES.thousands;
  return _SCALES.units;
}

/** The unit phrase printed once under the statement heading. */
export function amountScaleNote(scale: AmountScale): string {
  const ar = _isArabic();
  if (scale.key === "millions") return ar ? "جميع المبالغ بملايين الريالات السعودية" : "All amounts in millions of Saudi Riyals";
  if (scale.key === "thousands") return ar ? "جميع المبالغ بآلاف الريالات السعودية" : "All amounts in thousands of Saudi Riyals";
  return ar ? "جميع المبالغ بالريال السعودي" : "All amounts in Saudi Riyals";
}

/**
 * A scaled amount, with NO unit suffix — the unit is stated once by
 * `amountScaleNote`. Scaled figures drop to 1 decimal because a third decimal
 * of a million is noise; unscaled figures keep the house 2 decimals.
 */
export function formatScaled(value: number | null | undefined, scale: AmountScale): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (scale.factor === 1) return _currencyNum.format(n);
  return _scaledNum.format(n / scale.factor);
}
