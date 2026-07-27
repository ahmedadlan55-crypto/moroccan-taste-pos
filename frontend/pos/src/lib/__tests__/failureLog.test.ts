/**
 * lib/failureLog.ts — the durable record of a sale that did not go through.
 *
 * The properties that matter here are the DEFENSIVE ones. This log is written
 * from the money path on a device whose storage may be full, disabled, or
 * carrying whatever a previous build (or a curious owner) left behind, and it
 * is read by a manager who will act on what it says. So: never throw, never
 * render a half-record, never grow without bound, and never double-count the
 * same failure just because two call sites both noticed it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ENTRIES,
  __resetFailureLogCacheForTests,
  clearFailures,
  readFailures,
  recordFailure,
  subscribeFailures,
} from "../failureLog";

const KEY = "pos_v2_failure_log";

beforeEach(() => {
  localStorage.clear();
  __resetFailureLogCacheForTests();
});

describe("recording and reading", () => {
  it("keeps a failure across a reload (a fresh module read of localStorage)", () => {
    recordFailure({ id: "checkout:O1", kind: "checkout", orderId: "O1", message: "فشل الدفع", total: 46 });

    // Simulate the reload the in-memory lastReport could never survive: drop
    // the module cache and read storage cold.
    __resetFailureLogCacheForTests();
    const [entry] = readFailures();
    expect(entry).toMatchObject({ id: "checkout:O1", kind: "checkout", orderId: "O1", message: "فشل الدفع", total: 46 });
    expect(entry.at).toBeGreaterThan(0);
  });

  it("returns newest first", () => {
    recordFailure({ id: "a", message: "أول", at: 1_000 });
    recordFailure({ id: "b", message: "ثانٍ", at: 2_000 });
    expect(readFailures().map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("UPDATES rather than duplicates when the same id is recorded twice", () => {
    // App.tsx records a permanently-failed checkout keyed on the order; a retry
    // that fails again must not inflate the count a manager reads.
    recordFailure({ id: "checkout:O1", message: "المحاولة الأولى", at: 1_000 });
    recordFailure({ id: "checkout:O1", message: "المحاولة الثانية", at: 2_000 });
    const all = readFailures();
    expect(all).toHaveLength(1);
    expect(all[0].message).toBe("المحاولة الثانية");
  });

  it("generates distinct ids for id-less failures recorded in the same millisecond", () => {
    recordFailure({ message: "أ", at: 5_000 });
    recordFailure({ message: "ب", at: 5_000 });
    expect(readFailures()).toHaveLength(2);
  });

  it("refuses to store a blank row (no message = nothing a manager can act on)", () => {
    expect(recordFailure({ id: "x", message: "   " })).toBeNull();
    expect(recordFailure({ id: "x" })).toBeNull();
    expect(readFailures()).toEqual([]);
  });

  it("normalises an unknown kind instead of storing it verbatim", () => {
    recordFailure({ message: "؟", kind: "something-else" });
    expect(readFailures()[0].kind).toBe("other");
  });
});

describe("bounds", () => {
  it("is a ring buffer of the last MAX_ENTRIES, dropping the OLDEST", () => {
    for (let i = 0; i < MAX_ENTRIES + 15; i++) {
      recordFailure({ id: `f${i}`, message: `فشل ${i}`, at: 1_000 + i });
    }
    const all = readFailures();
    expect(all).toHaveLength(MAX_ENTRIES);
    expect(all[0].id).toBe(`f${MAX_ENTRIES + 14}`); // newest kept
    expect(all.some((e) => e.id === "f0")).toBe(false); // oldest dropped
  });

  it("clamps an oversized server message instead of storing it whole", () => {
    recordFailure({ id: "big", message: "خ".repeat(5_000) });
    expect(readFailures()[0].message.length).toBeLessThanOrEqual(300);
  });
});

describe("hostile storage", () => {
  it("reads corrupt JSON as an EMPTY log, never a crash or a half-record", () => {
    localStorage.setItem(KEY, "{not json at all");
    __resetFailureLogCacheForTests();
    expect(readFailures()).toEqual([]);
  });

  it("reads a non-array payload as empty", () => {
    localStorage.setItem(KEY, JSON.stringify({ nope: true }));
    __resetFailureLogCacheForTests();
    expect(readFailures()).toEqual([]);
  });

  it("drops individually malformed entries but keeps the valid ones", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        null,
        "a string",
        { id: "no-at", message: "بلا وقت" }, // missing `at`
        { id: "no-msg", at: 1_000 }, // missing message
        { id: "ok", at: 2_000, message: "سليم", kind: "checkout" },
      ]),
    );
    __resetFailureLogCacheForTests();
    const all = readFailures();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("ok");
  });

  it("never throws when localStorage itself is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordFailure({ id: "q", message: "امتلأ التخزين" })).not.toThrow();
    // The in-memory snapshot still serves this session, so the failure is at
    // least visible until the tab closes.
    expect(readFailures().map((e) => e.id)).toEqual(["q"]);
    setItem.mockRestore();
  });

  it("never throws when reading throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    __resetFailureLogCacheForTests();
    expect(() => readFailures()).not.toThrow();
    expect(readFailures()).toEqual([]);
    getItem.mockRestore();
  });
});

describe("clear + subscribe", () => {
  it("clearFailures empties both the snapshot and storage", () => {
    recordFailure({ id: "a", message: "أ" });
    clearFailures();
    expect(readFailures()).toEqual([]);
    __resetFailureLogCacheForTests();
    expect(readFailures()).toEqual([]);
  });

  it("notifies subscribers on record and on clear, and stops after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeFailures(seen);
    recordFailure({ id: "a", message: "أ" });
    expect(seen).toHaveBeenCalledTimes(1);
    clearFailures();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    recordFailure({ id: "b", message: "ب" });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("returns a REFERENTIALLY STABLE snapshot between changes (useSyncExternalStore contract)", () => {
    recordFailure({ id: "a", message: "أ" });
    const first = readFailures();
    expect(readFailures()).toBe(first); // same identity — no infinite render loop
    recordFailure({ id: "b", message: "ب" });
    expect(readFailures()).not.toBe(first); // …but a change does produce a new one
  });

  it("survives a subscriber that throws", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    subscribeFailures(bad);
    subscribeFailures(good);
    expect(() => recordFailure({ id: "a", message: "أ" })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
