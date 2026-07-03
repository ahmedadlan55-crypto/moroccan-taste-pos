/**
 * Number/date formatting — ENGLISH digits (0-9) everywhere, per spec.
 * All UI numbers flow through here; never use toLocaleString('ar-*') which
 * would emit Eastern-Arabic digits (٠-٩).
 */

const num2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 1234.5 → "1,234.50" */
export function fmt2(n: number): string {
  return num2.format(Number.isFinite(n) ? n : 0);
}

/** 1234 → "1,234" */
export function fmtInt(n: number): string {
  return numInt.format(Number.isFinite(n) ? n : 0);
}

/** Money with the currency word — "1,234.50 ر.س" (digits stay English). */
export function fmtMoney(n: number): string {
  return `${fmt2(n)} ر.س`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-07-03 14:05" — ISO-ish, unambiguous, English digits. */
export function fmtDateTime(d: Date | number | string = new Date()): string {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

/** "14:05:22" */
export function fmtTime(d: Date | number | string = new Date()): string {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
}

/** Short local reference for offline receipts: last 8 of the ULID. */
export function shortRef(id: string): string {
  return id.slice(-8).toUpperCase();
}
