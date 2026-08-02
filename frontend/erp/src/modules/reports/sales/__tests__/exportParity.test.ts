// The exported file must be on the SAME tax basis as the screen it came from.
//
// THE DEFECT
//   The tax toggle is not a server flag — the backend planner has no `taxMode`
//   at all. It is a CLIENT-SIDE metric swap (net_ex_vat → net_incl_vat) that
//   `queryBodyToWireRequest` applies on the SCREEN path. `buildExportRequest`
//   is the EXPORT path and never applied it.
//
//   So with the incl-VAT chip on, the screen showed VAT-inclusive figures and
//   the downloaded file contained EX-VAT figures under the same column header.
//   Two different numbers, one name, no note of the basis anywhere in the file
//   — and that file is the copy that gets emailed and filed.
//
// WHY THESE TESTS COMPARE THE TWO BUILDERS AGAINST EACH OTHER
//   Asserting "the export asks for net_incl_vat" would pass a fix that swapped
//   the export while the screen changed later. The contract is PARITY, so the
//   assertions are screen-vs-export on the same filters — the property that
//   actually has to hold.
import { describe, expect, it } from "vitest";
import {
  buildExportColumns,
  buildExportRequest,
  buildFiltersBody,
  queryBodyToWireRequest,
  setPageExportRequest,
  type AnalyticsQueryBody,
} from "../lib/api";
import { createAnalyticsFilterCodec } from "../lib/filters";
import type { TFunction } from "@/i18n";

const SEGMENT = "export-parity-fixture";
const METRICS = ["net_ex_vat", "orders"];
const DIMENSIONS = ["business_day"];

setPageExportRequest(SEGMENT, () => ({
  metrics: METRICS,
  dimensions: DIMENSIONS,
  sort: [{ by: "net_ex_vat", dir: "desc" }],
}));

/** Filters at a fixed date, with the tax basis flipped per test. */
function filtersWith(taxIncl: boolean) {
  const codec = createAnalyticsFilterCodec("2026-07-29");
  const parsed = codec.parse(new URLSearchParams("preset=custom&from=2026-07-01&to=2026-07-31"));
  return { ...parsed, taxIncl };
}

/** What the SCREEN actually puts on the wire for the same page + filters. */
function screenRequest(taxIncl: boolean) {
  const body: AnalyticsQueryBody = {
    metrics: METRICS,
    dimensions: DIMENSIONS,
    sort: [{ by: "net_ex_vat", dir: "desc" }],
    ...buildFiltersBody(filtersWith(taxIncl)),
  };
  return queryBodyToWireRequest(body);
}

/**
 * A stub that RESOLVES every key to a distinct label.
 *
 * It must not echo the path: buildExportColumns treats label === path as a
 * dictionary miss and DROPS the column (its own documented contract), so an
 * echoing stub silently produces zero columns and the assertions below would
 * be testing the miss-path rather than the header.
 */
const t = ((key: string) => `label:${key}`) as unknown as TFunction;

describe("tax basis: screen and export ask for the same figures", () => {
  it("ex-VAT — both request net_ex_vat", () => {
    expect(buildExportRequest(SEGMENT, filtersWith(false)).metrics).toEqual(
      screenRequest(false).metrics,
    );
  });

  it("incl-VAT — both request net_incl_vat, not one of each", () => {
    const screen = screenRequest(true);
    const exported = buildExportRequest(SEGMENT, filtersWith(true));
    expect(screen.metrics).toContain("net_incl_vat");
    expect(
      exported.metrics,
      "the file would carry ex-VAT figures under an incl-VAT header",
    ).toEqual(screen.metrics);
  });

  it("the SORT metric is swapped too, or the file is ordered by a column it does not contain", () => {
    const screen = screenRequest(true);
    const exported = buildExportRequest(SEGMENT, filtersWith(true));
    expect(exported.sort?.[0]?.by).toBe(screen.sort?.[0]?.by);
    expect(exported.sort?.[0]?.by).toBe("net_incl_vat");
  });

  it("the two bases really do differ — otherwise this whole file proves nothing", () => {
    // If the swap were a no-op these tests would pass vacuously.
    expect(buildExportRequest(SEGMENT, filtersWith(true)).metrics).not.toEqual(
      buildExportRequest(SEGMENT, filtersWith(false)).metrics,
    );
  });

  it("every other part of the request already matched, and still does", () => {
    const screen = screenRequest(true);
    const exported = buildExportRequest(SEGMENT, filtersWith(true));
    expect(exported.range).toEqual(screen.range);
    expect(exported.dateBasis).toEqual(screen.dateBasis);
    expect(exported.dimensions).toEqual(screen.dimensions);
  });
});

describe("the file's column headers follow the basis", () => {
  it("names the incl-VAT metric, so the spreadsheet is self-describing", () => {
    // buildExportColumns resolves labels from the REQUEST, so the swap carries
    // its own header. Without this the file would say "ex. VAT" over incl-VAT
    // numbers — worse than an unlabelled column, because it asserts a basis.
    const cols = buildExportColumns(buildExportRequest(SEGMENT, filtersWith(true)), t);
    const keys = cols.map((c) => c.key);
    expect(keys).toContain("net_incl_vat");
    expect(keys).not.toContain("net_ex_vat");
  });

  it("names the ex-VAT metric when the toggle is off", () => {
    const cols = buildExportColumns(buildExportRequest(SEGMENT, filtersWith(false)), t);
    expect(cols.map((c) => c.key)).toContain("net_ex_vat");
  });
});

describe("a page that asks for net_incl_vat itself is left alone", () => {
  it("does not double-swap into a metric that does not exist", () => {
    const OWN = "export-parity-own-incl";
    setPageExportRequest(OWN, () => ({
      metrics: ["net_incl_vat", "orders"],
      dimensions: DIMENSIONS,
    }));
    expect(buildExportRequest(OWN, filtersWith(true)).metrics).toEqual(["net_incl_vat", "orders"]);
  });
});
