import { Suspense } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import FinancialReportsDirectory from "../FinancialReportsDirectory";
import { FINANCIAL_REPORTS, FINANCIAL_REPORT_BY_ID, isFinancialReportId, renderFinancialReport } from "../registry";

const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));

vi.mock("@/shared/permissions", () => ({
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
}));

function renderDirectory() {
  render(
    <I18nProvider>
      <MemoryRouter>
        <FinancialReportsDirectory />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const EXPECTED_IDS = [
  "income-statement",
  "balance-sheet",
  "cash-flow",
  "equity-changes",
  "general-ledger",
  "trial-balance",
  "financial-ratios",
  "ar-aging",
  "ap-aging",
  "profitability",
  "inventory-valuation",
];

describe("the financial reports registry", () => {
  it("carries exactly the eleven reports, each with a capability and a page", () => {
    expect(FINANCIAL_REPORTS.map((r) => r.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const report of FINANCIAL_REPORTS) {
      expect(report.cap, `${report.id} has no capability`).toBeTruthy();
      expect(report.labelKey, `${report.id} has no label key`).toMatch(/^misc\.reports\.links\./);
      expect(report.Page, `${report.id} has no page`).toBeTruthy();
    }
  });

  it("does NOT expose sales-posting — it writes journals, it is not a report", () => {
    expect(isFinancialReportId("sales-posting")).toBe(false);
    expect(FINANCIAL_REPORT_BY_ID["sales-posting"]).toBeUndefined();
    expect(renderFinancialReport("sales-posting", () => true)).toBeNull();
  });

  it("keeps the trial balance on its OWN capability rather than flattening the set", () => {
    // e2e/erp/trial-balance-rbac.spec.ts asserts a cashier is never offered the
    // trial balance. That only holds while this cap differs from the rest.
    expect(FINANCIAL_REPORT_BY_ID["trial-balance"]?.cap).toBe("finance.reports.view");
    const others = FINANCIAL_REPORTS.filter((r) => r.id !== "trial-balance");
    expect(others.every((r) => r.cap === "accounting.reports.view")).toBe(true);
  });

  it("refuses a report the caller lacks the capability for, even by direct URL", () => {
    // The router gates the SECTION on reports.view; each report carries its own
    // cap. Someone with reports.view alone had the catalogue row hidden and the
    // URL still working — the page then came back EMPTY, which reads as "the
    // company traded nothing" rather than "you may not see this".
    const denyAll = () => false;
    const el = renderFinancialReport("trial-balance", denyAll);
    expect(el).not.toBeNull();
    // Not the report — the denial.
    expect((el as { type?: unknown }).type).not.toBe(Suspense);
  });

  it("renders the report when the capability IS held", () => {
    const el = renderFinancialReport("trial-balance", (c) => c === "finance.reports.view");
    expect(el).not.toBeNull();
    expect((el as { type?: unknown }).type).toBe(Suspense);
  });

  it("renders an unknown id as null, leaving the not-found decision to the router", () => {
    expect(renderFinancialReport("not-a-report", () => true)).toBeNull();
    expect(renderFinancialReport("", () => true)).toBeNull();
  });
});

describe("the financial reports directory", () => {
  beforeEach(() => {
    for (const key of Object.keys(caps)) delete caps[key];
  });
  afterEach(cleanup);

  it("groups the eleven reports into three families, all linking inside /reports/", () => {
    caps["accounting.reports.view"] = true;
    caps["finance.reports.view"] = true;
    renderDirectory();

    expect(document.querySelectorAll("[data-report-group]")).toHaveLength(3);
    const items = document.querySelectorAll("[data-report-item]");
    expect(items).toHaveLength(11);

    for (const link of document.querySelectorAll("[data-report-action]")) {
      // The owner's rule: a report never navigates out of the reports section.
      expect(link.getAttribute("href")).toMatch(/^\/reports\/financial\/[a-z-]+$/);
    }
    expect(document.querySelector('[data-report-item="trial-balance"] a')).toHaveAttribute(
      "href",
      "/reports/financial/trial-balance",
    );
  });

  it("hides the trial balance from a reader who lacks finance.reports.view", () => {
    caps["accounting.reports.view"] = true;
    renderDirectory();

    expect(document.querySelector('[data-report-item="trial-balance"]')).toBeNull();
    expect(document.querySelector('[data-report-item="income-statement"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-report-item]")).toHaveLength(10);
  });

  it("drops a family whose every report is out of reach instead of showing an empty card", () => {
    caps["finance.reports.view"] = true;
    renderDirectory();

    // Only the trial balance survives, so its family is the only one left.
    expect(document.querySelectorAll("[data-report-group]")).toHaveLength(1);
    expect(document.querySelector('[data-report-group="ledger-control"]')).not.toBeNull();
    expect(document.querySelector('[data-report-group="financial-statements"]')).toBeNull();
  });
});
