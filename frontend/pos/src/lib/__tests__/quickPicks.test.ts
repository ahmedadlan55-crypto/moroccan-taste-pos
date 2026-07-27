/**
 * «الأكثر مبيعًا» / top sellers — the local tally behind the pinned rail chip.
 *
 * The whole feature is offline localStorage, so the contract worth pinning is
 * the one a browser can violate: a corrupted / foreign / hand-edited entry must
 * degrade to "no quick picks" and never to a crash or a bogus id; the ranking
 * must be deterministic; and a stale winner must actually fade.
 *
 * NOTE ON CACHING: getQuickPicks() memoises its derived list (useSyncExternalStore
 * requires a stable snapshot). beforeEach clears BOTH storage and that cache, so
 * a test that seeds localStorage directly can simply write the entry and read.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  clearQuickPicks,
  getQuickPicks,
  pruneQuickPicks,
  QUICK_PICKS_CATEGORY,
  QUICK_PICKS_LIMIT,
  recordPick,
  subscribeQuickPicks,
} from "../quickPicks";

const KEY = "pos_v2_quick_picks";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Seed the raw entry. Safe because beforeEach left the derived cache empty. */
function seed(entry: unknown) {
  localStorage.setItem(KEY, JSON.stringify(entry));
}

beforeEach(() => {
  localStorage.clear();
  clearQuickPicks(); // drops the memoised list too
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sentinel category", () => {
  it("cannot collide with a real DB category (those are Arabic menu names)", () => {
    expect(QUICK_PICKS_CATEGORY).toBe("__quick_picks__");
    expect(QUICK_PICKS_CATEGORY.startsWith("__")).toBe(true);
  });
});

describe("tally + ranking", () => {
  it("starts empty and ranks by sale count, best first", () => {
    expect(getQuickPicks()).toEqual([]);
    recordPick("M2");
    recordPick("M1");
    recordPick("M1");
    recordPick("M1");
    recordPick("M3");
    recordPick("M3");
    expect(getQuickPicks()).toEqual(["M1", "M3", "M2"]);
  });

  it("breaks a score tie deterministically (id asc) — the rail must not shuffle", () => {
    recordPick("B");
    recordPick("A");
    expect(getQuickPicks()).toEqual(["A", "B"]);
    expect(getQuickPicks()).toEqual(["A", "B"]); // stable across calls
  });

  it("returns at most QUICK_PICKS_LIMIT ids however many were tallied", () => {
    for (let i = 0; i < 40; i++) {
      for (let n = 0; n <= i; n++) recordPick(`ITM-${String(i).padStart(2, "0")}`);
    }
    const top = getQuickPicks();
    expect(top).toHaveLength(QUICK_PICKS_LIMIT);
    expect(top[0]).toBe("ITM-39"); // the most-sold one leads
  });

  it("persists to localStorage, so the ranking survives a reload", () => {
    recordPick("M1");
    recordPick("M1");
    recordPick("M2");
    const stored = JSON.parse(localStorage.getItem(KEY)!) as { v: number; items: Record<string, number> };
    expect(stored.v).toBe(1);
    expect(stored.items).toMatchObject({ M1: 2, M2: 1 });
    // A fresh derivation off that same entry reproduces the order.
    clearQuickPicks();
    seed(stored);
    expect(getQuickPicks()).toEqual(["M1", "M2"]);
  });
});

describe("weekly decay — yesterday's winner does not own the rail forever", () => {
  it("halves scores every week, so a fresh sale overtakes a stale lead", () => {
    // OLD: 8 sales four weeks ago → 8 × 0.5^4 = 0.5. NEW: 2 sales, same age.
    seed({ v: 1, decayedAt: Date.now() - 4 * WEEK_MS, items: { OLD: 8, NEW: 2 } });
    expect(getQuickPicks()).toEqual(["OLD", "NEW"]);
    // One sale today is worth more than eight sales a month ago.
    recordPick("NEW");
    expect(getQuickPicks()[0]).toBe("NEW");
  });

  it("drops an item that decayed into noise instead of keeping a zombie chip", () => {
    // 1 sale, ten weeks ago → 0.5^10 ≈ 0.001, below the noise floor.
    seed({ v: 1, decayedAt: Date.now() - 10 * WEEK_MS, items: { GHOST: 1 } });
    expect(getQuickPicks()).toEqual([]);
  });

  it("does NOT decay within the same shift (no storage churn on every tap)", () => {
    seed({ v: 1, decayedAt: Date.now() - 60_000, items: { A: 4, B: 2 } });
    expect(getQuickPicks()).toEqual(["A", "B"]);
    const stored = JSON.parse(localStorage.getItem(KEY)!) as { items: Record<string, number> };
    expect(stored.items).toEqual({ A: 4, B: 2 }); // untouched
  });
});

describe("shape validation — a corrupt entry yields NO picks, never a crash", () => {
  const badEntries: Array<[string, string]> = [
    ["not JSON at all", "}{"],
    ["a JSON array", JSON.stringify([1, 2, 3])],
    ["a JSON scalar", JSON.stringify("nope")],
    ["null", JSON.stringify(null)],
    ["a future/unknown version", JSON.stringify({ v: 99, decayedAt: Date.now(), items: { M1: 5 } })],
    ["items missing", JSON.stringify({ v: 1, decayedAt: Date.now() })],
    ["items as an array", JSON.stringify({ v: 1, decayedAt: Date.now(), items: ["M1"] })],
  ];

  for (const [label, raw] of badEntries) {
    it(`ignores ${label}`, () => {
      localStorage.setItem(KEY, raw);
      expect(() => getQuickPicks()).not.toThrow();
      expect(getQuickPicks()).toEqual([]);
    });
  }

  it("drops individual malformed rows but keeps the sane ones", () => {
    seed({
      v: 1,
      decayedAt: Date.now(),
      items: { GOOD: 5, NAN: "abc", NEG: -3, ZERO: 0, NULLISH: null, ["X".repeat(300)]: 99 },
    });
    expect(getQuickPicks()).toEqual(["GOOD"]);
  });

  it("never throws when storage itself is unavailable (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(getQuickPicks()).toEqual([]);
    expect(() => recordPick("M1")).not.toThrow();
  });

  it("refuses an absurd or blank id rather than letting it reach the grid", () => {
    recordPick("X".repeat(300));
    recordPick("   ");
    recordPick("");
    expect(getQuickPicks()).toEqual([]);
  });
});

describe("pruning against the live catalog", () => {
  it("drops ids the catalog no longer serves, keeps the rest", () => {
    recordPick("KEEP");
    recordPick("GONE");
    expect([...getQuickPicks()].sort()).toEqual(["GONE", "KEEP"]);
    pruneQuickPicks(new Set(["KEEP"]));
    expect(getQuickPicks()).toEqual(["KEEP"]);
  });

  it("is a no-op — and does NOT notify — when nothing needs dropping", () => {
    recordPick("KEEP");
    const seen = vi.fn();
    const off = subscribeQuickPicks(seen);
    pruneQuickPicks(new Set(["KEEP", "OTHER"]));
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

describe("subscribers — the rail and the grid re-render on a sale", () => {
  it("notifies on recordPick and stops after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeQuickPicks(seen);
    recordPick("M1");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    recordPick("M1");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("returns a REFERENTIALLY STABLE snapshot until the tally changes", () => {
    recordPick("M1");
    const a = getQuickPicks();
    expect(getQuickPicks()).toBe(a);
    // useSyncExternalStore loops forever if getSnapshot returns a new array on
    // every call — this identity check is the contract, not an optimisation.
    recordPick("M2");
    expect(getQuickPicks()).not.toBe(a);
  });
});
