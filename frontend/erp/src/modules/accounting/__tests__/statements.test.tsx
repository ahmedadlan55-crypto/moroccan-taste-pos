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

beforeEach(() => get.mockReset());

/** The row ids in document order — the statement's reading order. */
function statementOrder(): string[] {
  return [...document.querySelectorAll("[data-statement-row]")].map(
    (el) => el.getAttribute("data-statement-row") ?? "",
  );
}

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

describe("BalanceSheetPage renders a statement", () => {
  const BS = {
    currentAssets: [{ id: "a1", code: "1101", name: "الصندوق", balance: 500, level: 3 }],
    nonCurrentAssets: [],
    currentLiab: [{ id: "l1", code: "2101", name: "ذمم دائنة", balance: 200, level: 3 }],
    nonCurrentLiab: [],
    equityItems: [{ id: "e1", code: "3101", name: "رأس المال", balance: 300, level: 3 }],
    totCA: 500, totNCA: 0, totCL: 200, totNCL: 0,
    totalAssets: 500, totalLiabilities: 200, totEq: 300,
    netIncome: 0, isBalanced: true, asOfDate: "2026-08-14",
  };

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
