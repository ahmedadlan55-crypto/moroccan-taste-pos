/**
 * Tender ladder — the cash quick-tender buttons, DERIVED from the bill.
 *
 * The payment screen used to hardcode «المبلغ بالضبط» / 50 / 100 / 200. That
 * set is wrong in both directions on a real till:
 *   - it offers notes BELOW the bill (a 118.00 order showed 50 and 100, two
 *     buttons that can only ever under-tender), and
 *   - it has no 500 at all, so a customer handing a 500 note on a 460.00 bill
 *     costs the cashier three extra numpad taps.
 *
 * The ladder is computed instead, and every entry is a legal tender for THIS
 * bill (never below the total):
 *
 *   1. the exact amount (always first — it is the smallest legal tender),
 *   2. the next multiple of 5, of 10 and of 50 at or above the total
 *      (the "round it up" reflexes a cashier already has),
 *   3. the first TWO Saudi banknotes at or above the total (what the customer
 *      is most likely to physically hand over).
 *
 * Then: dedupe, drop anything below the total, sort ascending, cap at 5 so the
 * row still fits one line on a till without wrapping.
 *
 * Pure and dependency-free apart from round2 — unit-tested in
 * __tests__/tender.test.ts.
 */
import { round2 } from "./cartMath";

/** Saudi banknote denominations in circulation, ascending. */
export const SAUDI_NOTES: readonly number[] = [5, 10, 20, 50, 100, 200, 500];

/** How many notes from SAUDI_NOTES the ladder offers (the two most likely). */
export const LADDER_NOTE_COUNT = 2;

/** Row capacity — five buttons is the most that stays tappable on a 5" till. */
export const TENDER_LADDER_MAX = 5;

/** The rounding reflexes, in the order a cashier reaches for them. */
const LADDER_STEPS: readonly number[] = [5, 10, 50];

/**
 * Smallest multiple of `step` that is ≥ total.
 *
 * The epsilon matters: an exact bill like 50.00 divides to 10.000000000000002
 * in binary floating point for some totals, and a naive Math.ceil would then
 * offer 55 as "the next multiple of 5" instead of deduping against the exact
 * amount.
 */
function nextMultipleAtOrAbove(total: number, step: number): number {
  return round2(Math.ceil(total / step - 1e-9) * step);
}

/**
 * The quick-tender ladder for a bill.
 *
 * @param total the payable total (SAR)
 * @returns ascending, deduped, ≤5 entries, none below `total`; the exact
 *          amount is always entry 0. An empty array for a non-positive total
 *          (nothing to tender against) — the caller renders no row.
 */
export function tenderLadder(total: number): number[] {
  const exact = round2(Number(total) || 0);
  if (!(exact > 0)) return [];

  const candidates: number[] = [exact];
  for (const step of LADDER_STEPS) candidates.push(nextMultipleAtOrAbove(exact, step));

  let notesTaken = 0;
  for (const note of SAUDI_NOTES) {
    if (note < exact) continue;
    candidates.push(note);
    if (++notesTaken >= LADDER_NOTE_COUNT) break;
  }

  const seen = new Set<number>();
  const ladder: number[] = [];
  for (const candidate of candidates) {
    const value = round2(candidate);
    // A note can be smaller than the next multiple of 50 (a 6.00 bill takes
    // the 10 and 20 notes but rounds to 50), so the ascending order is only
    // true after the sort below — never assume the collection order.
    if (value < exact || seen.has(value)) continue;
    seen.add(value);
    ladder.push(value);
  }

  ladder.sort((a, b) => a - b);
  return ladder.slice(0, TENDER_LADDER_MAX);
}
