/**
 * A report body that omits `limit` is silently capped at 50 rows by the server
 * (lib/analytics/planner.js DEFAULT_LIMIT), and nothing on screen says so.
 *
 * That is not a cosmetic cap. Two places where it changed what the owner could
 * see, both found by auditing the request bodies rather than the screens:
 *
 *  • THE PEAK MAP asks for weekday × hour = 7 × 24 = 168 rows, sorted weekday
 *    then hour. Cut at 50, the cut falls mid-week: Thursday, Friday, Saturday
 *    and Sunday — the busiest end of a restaurant week — were absent from the
 *    heat map entirely, with no notice.
 *  • THE EXECUTIVE DAILY DETAIL sits directly beneath a statement that totals
 *    the whole period. A 90-day range showed 50 rows under a 90-day total, so
 *    the detail could not foot to the summary above it. Meanwhile the CSV of
 *    the same report is complete: ExportService overrides the limit to
 *    MAX_LIMIT, so the screen and the file disagreed.
 *
 * WHY THIS FILE NO LONGER SCRAPES THE PAGE SOURCE
 *   The limits moved into lib/reportRegistry with the rest of each request, so
 *   these read the RESOLVED spec — the actual object the page spreads into its
 *   query body. That is the value the defect lives in; a regex over the source
 *   could only ever see a literal, and would go green the day a page computed
 *   the number instead of writing it.
 */
import { describe, expect, it } from "vitest";
import { reportQuerySpec } from "../lib/api";
import { createAnalyticsFilterCodec } from "../lib/filters";
import { LIMITS } from "../lib/contract";
import { REPORTS } from "../lib/reportRegistry";

const FILTERS = createAnalyticsFilterCodec("2026-07-29").parse(
  new URLSearchParams("preset=custom&from=2026-05-01&to=2026-07-31"),
);

describe("the peak map asks for every weekday", () => {
  const spec = reportQuerySpec("hours", "heatmap", FILTERS);

  it("groups by weekday × hour", () => {
    expect(spec.dimensions).toEqual(["weekday", "hour"]);
  });

  it("carries a limit that covers all 168 cells", () => {
    expect(
      spec.limit,
      "no explicit limit ⇒ the server caps at 50 and the weekend disappears",
    ).not.toBeUndefined();
    expect(spec.limit!).toBeGreaterThanOrEqual(7 * 24);
  });
});

describe("the executive daily detail can foot to the statement above it", () => {
  const spec = reportQuerySpec("executive", "daily", FILTERS);

  it("carries an explicit limit, not the server default", () => {
    expect(spec.limit, "no explicit limit ⇒ 50 rows under a whole-period total").not.toBeUndefined();
  });

  it("reaches the planner's own maximum, since a range may run to 400 days", () => {
    expect(spec.limit!).toBeGreaterThanOrEqual(LIMITS.MAX_LIMIT);
  });
});

describe("no declared query can exceed the planner's own page cap", () => {
  it("every limit in the registry is within MAX_LIMIT", () => {
    for (const report of REPORTS) {
      for (const q of report.queries) {
        if (q.limit == null) continue;
        expect(q.limit, `${report.id}/${q.id}`).toBeLessThanOrEqual(LIMITS.MAX_LIMIT);
      }
    }
  });
});
