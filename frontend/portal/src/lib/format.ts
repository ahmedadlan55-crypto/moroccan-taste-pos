// Formatters.
//
// THE RULE THAT MATTERS: every number renders with LATIN digits and LTR
// direction, in both languages. Arabic locales in Intl default to Arabic-Indic
// digits (٣٤٥), which this product does not use anywhere — and a numeric run
// left to the bidi algorithm inside an RTL page gets REORDERED, so "2 / 10"
// reads "10 / 2". Pair every formatted number with the `.num` class (index.css)
// wherever it sits inline with Arabic text.

const NUM_LOCALE = "en-US";

/**
 * ABSENT IS NOT ZERO. `Number(null)` is 0 and `Number("")` is 0, both finite —
 * so a `Number.isFinite` guard alone renders a MISSING salary, balance or hour
 * count as a confident "0". On a payslip screen that is not a formatting nit:
 * it is the app asserting a figure the server never sent. Nothing reaches
 * toLocaleString until it is a real number.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(v: number | null | undefined, decimals = 0): string {
  const n = num(v);
  if (n === null) return "—";
  return n.toLocaleString(NUM_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Money. Currency is SAR throughout the product; the symbol is caller-side. */
export function formatMoney(v: number | null | undefined, decimals = 2): string {
  const n = num(v);
  if (n === null) return "—";
  return n.toLocaleString(NUM_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Signed money, for a figure whose direction is the point (net impact). */
export function formatSigned(v: number | null | undefined, decimals = 2): string {
  const n = num(v);
  if (n === null) return "—";
  const s = formatMoney(Math.abs(n), decimals);
  if (n > 0) return `+${s}`;
  if (n < 0) return `−${s}`; // U+2212 MINUS SIGN, not a hyphen
  return s;
}

/**
 * Hours as "7:30" rather than 7.5 — how a person reads a shift.
 *
 * Unlike the money formatters this DOES render absent as "0:00", on purpose:
 * every caller reaches it through a total the server computed with
 * COALESCE(...,0), so a missing span here means "no hours", which is a known
 * quantity, not an unknown one.
 */
export function formatHours(v: number | null | undefined): string {
  const n = num(v);
  if (n === null || n === 0) return "0:00";
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  // 7.999 h rounds to 60 min — carry instead of printing "7:60".
  const hh = m === 60 ? h + 1 : h;
  const mm = m === 60 ? 0 : m;
  return `${sign}${hh}:${String(mm).padStart(2, "0")}`;
}

export function formatMinutes(v: number | null | undefined): string {
  const n = num(v);
  if (n === null) return "—";
  return formatHours(n / 60);
}

/** yyyy-mm-dd for the wire; never a locale string (the server parses it). */
export function toYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A date for reading. ALWAYS en-GB (dd/mm/yyyy) with Latin digits, in both
 * languages — the product-wide rule (see the root MutationObserver that pins
 * lang="en-GB" on every date input in the ERP). `ar-SA` would emit
 * Arabic-Indic digits, which is the bug that rule exists to prevent.
 */
export function formatDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10) || "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** A clock time, 24-hour. Accepts "2026-08-17T07:12:00Z" or "07:12:00". */
export function formatTime(v: string | null | undefined): string {
  if (!v) return "—";
  const s = String(v);
  // Bare "HH:MM:SS" — no date to parse, and constructing a Date from it would
  // silently attach today's date in the browser's zone.
  const bare = s.match(/^(\d{2}):(\d{2})/);
  if (bare) return `${bare[1]}:${bare[2]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Month name for a payslip row, in the active language. */
export function formatMonth(year: number | undefined, month: number | undefined, lang: string): string {
  if (!year || !month) return "—";
  const d = new Date(year, month - 1, 1);
  const name = d.toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { month: "long" });
  return `${name} ${year}`;
}
