// Sales Analytics Hub — URL filter codec contract.
//
// Pins: the concrete last30 defaults, clean-URL serialization (defaults →
// null), lossless round-trips, invalid-raw fallbacks, and — critically — the
// CANONICAL param names from/to/brandId/branchId that legacy report redirects
// target (renaming any of them breaks the redirect contract).
import { describe, expect, it } from "vitest";
import { DATE_RANGE_PRESETS } from "@/shared/ui/date-range-picker";
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
    // wave 4 added the five drill params (paymentMethod/hour/menuItemId/
    // categoryId/cashierId) — the default state now carries their empties.
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
      paymentMethod: [],
      hour: "",
      menuItemId: [],
      categoryId: [],
      cashierId: [],
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
        // wave-4 drill params
        "paymentMethod",
        "hour",
        "menuItemId",
        "categoryId",
        "cashierId",
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
      paymentMethod: ["cash", "card"],
      hour: "13",
      menuItemId: ["M1"],
      categoryId: ["C7"],
      cashierId: ["U3"],
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
    expect(sp.get("paymentMethod")).toBe("cash,card");
    expect(sp.get("hour")).toBe("13");
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

/* ── a preset link must mean what its label says ───────────────────────────
 * `to` on every to-date preset equals today = the codec's default, and a codec
 * omits its default. So `?preset=mtd` shipped `from` frozen and `to` absent,
 * and reopening it a week later gave a half-pinned window under an unchanged
 * label — neither what its author saw nor what the label claims. The
 * basis-of-preparation block now prints that range as the report's period, on
 * paper, so a self-consistent answer is required rather than a plausible one.
 */
describe("re-opening a preset link on a later day", () => {
  const PICKED = "2026-07-29";
  const LATER = "2026-08-05";

  /** Serialize on `pickedOn`, then re-parse the same URL on `openedOn`. */
  function roundTrip(preset: string, pickedOn: string, openedOn: string) {
    const a = createAnalyticsFilterCodec(pickedOn);
    const picked = a.parse(new URLSearchParams(`preset=${preset}`));
    const url = new URLSearchParams();
    for (const [k, v] of Object.entries(a.serialize(picked))) if (v != null) url.set(k, v);
    const b = createAnalyticsFilterCodec(openedOn);
    return { picked, url: url.toString(), reopened: b.parse(new URLSearchParams(url.toString())) };
  }

  it("a to-date preset re-evaluates, so the label stays true", () => {
    // Not 2026-07-01 … 2026-08-05 (the old half-pinned window), and not the
    // author's July either: month-to-date on 2026-08-05 IS August.
    const r = roundTrip("mtd", PICKED, LATER);
    expect(r.reopened.preset).toBe("mtd");
    expect(r.reopened.from).toBe("2026-08-01");
    expect(r.reopened.to).toBe(LATER);
  });

  it("'today' reopens as one day, never as an eight-day window", () => {
    const r = roundTrip("today", PICKED, LATER);
    expect(r.reopened.from).toBe(LATER);
    expect(r.reopened.to).toBe(LATER);
  });

  it("a CLOSED period is stable — it names a window that has ended", () => {
    // The whole point of lastMonth/lastQuarter/lastYear: a close does not move.
    for (const [preset, from, to] of [
      ["lastMonth", "2026-06-01", "2026-06-30"],
      ["lastQuarter", "2026-04-01", "2026-06-30"],
      ["lastYear", "2025-01-01", "2025-12-31"],
    ] as const) {
      const r = roundTrip(preset, PICKED, LATER);
      expect(r.reopened.from, `${preset} from`).toBe(from);
      expect(r.reopened.to, `${preset} to`).toBe(to);
    }
  });

  it("CUSTOM pins both dates verbatim — the way to share an exact window", () => {
    const a = createAnalyticsFilterCodec(PICKED);
    const picked = a.parse(new URLSearchParams("preset=custom&from=2026-03-01&to=2026-03-15"));
    const b = createAnalyticsFilterCodec(LATER);
    const reopened = b.parse(new URLSearchParams("preset=custom&from=2026-03-01&to=2026-03-15"));
    expect(picked.from).toBe("2026-03-01");
    expect(reopened.from).toBe("2026-03-01");
    expect(reopened.to).toBe("2026-03-15");
  });

  it("the window is never HALF-pinned — both dates come from one source", () => {
    // The defect in one assertion, and the only property that matters: a
    // from/to pair where one side is the author's and the other is the
    // reader's. Either outcome is legitimate — a fully pinned window (the URL
    // carried both dates) or a fully re-derived one (it carried neither) — but
    // a mixture is a window nobody chose.
    //
    // `yesterday` lands on the pinned side and `mtd` on the derived side, which
    // is why both are in the list: the rule is about halves, not about which
    // presets happen to write a `to`.
    for (const preset of DATE_RANGE_PRESETS.filter((p) => p !== "custom")) {
      const r = roundTrip(preset, PICKED, LATER);
      const authored = createAnalyticsFilterCodec(PICKED).parse(new URLSearchParams(`preset=${preset}`));
      const fresh = createAnalyticsFilterCodec(LATER).parse(new URLSearchParams(`preset=${preset}`));
      const got = [r.reopened.from, r.reopened.to];
      const isPinned = got[0] === authored.from && got[1] === authored.to;
      const isDerived = got[0] === fresh.from && got[1] === fresh.to;
      expect(
        isPinned || isDerived,
        `${preset} reopened as ${got.join("..")} — neither the authored ` +
          `${authored.from}..${authored.to} nor a fresh ${fresh.from}..${fresh.to}`,
      ).toBe(true);
    }
  });
});
