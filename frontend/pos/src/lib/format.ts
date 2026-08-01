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

/** Quantities are whole (QtyPad/Numpad enforce it) but a cart persisted before
 *  that rule — or resumed from an offline queue — can still hold a fraction.
 *  3 decimals matches the DB columns, and minimumFractionDigits 0 keeps the
 *  common case clean: "2", not "2.000". */
const numQty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

/** 1234.5 → "1,234.50" */
export function fmt2(n: number): string {
  return num2.format(Number.isFinite(n) ? n : 0);
}

/** 1234 → "1,234" */
export function fmtInt(n: number): string {
  return numInt.format(Number.isFinite(n) ? n : 0);
}

/**
 * Quantity — NEVER rounds. 2 → "2", 0.5 → "0.5".
 *
 * fmtInt was wrong here: `maximumFractionDigits: 0` turned a 0.5 kg line into
 * "1" and a 0.4 kg line into "0" — a card badge reading 0 for an item that IS
 * in the cart. Whole quantities are now enforced at ENTRY (parseQtyInput +
 * applyIntegerKey), so this is the honest display of anything that slipped
 * through from an older cart rather than a licence to sell fractions.
 */
export function fmtQty(n: number): string {
  return numQty.format(Number.isFinite(n) ? n : 0);
}

/**
 * Money for the CUSTOMER-FACING price: a whole riyal renders bare ("18"), a
 * fractional one keeps its halalas ("18.40").
 *
 * Menu prices are tuned so the VAT-inclusive amount lands on a whole riyal
 * (scripts/round-prices-to-whole-riyal.js + the write guard in routes/menu.js),
 * so this reads clean in practice. The fractional branch is deliberate and must
 * NOT be "cleaned up" to always drop decimals: a row the tool could not fix has
 * to SHOW its halalas. Hiding them behind a display-only round is exactly the
 * screen-says-18 / invoice-says-18.40 bug this work exists to remove.
 */
export function fmtPrice(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return Number.isInteger(v) ? numInt.format(v) : num2.format(v);
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
