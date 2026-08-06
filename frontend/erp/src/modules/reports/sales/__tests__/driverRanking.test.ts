import { describe, expect, it } from "vitest";
import { rankDrivers, type DriverRow } from "../lib/driverRanking";

function row(overrides: Partial<DriverRow> & Pick<DriverRow, "key">): DriverRow {
  return {
    key: overrides.key,
    label: overrides.label ?? overrides.key,
    current: overrides.current ?? null,
    previous: overrides.previous ?? null,
    deltaAbs: overrides.deltaAbs ?? null,
    deltaPct: overrides.deltaPct ?? null,
  };
}

describe("sales driver ranking", () => {
  it("selects the largest current contributor without mutating the input", () => {
    const rows = [
      row({ key: "small", current: 90 }),
      row({ key: "leader", current: 240 }),
      row({ key: "middle", current: 150 }),
    ];
    const before = rows.map((r) => r.key);

    expect(rankDrivers(rows).topContributor?.key).toBe("leader");
    expect(rows.map((r) => r.key)).toEqual(before);
  });

  it("ranks movement by absolute value rather than a misleading percentage", () => {
    const rows = [
      row({ key: "large-riyal-gain", current: 1_100, previous: 900, deltaAbs: 200, deltaPct: 22.22 }),
      row({ key: "large-percent-gain", current: 20, previous: 5, deltaAbs: 15, deltaPct: 300 }),
      row({ key: "large-riyal-decline", current: 700, previous: 1_000, deltaAbs: -300, deltaPct: -30 }),
      row({ key: "large-percent-decline", current: 1, previous: 10, deltaAbs: -9, deltaPct: -90 }),
    ];

    const result = rankDrivers(rows);
    expect(result.strongestGain?.key).toBe("large-riyal-gain");
    expect(result.biggestDecline?.key).toBe("large-riyal-decline");
  });

  it("keeps measured zero active and accepts an absolute gain from a zero base", () => {
    const zeroNow = row({ key: "zero-now", current: 0, previous: 40, deltaAbs: -40, deltaPct: -100 });
    const newDriver = row({ key: "new", current: 25, previous: 0, deltaAbs: 25, deltaPct: null });
    const result = rankDrivers([zeroNow, newDriver]);

    expect(result.topContributor).toBe(newDriver);
    expect(result.strongestGain).toBe(newDriver);
    expect(result.strongestGain?.deltaPct).toBeNull();
    expect(result.biggestDecline).toBe(zeroNow);
  });

  it("excludes unmeasured and non-finite values instead of turning them into zero", () => {
    const measured = row({ key: "measured", current: -5, previous: -2, deltaAbs: -3, deltaPct: -150 });
    const rows: DriverRow[] = [
      row({ key: "missing-current", current: null, previous: 100, deltaAbs: -100, deltaPct: -100 }),
      row({ key: "missing-previous", current: 50, previous: null, deltaAbs: 50, deltaPct: null }),
      row({ key: "missing-delta", current: 40, previous: 20, deltaAbs: null, deltaPct: 100 }),
      row({ key: "nan", current: Number.NaN, previous: 0, deltaAbs: Number.NaN, deltaPct: null }),
      row({ key: "infinite", current: Number.POSITIVE_INFINITY, previous: 0, deltaAbs: Number.POSITIVE_INFINITY, deltaPct: null }),
      measured,
    ];

    const result = rankDrivers(rows);
    expect(result.topContributor?.key).toBe("missing-previous");
    expect(result.strongestGain).toBeNull();
    expect(result.biggestDecline).toBe(measured);
  });

  it("does not classify an unchanged row as either a gain or decline", () => {
    const unchanged = row({ key: "same", current: 80, previous: 80, deltaAbs: 0, deltaPct: 0 });
    const result = rankDrivers([unchanged]);

    expect(result.topContributor).toBe(unchanged);
    expect(result.strongestGain).toBeNull();
    expect(result.biggestDecline).toBeNull();
  });

  it("breaks equal ranks by stable key, independent of response order", () => {
    const a = row({ key: "A", label: "Alpha", current: 100, previous: 90, deltaAbs: 10, deltaPct: 11.11 });
    const b = row({ key: "B", label: "Beta", current: 100, previous: 90, deltaAbs: 10, deltaPct: 11.11 });
    const declineA = row({ key: "DA", current: 20, previous: 30, deltaAbs: -10, deltaPct: -33.33 });
    const declineB = row({ key: "DB", current: 20, previous: 30, deltaAbs: -10, deltaPct: -33.33 });

    for (const rows of [[b, declineB, a, declineA], [declineA, a, declineB, b]]) {
      const result = rankDrivers(rows);
      expect(result.topContributor?.key).toBe("A");
      expect(result.strongestGain?.key).toBe("A");
      expect(result.biggestDecline?.key).toBe("DA");
    }
  });

  it("reports whether the source ranking was limited by the server row cap", () => {
    expect(rankDrivers([], true)).toEqual({
      topContributor: null,
      strongestGain: null,
      biggestDecline: null,
      scopeLimited: true,
    });
    expect(rankDrivers([], false).scopeLimited).toBe(false);
    expect(rankDrivers([]).scopeLimited).toBe(false);
  });
});
