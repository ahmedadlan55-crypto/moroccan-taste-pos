// TEMPORARY REFUTATION PROBE — delete after running.
import { describe, expect, it } from "vitest";
import { createAnalyticsFilterCodec } from "../lib/filters";
import { computePresetRange, DATE_RANGE_PRESETS } from "@/shared/ui/date-range-picker";

// Mirror of useUrlFilters.applySerialized (null => delete key).
function applySerialized(params: URLSearchParams, patch: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) params.delete(key);
    else params.set(key, value);
  }
}

describe("PROBE: to-date preset deep link", () => {
  it("dumps serialize/reparse for every preset", () => {
    const DAY_A = "2026-07-29";
    const DAY_B = "2026-08-05";
    const codecA = createAnalyticsFilterCodec(DAY_A);
    const codecB = createAnalyticsFilterCodec(DAY_B);
    const rows: string[] = [];
    for (const preset of DATE_RANGE_PRESETS) {
      if (preset === "custom") continue;
      // Start from an empty URL, exactly like a fresh page load.
      const start = new URLSearchParams();
      const base = codecA.parse(start);
      // DateRangePicker onChange -> patch({from,to,preset})
      const picked = { ...base, ...computePresetRange(preset, DAY_A), preset };
      const next = new URLSearchParams(start);
      applySerialized(next, codecA.serialize(picked));
      const url = next.toString();
      const reparsed = codecB.parse(new URLSearchParams(url));
      rows.push(
        `${preset.padEnd(12)} picked=${picked.from}..${picked.to} | url=${url || "(empty)"} | reopenedLater=${reparsed.from}..${reparsed.to} preset=${reparsed.preset}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log("\n" + rows.join("\n") + "\n");
    expect(rows.length).toBe(10);
  });
});
