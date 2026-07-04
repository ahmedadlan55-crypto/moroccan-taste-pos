// Centralized, locale-aware formatters — the ONLY place numbers/dates are
// formatted in the warehouse app.
//
// NUMBERING POLICY (approved): every numeral in the warehouse section renders
// as ENGLISH digits 0-9 (en-US grouping "1,234.50"), while labels and page
// direction stay Arabic RTL. Dates keep Arabic month names but Latin digits
// (ar-SA + numberingSystem 'latn'). Wrap numeric cells in dir="ltr" +
// tabular-nums at the call site for clean alignment inside RTL text.
// Guarded by lib/__tests__/formatters.test.ts (bans ٠١٢٣٤٥٦٧٨٩ in output).

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

// Arabic month/day names, LATIN digits (numberingSystem 'latn').
const _dateTime = new Intl.DateTimeFormat("ar-SA", {
  dateStyle: "medium",
  timeStyle: "short",
  numberingSystem: "latn",
});
const _date = new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", numberingSystem: "latn" });

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
