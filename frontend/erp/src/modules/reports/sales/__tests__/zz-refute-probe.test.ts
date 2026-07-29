import { describe, expect, it } from "vitest";
import { createAnalyticsFilterCodec } from "../lib/filters";
import { computePresetRange, DATE_RANGE_PRESETS } from "@/shared/ui/date-range-picker";

describe("PROBE: to-date preset deep-link drift", () => {
  it("dumps serialize/reparse across days", () => {
    const day1 = "2026-07-29";
    const day2 = "2026-08-05";
    const c1 = createAnalyticsFilterCodec(day1);
    const c2 = createAnalyticsFilterCodec(day2);
    const base = c1.parse(new URLSearchParams());
    const lines: string[] = [];
    for (const p of DATE_RANGE_PRESETS) {
      if (p === "custom") continue;
      const r = computePresetRange(p, day1);
      const picked = { ...base, from: r.from, to: r.to, preset: p };
      const ser = c1.serialize(picked);
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(ser)) if (v != null) sp.set(k, v);
      const reparsedSameDay = c1.parse(sp);
      const reparsedNextWeek = c2.parse(sp);
      lines.push(
        `${p.padEnd(12)} picked=${r.from}..${r.to} | url=${sp.toString()} | sameDay=${reparsedSameDay.from}..${reparsedSameDay.to} | nextWeek=${reparsedNextWeek.from}..${reparsedNextWeek.to} preset=${reparsedNextWeek.preset}`,
      );
    }
    console.log("\n" + lines.join("\n") + "\n");
    expect(true).toBe(true);
  });
});
