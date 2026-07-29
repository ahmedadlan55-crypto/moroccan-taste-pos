/**
 * A report body that omits `limit` is silently capped at 50 rows by the server
 * (lib/analytics/planner.js:58 DEFAULT_LIMIT), and nothing on screen says so.
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
 * These pin the explicit limits. They read the request bodies the pages build,
 * because that is where the defect lives — a rendering test would have passed
 * throughout.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PAGES = path.resolve(__dirname, "../pages");

function source(file: string): string {
  return fs.readFileSync(path.join(PAGES, file), "utf8");
}

/** The body literal a page assigns to `<name>: AnalyticsQueryBody = { … }`. */
function bodyLiteral(src: string, name: string): string {
  const start = src.indexOf(`const ${name}: AnalyticsQueryBody = {`);
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  // Balance braces from the opening one so nested objects/arrays are included.
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced literal for ${name}`);
}

function limitOf(literal: string): number | null {
  const m = /\blimit:\s*(\d+)/.exec(literal);
  return m ? Number(m[1]) : null;
}

describe("the peak map asks for every weekday", () => {
  const literal = bodyLiteral(source("Hours.tsx"), "heatBody");

  it("groups by weekday × hour", () => {
    expect(literal).toContain('"weekday"');
    expect(literal).toContain('"hour"');
  });

  it("carries a limit that covers all 168 cells", () => {
    const limit = limitOf(literal);
    expect(limit, "no explicit limit ⇒ the server caps at 50 and the weekend disappears").not.toBeNull();
    expect(limit!).toBeGreaterThanOrEqual(7 * 24);
  });
});

describe("the executive daily detail can foot to the statement above it", () => {
  const literal = bodyLiteral(source("Executive.tsx"), "byDayBody");

  it("carries an explicit limit, not the server default", () => {
    expect(limitOf(literal), "no explicit limit ⇒ 50 rows under a whole-period total").not.toBeNull();
  });

  it("reaches the planner's own maximum, since a range may run to 400 days", () => {
    expect(limitOf(literal)!).toBeGreaterThanOrEqual(500);
  });
});
