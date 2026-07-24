// Sales Analytics Hub — URL filter codec contract.
//
// Pins: the concrete last30 defaults, clean-URL serialization (defaults →
// null), lossless round-trips, invalid-raw fallbacks, and — critically — the
// CANONICAL param names from/to/brandId/branchId that legacy report redirects
// target (renaming any of them breaks the redirect contract).
import { describe, expect, it } from "vitest";
import {
  computeAnalyticsDefaults,
  createAnalyticsFilterCodec,
  nonDefaultFilterKeys,
  type AnalyticsFilters,
} from "../lib/filters";

const TODAY = "2026-07-24";

function parseQS(qs: Record<string, string>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) sp.set(k, v);
  return sp;
}

describe("analytics filter codec", () => {
  const codec = createAnalyticsFilterCodec(TODAY);

  it("computes last30 defaults with CONCRETE dates", () => {
    const d = computeAnalyticsDefaults(TODAY);
    expect(d).toEqual({
      from: "2026-06-25",
      to: "2026-07-24",
      preset: "last30",
      compare: "none",
      businessDay: true,
      taxIncl: false,
    });
  });

  it("parses an empty URL to the full default state", () => {
    const f = codec.parse(new URLSearchParams());
    expect(f).toEqual({
      from: "2026-06-25",
      to: "2026-07-24",
      preset: "last30",
      compare: "none",
      brandId: [],
      branchId: [],
      channel: [],
      orderType: [],
      businessDay: true,
      taxIncl: false,
    } satisfies AnalyticsFilters);
  });

  it("serializes the default state to ALL-null (clean URL)", () => {
    const serialized = codec.serialize(codec.parse(new URLSearchParams()));
    expect(Object.values(serialized).every((v) => v === null)).toBe(true);
  });

  it("owns exactly the canonical param names (from/to/brandId/branchId + the rest)", () => {
    const serialized = codec.serialize(codec.parse(new URLSearchParams()));
    expect(Object.keys(serialized).sort()).toEqual(
      [
        "from",
        "to",
        "preset",
        "compare",
        "brandId",
        "branchId",
        "channel",
        "orderType",
        "businessDay",
        "taxIncl",
      ].sort(),
    );
  });

  it("round-trips a fully non-default state losslessly", () => {
    const state: AnalyticsFilters = {
      from: "2026-01-01",
      to: "2026-01-31",
      preset: "custom",
      compare: "prevYear",
      brandId: ["B1", "B2"],
      branchId: ["BR9"],
      channel: ["pos", "online"],
      orderType: ["delivery"],
      businessDay: false,
      taxIncl: true,
    };
    const serialized = codec.serialize(state);
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(serialized)) if (v != null) sp.set(k, v);
    expect(codec.parse(sp)).toEqual(state);
    // CSV values live under the canonical names
    expect(sp.get("brandId")).toBe("B1,B2");
    expect(sp.get("branchId")).toBe("BR9");
    expect(sp.get("from")).toBe("2026-01-01");
    expect(sp.get("to")).toBe("2026-01-31");
  });

  it("falls back to defaults on malformed/unknown raw values", () => {
    const f = codec.parse(
      parseQS({ from: "31-01-2026", preset: "bogus", compare: "nope", businessDay: "maybe" }),
    );
    expect(f.from).toBe("2026-06-25");
    expect(f.preset).toBe("last30");
    expect(f.compare).toBe("none");
    expect(f.businessDay).toBe(true);
  });

  it("nonDefaultFilterKeys reports exactly the changed keys", () => {
    const base = codec.parse(new URLSearchParams());
    expect(nonDefaultFilterKeys(base, codec)).toEqual([]);
    const changed = { ...base, channel: ["pos"], taxIncl: true };
    expect(nonDefaultFilterKeys(changed, codec).sort()).toEqual(["channel", "taxIncl"]);
  });

  it("keeps a cleared selection distinguishable only when it differs from the default", () => {
    // default brandId is [] — clearing back to [] is the default again → null.
    const base = codec.parse(new URLSearchParams());
    expect(codec.serialize({ ...base, brandId: [] }).brandId).toBeNull();
    expect(codec.serialize({ ...base, brandId: ["B1"] }).brandId).toBe("B1");
  });
});
