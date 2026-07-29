// The basis of preparation must state the CHOICES, not a fixed paragraph.
//
// The failure this guards against is subtle and total: a disclosure block that
// prints the same words whatever the filter bar says is worse than no block at
// all, because it converts an open question into a confident wrong answer. Two
// printouts of "sales, July" genuinely differ when one is on business days
// (which run past midnight) and the other on calendar days — so the block has
// to move when the toggle moves.
//
// It also has to be INSIDE the printable area. The filter bar carries the same
// information on screen and is `.no-print`; that is exactly why this exists.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import { BasisOfPreparation } from "../components/BasisOfPreparation";
import type { AnalyticsFilters } from "../lib/filters";

const BASE: AnalyticsFilters = {
  from: "2026-07-01",
  to: "2026-07-31",
  preset: "lastMonth",
  compare: "none",
  businessDay: true,
  taxIncl: false,
  brandId: [],
  branchId: [],
  channel: [],
  orderType: [],
} as unknown as AnalyticsFilters;

function renderBasis(filters: Partial<AnalyticsFilters>, rest?: { watermark?: string | null; scope?: never }) {
  return render(
    <I18nProvider>
      <BasisOfPreparation filters={{ ...BASE, ...filters } as AnalyticsFilters} watermark={rest?.watermark} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("what the block states", () => {
  it("prints the period actually queried", () => {
    renderBasis({});
    const block = screen.getByTestId("basis-of-preparation");
    expect(block.textContent).toContain("2026-07-01");
    expect(block.textContent).toContain("2026-07-31");
  });

  it("follows the DATE basis toggle in both directions", () => {
    renderBasis({ businessDay: true });
    expect(screen.getByTestId("basis-of-preparation").textContent).toContain("يوم العمل");
    cleanup();
    renderBasis({ businessDay: false });
    const block = screen.getByTestId("basis-of-preparation");
    expect(block.textContent).toContain("اليوم التقويمي");
    expect(block.textContent).not.toContain("يوم العمل");
  });

  it("follows the TAX basis toggle in both directions", () => {
    renderBasis({ taxIncl: false });
    expect(screen.getByTestId("basis-of-preparation").textContent).toContain("دون ضريبة القيمة المضافة");
    cleanup();
    renderBasis({ taxIncl: true });
    expect(screen.getByTestId("basis-of-preparation").textContent).toContain("شامل ضريبة القيمة المضافة");
  });

  it("says 'the whole company' rather than omitting the scope line", () => {
    // An absent line leaves the reader to assume the scope, and an assumption
    // is the thing this block exists to remove.
    renderBasis({});
    expect(screen.getByTestId("basis-of-preparation").textContent).toContain("كل العلامات والفروع");
  });

  it("states the three treatments a reader would otherwise have to guess", () => {
    renderBasis({});
    const text = screen.getByTestId("basis-of-preparation").textContent ?? "";
    expect(text, "voided orders").toContain("الملغاة مستبعَدة");
    expect(text, "returns netted in the period recorded").toContain("سُجِّلت فيها");
    expect(text, "cost is the at-sale snapshot").toContain("لقطة وقت البيع");
  });

  it("shows the data watermark when there is one, and omits the line when there is not", () => {
    renderBasis({}, { watermark: "2026-07-31T21:00:00.000Z" });
    expect(screen.getByTestId("basis-of-preparation").textContent).toContain("البيانات حتى");
    cleanup();
    renderBasis({}, { watermark: null });
    expect(screen.getByTestId("basis-of-preparation").textContent).not.toContain("البيانات حتى");
  });
});

/* ── the scope line, after the audit ───────────────────────────────────────
 * The block shipped taking its scope as an OPTIONAL prop that the hub never
 * passed, so it printed "All brands, branches, channels and order types" on
 * every report — including one filtered to a single branch and channel. On a
 * printed accounting document that is not a missing disclosure, it is a false
 * one. It now reads the filters it is already handed, and these pin that.
 */
describe("the scope line", () => {
  it("says 'the whole company' only when nothing is actually pinned", () => {
    renderBasis({});
    expect(screen.getByTestId("basis-of-preparation").textContent).toContain("كل العلامات والفروع");
  });

  it("names each pinned dimension with its count, and drops the 'all' claim", () => {
    renderBasis({ branchId: ["b7"], channel: ["c1", "c2"] } as Partial<AnalyticsFilters>);
    const text = screen.getByTestId("basis-of-preparation").textContent ?? "";
    expect(text, "still claiming the whole company on a filtered report").not.toContain("كل العلامات والفروع");
    expect(text).toContain("الفرع");
    expect(text).toContain("قناة البيع");
    expect(text).toContain("2");
  });

  it("picks up a drill pin too — the hour a heat-map click left on the URL", () => {
    renderBasis({ hour: "13" } as Partial<AnalyticsFilters>);
    const text = screen.getByTestId("basis-of-preparation").textContent ?? "";
    expect(text).not.toContain("كل العلامات والفروع");
    expect(text).toContain("13");
  });
});
