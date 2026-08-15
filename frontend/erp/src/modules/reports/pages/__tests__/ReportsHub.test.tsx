// `ReportsHub` — the shared catalogue renderer for the registry-driven
// sections. What it OWNS is the capability filter and the empty-family rule;
// the destinations themselves come from the registries (asserted in
// __tests__/operationalReports.test.ts) and the "never leaves /reports" rule is
// pinned for every catalogue in __tests__/reportDestinations.test.tsx.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import ReportsHub from "../ReportsHub";
import type { ReportSection } from "../../engine/types";
import { PEOPLE_REPORT_LINKS } from "../../people/directory";
import { OPERATIONS_REPORT_LINKS } from "../../operations/directory";

const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));

vi.mock("@/shared/permissions", () => ({
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
}));

function renderSection(section: ReportSection) {
  render(
    <I18nProvider>
      <MemoryRouter>
        <ReportsHub section={section} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("reports section directories", () => {
  beforeEach(() => {
    for (const key of Object.keys(caps)) delete caps[key];
  });

  afterEach(cleanup);

  it("removes empty families instead of exposing unavailable report links", () => {
    caps["pos.shifts.view"] = true;
    renderSection(OPERATIONS_REPORT_LINKS);

    expect(document.querySelector('[data-report-group="posControl"]')).toBeInTheDocument();
    // The governance family needs administration.audit / workflow.audit.view;
    // with neither granted the whole family goes, rather than showing rows that
    // open a permission-denied page.
    expect(document.querySelector('[data-report-group="governance"]')).toBeNull();
    expect(document.querySelector('[data-report-item="shift-variance"] a')).toHaveAttribute(
      "href",
      "/reports/operations/shift-variance",
    );
  });

  it("opens every row it does show inside its own section", () => {
    caps["people.payroll.view"] = true;
    renderSection(PEOPLE_REPORT_LINKS);

    const links = [...document.querySelectorAll("[data-report-action]")];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/reports\/people\/[a-z-]+$/);
    }
    // A payroll capability does not reveal attendance or custody.
    expect(document.querySelector('[data-report-item="attendance-summary"]')).toBeNull();
    expect(document.querySelector('[data-report-item="open-custody"]')).toBeNull();
  });

  it("shows the empty state when the reader may open nothing at all", () => {
    renderSection(PEOPLE_REPORT_LINKS);
    expect(document.querySelectorAll("[data-report-item]")).toHaveLength(0);
    expect(document.querySelector('[data-testid="report-directory-grid"]')).toBeNull();
  });
});
