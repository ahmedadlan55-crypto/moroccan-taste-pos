import { describe, expect, it } from "vitest";
import {
  normalizeAnalyticsResult,
  queryBodyToWireRequest,
  type AnalyticsQueryBody,
} from "../lib/api";

describe("analytics comparison adapter", () => {
  it("preserves the server absolute delta beside its percentage for rows and totals", () => {
    const result = normalizeAnalyticsResult(
      {
        data: {
          rows: [
            {
              keys: { branch: "B1" },
              labels: { branch: "Branch 1" },
              values: { net_incl_vat: 1_120.55 },
              compare: { net_incl_vat: 1_000 },
              delta: { net_incl_vat: { abs: 120.55, pct: 12.055 } },
            },
          ],
          totals: {
            values: { net_incl_vat: 1_120.55 },
            compare: { net_incl_vat: 1_000 },
            delta: { net_incl_vat: { abs: 120.55, pct: 12.055 } },
          },
        },
        meta: { freshness: { watermark: null }, maskedMetrics: [] },
      },
      ["branch"],
      { net_ex_vat: "net_incl_vat" },
    );

    expect(result.rows[0].delta?.net_ex_vat).toBe(12.055);
    expect(result.rows[0].deltaAbs?.net_ex_vat).toBe(120.55);
    expect(result.totalsDelta?.net_ex_vat).toBe(12.055);
    expect(result.totalsDeltaAbs?.net_ex_vat).toBe(120.55);
  });

  it("sends the active UI language as part of the planner request", () => {
    const body: AnalyticsQueryBody = {
      lang: "en",
      metrics: ["net_ex_vat"],
      dimensions: ["branch"],
      filters: { from: "2026-08-01", to: "2026-08-06" },
      dateBasis: "business_day",
      taxMode: "excl",
    };

    expect(queryBodyToWireRequest(body).lang).toBe("en");
  });
});
