// The two rebuilt statements — the P&L and the balance sheet — are STATEMENTS,
// not two-column account lists. What that means is testable and is tested here:
//   · the section subtotals a reader looks for really appear, in order;
//   · the bottom line is the SERVER's figure, in a real <tfoot>;
//   · account lines are indented beneath their section, not flat;
//   · nothing that is only a verdict about the run (the balance check) is
//     inside the printed document.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import { apiClient } from "@/shared/api";
import { I18nProvider } from "@/i18n";
import { IncomeStatementPage } from "../pages/IncomeStatement";
import { BalanceSheetPage } from "../pages/BalanceSheet";

const get = apiClient.get as Mock;

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider><MemoryRouter>{ui}</MemoryRouter></I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * Render at a specific URL.
 *
 * These pages read their whole state from the query string now, so a test that
 * mounts at "/" is testing the defaults, not the report. This is how the URL
 * itself is proven to drive the comparison — nothing is clicked.
 */
function wrapAt(ui: ReactNode, url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider><MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter></I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => get.mockReset());

/** The row ids in document order — the statement's reading order. */
function statementOrder(): string[] {
  return [...document.querySelectorAll("[data-statement-row]")].map(
    (el) => el.getAttribute("data-statement-row") ?? "",
  );
}

/**
 * The plain statement fixture, shared by both describes.
 *
 * Hoisted so the comparison tests can assert what the page does WITHOUT a
 * comparison against the very same data it renders with one — otherwise
 * "no second column" could pass simply because the fixture differed.
 */
const PNL_BASE = {
  revenue: [{ id: "r1", code: "4101", name: "مبيعات", balance: 1000, level: 3 }],
  totalRevenue: 1000,
  cogs: [{ id: "c1", code: "5101", name: "تكلفة المبيعات", balance: 400, level: 3 }],
  totalCOGS: 400,
  grossProfit: 600,
  opex: [{ id: "o1", code: "5201", name: "رواتب", balance: 150, level: 3 }],
  totalOpex: 150,
  gAndA: [], totalGAndA: 0,
  operatingIncome: 450,
  otherIncome: [], totalOtherInc: 0,
  otherExpense: [], totalOtherExp: 0,
  netIncome: 450,
};

// ── The comparative column ─────────────────────────────────────────────────
// The page carried a standing note: "/reports/income accepts startDate/endDate
// and nothing else… When the endpoint gains a comparative, this is a `groups`
// array and a second column." It has, and this is what proves it.
//
// What matters is not that a second column appears. It is that NOTHING on the
// page computes a prior figure — every one is the server's, produced by the
// same aggregate as the current column. The only arithmetic here is Δ, and it
// must refuse to subtract from an absent figure.
describe("IncomeStatementPage — the comparison column", () => {
  const WITH_COMPARE = {
    revenue: [{ id: "r1", code: "4101", name: "مبيعات", balance: 1000, level: 3, prior: 400 }],
    totalRevenue: 1000,
    cogs: [], totalCOGS: 0,
    grossProfit: 1000,
    opex: [], totalOpex: 0,
    gAndA: [], totalGAndA: 0,
    operatingIncome: 1000,
    otherIncome: [], totalOtherInc: 0,
    otherExpense: [], totalOtherExp: 0,
    netIncome: 1000,
    comparison: {
      from: "2025-01-01", to: "2025-12-31",
      totalRevenue: 400, totalCOGS: 0, totalOpex: 0, totalGAndA: 0,
      totalOtherInc: 0, totalOtherExp: 0,
      grossProfit: 400, operatingIncome: 400, netIncome: 400,
    },
  };

  it("renders no comparison column when the server sent none", async () => {
    get.mockResolvedValue({ ...PNL_BASE });
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");
    // A single money column. A second one here would mean the page invented it.
    expect(document.querySelectorAll("thead tr").length).toBe(1);
  });

  it("shows the server's prior figure and a Δ it computed from the two", async () => {
    get.mockResolvedValue(WITH_COMPARE);
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");

    // Two-tier header: one row naming the periods, one naming the columns.
    expect(document.querySelectorAll("thead tr").length).toBe(2);

    const row = document.querySelector('[data-statement-row="revenue:r1"]');
    const cells = [...(row?.querySelectorAll("td") ?? [])].map((c) => c.textContent ?? "");
    const joined = cells.join(" | ");
    // current 1,000 · prior 400 · Δ 600 — the Δ is the ONLY figure the page made.
    expect(joined).toContain("1,000");
    expect(joined).toContain("400");
    expect(joined).toContain("600");
  });

  it("prints a zero SUBTOTAL as 0.00, not a dash — so Δ reads honestly", async () => {
    // Caught by running the page, not by a test. A subtotal row read
    //     4,581.25  |  —  |  4,581.25
    // The prior was a real, server-computed ZERO, but zero-as-dash made it look
    // ABSENT — so the Δ beside it appeared to be a difference taken against
    // nothing at all.
    //
    // The spec's rule resolves it: a dash for zero on a DETAIL line, "0.00" on a
    // SUBTOTAL, because a subtotal of zero is a measured fact and must say so.
    get.mockResolvedValue({
      ...WITH_COMPARE,
      comparison: { ...WITH_COMPARE.comparison, totalRevenue: 0 },
      revenue: [{ id: "r1", code: "4101", name: "مبيعات", balance: 1000, level: 3, prior: 0 }],
    });
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");

    const totalRow = document.querySelector('[data-statement-row="revenue:total"]');
    const totalCells = [...(totalRow?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim());
    expect(totalCells).toContain("0.00");
    expect(totalCells).not.toContain("—");

    // …while a DETAIL line still uses the dash for zero.
    const detail = document.querySelector('[data-statement-row="revenue:r1"]');
    const detailCells = [...(detail?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim());
    expect(detailCells).toContain("—");
  });

  it("prints nothing for Δ when one side is absent", async () => {
    // A line the prior period has no figure for. Subtracting from an assumed 0
    // would render a fabricated -1,000 "decline" from an account that simply
    // did not exist then.
    get.mockResolvedValue({
      ...WITH_COMPARE,
      revenue: [{ id: "r1", code: "4101", name: "مبيعات", balance: 1000, level: 3, prior: null }],
    });
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");

    const row = document.querySelector('[data-statement-row="revenue:r1"]');
    const cells = [...(row?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim());

    // Asserted on the CELL, not the row text. A first version checked that the
    // row did not contain "-1,000" — but a Δ that subtracts from an assumed
    // zero renders "1,000", which the row already contained, so the mutant was
    // invisible. The Δ cell must be EMPTY.
    expect(cells[cells.length - 1]).toBe("");
    // …while the amount and prior cells still say what they should.
    expect(cells.join(" | ")).toContain("1,000");
  });
});

describe("IncomeStatementPage renders a statement", () => {
  const PNL = {
    revenue: [{ id: "r1", code: "4101", name: "مبيعات", balance: 1000, level: 3 }],
    totalRevenue: 1000,
    cogs: [{ id: "c1", code: "5101", name: "تكلفة المبيعات", balance: 400, level: 3 }],
    totalCOGS: 400,
    grossProfit: 600,
    opex: [{ id: "o1", code: "5201", name: "رواتب", balance: 150, level: 3 }],
    totalOpex: 150,
    gAndA: [],
    totalGAndA: 0,
    operatingIncome: 450,
    otherIncome: [],
    totalOtherInc: 0,
    otherExpense: [],
    totalOtherExp: 0,
    netIncome: 450,
  };

  it("orders revenue → COGS → gross profit → opex → operating income, and indents the accounts", async () => {
    get.mockResolvedValue(PNL);
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");

    expect(statementOrder()).toEqual([
      "revenue",
      "revenue:r1",
      "revenue:total",
      "cogs",
      "cogs:c1",
      "cogs:total",
      "gross-profit",
      "opex",
      "opex:o1",
      "opex:total",
      "operating-income",
    ]);

    // An account line sits one level in from its section heading.
    expect(document.querySelector('[data-statement-row="revenue"]')).toHaveAttribute("data-statement-depth", "0");
    expect(document.querySelector('[data-statement-row="revenue:r1"]')).toHaveAttribute("data-statement-depth", "1");
    // Subtotals are marked as such, so print and CSV can tell them from lines.
    expect(document.querySelector('[data-statement-row="gross-profit"]')).toHaveAttribute(
      "data-statement-kind",
      "subtotal",
    );
  });

  it("puts the server's net income in a real footer and never sums the rows itself", async () => {
    // netIncome deliberately DISAGREES with revenue − cogs − opex. The footer
    // must print the server's figure; a client-side sum would print 450.
    get.mockResolvedValue({ ...PNL, netIncome: 999 });
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");

    const tfoot = document.querySelector("tfoot[data-statement-totals='server']");
    expect(tfoot).not.toBeNull();
    expect(tfoot!.textContent).toContain("999.00");
    expect(tfoot!.textContent).not.toContain("450.00");
  });

  it("omits a section that has neither lines nor a total instead of printing an empty heading", async () => {
    get.mockResolvedValue(PNL);
    wrap(<IncomeStatementPage />);
    await screen.findByText("مبيعات");

    expect(statementOrder()).not.toContain("g-and-a");
    expect(statementOrder()).not.toContain("other-income");
  });

  it("refuses the route's all-zero degraded payload rather than showing a statement of zeros", async () => {
    get.mockResolvedValue({
      revenue: [], totalRevenue: 0, cogs: [], totalCOGS: 0, grossProfit: 0,
      opex: [], totalOpex: 0, gAndA: [], totalGAndA: 0, operatingIncome: 0,
      otherIncome: [], totalOtherInc: 0, otherExpense: [], totalOtherExp: 0,
      netIncome: 0, degraded: true,
    });
    wrap(<IncomeStatementPage />);

    // The error state, not a tidy zeroed statement. This is the defect this
    // repo has already paid for once: a route whose catch block answers 200
    // with every figure zeroed looks exactly like a company that traded
    // nothing, and stays invisible for months.
    await screen.findByText((_, el) => el?.getAttribute("data-state") === "error");
    expect(document.querySelector("[data-statement-table]")).toBeNull();
  });
});

/** The plain balance-sheet fixture, shared by both describes. */
const BS_BASE = {
  currentAssets: [{ id: "a1", code: "1101", name: "الصندوق", balance: 500, level: 3 }],
  nonCurrentAssets: [],
  currentLiab: [{ id: "l1", code: "2101", name: "ذمم دائنة", balance: 200, level: 3 }],
  nonCurrentLiab: [],
  equityItems: [{ id: "e1", code: "3101", name: "رأس المال", balance: 300, level: 3 }],
  totCA: 500, totNCA: 0, totCL: 200, totNCL: 0,
  totalAssets: 500, totalLiabilities: 200, totEq: 300,
  netIncome: 0, isBalanced: true, asOfDate: "2026-08-14",
};

// ── The balance sheet's comparative column ─────────────────────────────────
// A balance sheet compares two POINTS in time, so the control is a single date
// rather than a range picker, and the server answers with a `prior` on every
// line plus grand-total deltas.
//
// The rule the page must not break: it does not sum anything. A SECTION
// subtotal has no published prior, so its comparison cell is blank — a blank
// says "not published", where a summed figure would say "this is the answer".
describe("BalanceSheetPage — the comparison column", () => {
  const BS_CMP = {
    ...BS_BASE,
    currentAssets: [{ id: "a1", code: "1101", name: "الصندوق", balance: 500, level: 3, prior: 200 }],
    change: {
      totalAssets: { abs: 300, pct: 150 },
      totalLiabilities: { abs: 0, pct: 0 },
      totEq: { abs: 300, pct: 100 },
      netIncome: { abs: 0, pct: null },
    },
  };

  it("shows no comparison column when no compare date is in the URL", async () => {
    get.mockResolvedValue({ ...BS_BASE });
    wrap(<BalanceSheetPage />);
    await screen.findByText("الصندوق");
    expect(document.querySelectorAll("thead tr").length).toBe(1);
  });

  it("renders the server's prior on a line, and a Δ from the two", async () => {
    get.mockResolvedValue(BS_CMP);
    wrapAt(<BalanceSheetPage />, "/?asOf=2026-08-14&cmpAsOf=2025-08-14");
    await screen.findByText("الصندوق");

    expect(document.querySelectorAll("thead tr").length).toBe(2);

    const line = document.querySelector('[data-statement-row="current-assets:a1"]');
    const cells = [...(line?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim());
    expect(cells.join(" | ")).toContain("500");
    expect(cells.join(" | ")).toContain("200");
    expect(cells.join(" | ")).toContain("300");   // Δ = 500 − 200
  });

  it("leaves a SECTION subtotal's comparison blank rather than summing it", async () => {
    get.mockResolvedValue(BS_CMP);
    wrapAt(<BalanceSheetPage />, "/?asOf=2026-08-14&cmpAsOf=2025-08-14");
    await screen.findByText("الصندوق");

    // The server publishes no prior for a section subtotal. Summing the lines
    // here would be the page computing a figure — the one thing this file's
    // own rule forbids.
    const sectionTotal = document.querySelector('[data-statement-row="current-assets:total"]');
    const cells = [...(sectionTotal?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim());
    expect(cells[cells.length - 2]).toBe("");   // prior
    expect(cells[cells.length - 1]).toBe("");   // Δ
  });

  it("recovers a GRAND total's prior from the server's own delta", async () => {
    get.mockResolvedValue(BS_CMP);
    wrapAt(<BalanceSheetPage />, "/?asOf=2026-08-14&cmpAsOf=2025-08-14");
    await screen.findByText("الصندوق");

    // change.totalAssets.abs = 300, current = 500 ⇒ prior = 200. Rearranging
    // the server's arithmetic, not inventing a figure.
    const grand = document.querySelector('[data-statement-row="total-assets"]');
    const cells = [...(grand?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim());
    expect(cells.join(" | ")).toContain("200");
  });
});

describe("BalanceSheetPage renders a statement", () => {
  const BS = BS_BASE;

  it("runs assets → total assets → liabilities → total liabilities → equity, top to bottom", async () => {
    get.mockResolvedValue(BS);
    wrap(<BalanceSheetPage />);
    await screen.findByText("الصندوق");

    expect(statementOrder()).toEqual([
      "current-assets",
      "current-assets:a1",
      "current-assets:total",
      "total-assets",
      "current-liab",
      "current-liab:l1",
      "current-liab:total",
      "total-liabilities",
      "equity",
      "equity:e1",
      "equity:total",
      "total-equity",
    ]);
    expect(document.querySelector('[data-statement-row="total-assets"]')).toHaveAttribute(
      "data-statement-kind",
      "total",
    );
  });

  it("keeps the balance verdict OUT of the printed document", async () => {
    get.mockResolvedValue({ ...BS, isBalanced: false });
    wrap(<BalanceSheetPage />);
    await screen.findByText("الصندوق");

    const chip = screen.getByText(/غير متوازنة/);
    expect(chip.closest(".print-document"), "the balance chip must not print").toBeNull();
    expect(chip.className).toContain("no-print");
    // The statement itself IS inside the document.
    expect(document.querySelector("[data-statement-table]")?.closest(".print-document")).not.toBeNull();
  });
});
