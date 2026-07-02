// Centralized, locale-aware formatters. Arabic numerals + SAR currency, with
// tabular figures so columns line up in tables.

const _currency = new Intl.NumberFormat("ar-SA", {
  style: "currency",
  currency: "SAR",
  maximumFractionDigits: 0,
});

const _number = new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 1 });

const _percent = new Intl.NumberFormat("ar-SA", {
  style: "percent",
  maximumFractionDigits: 1,
});

export function formatCurrency(value: number | null | undefined): string {
  return _currency.format(Number(value) || 0);
}

export function formatNumber(value: number | null | undefined): string {
  return _number.format(Number(value) || 0);
}

/** value is a ratio (0..1). */
export function formatPercent(value: number | null | undefined): string {
  return _percent.format(Number(value) || 0);
}

export function formatQty(value: number | null | undefined, unit?: string): string {
  const n = _number.format(Number(value) || 0);
  return unit ? `${n} ${unit}` : n;
}

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
