/**
 * tenderLadder — the DERIVED cash quick-tender row.
 *
 * The payment screen used to hardcode exact/50/100/200, which on a real bill
 * is wrong in both directions: it offered notes BELOW the total (two buttons
 * that can only under-tender) and had no 500 at all, so a 500 note on a 460
 * bill cost three extra numpad taps. These tests pin the invariants the UI
 * leans on (exact-first, ascending, deduped, nothing below the total, ≤5) plus
 * the four bills from the brief.
 */
import { describe, expect, it } from "vitest";
import { SAUDI_NOTES, TENDER_LADDER_MAX, tenderLadder } from "../tender";

describe("tenderLadder — the specific bills", () => {
  it("37.25 → exact, the 40 round-up, then the 50 and 100 notes", () => {
    expect(tenderLadder(37.25)).toEqual([37.25, 40, 50, 100]);
  });

  it("118 → exact, 120, the 150 half-hundred, then the 200 and 500 notes", () => {
    expect(tenderLadder(118)).toEqual([118, 120, 150, 200, 500]);
  });

  it("460 → exact and 500 — the note the old hardcoded row could not offer", () => {
    // The whole motivating case: 460 is already a multiple of 5 and 10, so the
    // only useful second button is the 500 note the customer is holding.
    expect(tenderLadder(460)).toEqual([460, 500]);
  });

  it("46 → exact, 50, 100 (the old row's 200 is not a tender anyone reaches for)", () => {
    expect(tenderLadder(46)).toEqual([46, 50, 100]);
  });
});

describe("tenderLadder — invariants", () => {
  const bills = [0.5, 1, 4.99, 6, 12.4, 21, 37.25, 46, 50, 99.99, 101, 118, 200, 460, 499.5, 500, 640, 1234.56];

  it("entry 0 is always the exact amount", () => {
    for (const bill of bills) expect(tenderLadder(bill)[0]).toBe(Math.round(bill * 100) / 100);
  });

  it("is strictly ascending (so the row reads left→right as bigger notes)", () => {
    for (const bill of bills) {
      const ladder = tenderLadder(bill);
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  it("is deduped", () => {
    for (const bill of bills) {
      const ladder = tenderLadder(bill);
      expect(new Set(ladder).size).toBe(ladder.length);
    }
  });

  it("never offers a tender below the total (the old row's core defect)", () => {
    for (const bill of bills) {
      for (const v of tenderLadder(bill)) expect(v).toBeGreaterThanOrEqual(Math.round(bill * 100) / 100);
    }
  });

  it("never exceeds 5 entries — the row must not wrap on a till", () => {
    for (const bill of bills) expect(tenderLadder(bill).length).toBeLessThanOrEqual(TENDER_LADDER_MAX);
    // 101 genuinely produces six candidates (101/105/110/150/200/500); the cap
    // drops the largest, so the buttons stay the ones a cashier actually uses.
    expect(tenderLadder(101)).toEqual([101, 105, 110, 150, 200]);
  });

  it("sorts notes ahead of a larger round-up (a 6.00 bill takes 10 and 20 before 50)", () => {
    // Collection order is exact → ×5 → ×10 → ×50 → notes, which is NOT
    // ascending: the 50 round-up is collected before the 10 and 20 notes.
    expect(tenderLadder(6)).toEqual([6, 10, 20, 50]);
  });

  it("a bill above the largest note falls back to the round-ups alone", () => {
    // 640 is already a multiple of 5 and 10, and no note reaches it — so the
    // only extra button is the next multiple of 50.
    expect(tenderLadder(640)).toEqual([640, 650]);
  });

  it("a non-positive or non-finite total yields no row at all", () => {
    expect(tenderLadder(0)).toEqual([]);
    expect(tenderLadder(-5)).toEqual([]);
    expect(tenderLadder(Number.NaN)).toEqual([]);
  });

  it("an exact bill that IS a note does not repeat it", () => {
    expect(tenderLadder(50)).toEqual([50, 100]);
    expect(tenderLadder(500)).toEqual([500]);
  });

  it("every note it offers comes from the Saudi denominations", () => {
    const notes = new Set(SAUDI_NOTES);
    for (const bill of bills) {
      for (const v of tenderLadder(bill)) {
        // Entries are either the exact amount, a round-up multiple, or a note.
        const isExact = v === Math.round(bill * 100) / 100;
        const isMultiple = v % 5 === 0;
        expect(isExact || isMultiple || notes.has(v)).toBe(true);
      }
    }
  });
});
