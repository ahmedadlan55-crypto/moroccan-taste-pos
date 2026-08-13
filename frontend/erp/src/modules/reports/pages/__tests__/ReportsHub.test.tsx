import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import ReportsHub from "../ReportsHub";
import { REPORT_SECTIONS } from "../../reportLinks";

const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));

vi.mock("@/shared/permissions", () => ({
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
}));

function renderSection(path: string) {
  render(
    <I18nProvider>
      <MemoryRouter>
        <ReportsHub section={REPORT_SECTIONS[path]} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("reports section directories", () => {
  beforeEach(() => {
    for (const key of Object.keys(caps)) delete caps[key];
  });

  afterEach(cleanup);

  it("groups the financial library and hides finance-only destinations", () => {
    caps["accounting.reports.view"] = true;
    renderSection("/reports/financial");

    expect(document.querySelectorAll("[data-report-group]")).toHaveLength(3);
    expect(document.querySelector('[data-report-item="gl-income-statement"] a')).toHaveAttribute("href", "/accounting/income-statement");
    expect(document.querySelector('[data-report-item="gl-trial-balance"]')).toBeNull();
    expect(document.querySelector('[data-report-item="gl-sales-posting"]')).toBeNull();
  });

  it("shows the finance control reports only after the exact capability is granted", () => {
    caps["accounting.reports.view"] = true;
    caps["finance.reports.view"] = true;
    renderSection("/reports/financial");

    expect(document.querySelector('[data-report-item="gl-trial-balance"]')).toBeInTheDocument();
    expect(document.querySelector('[data-report-item="gl-sales-posting"]')).toBeInTheDocument();
    expect(screen.getByTestId("report-directory").querySelectorAll("[data-report-item]")).toHaveLength(12);
  });

  it("removes empty families instead of exposing unavailable report links", () => {
    caps["pos.shifts.view"] = true;
    renderSection("/reports/operations");

    expect(document.querySelector('[data-report-group="pos-control"]')).toBeInTheDocument();
    expect(document.querySelector('[data-report-group="operations-control"]')).toBeNull();
    expect(document.querySelector('[data-report-item="ops-shifts"] a')).toHaveAttribute("href", "/pos-admin/shifts");
  });
});
