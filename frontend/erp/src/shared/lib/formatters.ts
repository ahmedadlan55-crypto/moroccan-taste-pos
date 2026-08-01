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

/** "1,234.50 ر.س" — English digits, Arabic currency label. */
export function formatCurrency(value: number | null | undefined): string {
  return `${_currencyNum.format(Number(value) || 0)} ر.س`;
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
