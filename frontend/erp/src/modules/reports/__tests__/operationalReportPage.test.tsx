// A registry that typechecks proves nothing about what a manager sees. These
// render the real page against a stubbed endpoint and pin the three things a
// report page is for: it asks the server the question the filters describe, it
// prints the declared columns with real values, and it refuses the whole page
// to someone without the capability — not just the catalogue row.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/i18n";

const { caps, get } = vi.hoisted(() => ({
  caps: {} as Record<string, boolean>,
  get: vi.fn(),
}));

vi.mock("@/shared/permissions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
}));

// PARTIAL mock: ErrorState narrows on the real `ApiError` class, so replacing
// the whole module makes every failure path explode instead of rendering.
vi.mock("@/shared/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiClient: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { PeopleReportPage } from "../people/PeopleReportPage";
import { OperationsReportPage } from "../operations/OperationsReportPage";
import { OPERATIONS_REPORTS_SECTION } from "../operations/registry";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}

describe("a people / operations report page", () => {
  beforeEach(() => {
    for (const key of Object.keys(caps)) delete caps[key];
    get.mockReset();
    // The letterhead read must never decide whether a report renders.
    get.mockImplementation((path: string) => {
      if (path.includes("invoice-identity")) return Promise.reject(new Error("no identity"));
      return Promise.resolve([]);
    });
  });

  afterEach(cleanup);

  it("renders the declared columns and the server's values", async () => {
    caps["people.attendance.view"] = true;
    get.mockImplementation((path: string) => {
      if (path === "/hr/attendance/summary") {
        return Promise.resolve([
          {
            employeeId: "E-1",
            employeeNumber: "1042",
            employeeName: "سالم القحطاني",
            workingDaysInMonth: 22,
            presentDays: 20,
            absentDays: 2,
            lateDays: 3,
            totalLateMinutes: 47,
            totalOvertimeMinutes: 90,
          },
        ]);
      }
      return Promise.reject(new Error("unexpected call"));
    });

    render(
      <Wrapper>
        <PeopleReportPage reportId="attendance-summary" />
      </Wrapper>,
    );

    expect((await screen.findAllByText("سالم القحطاني")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1042").length).toBeGreaterThan(0);
    // A declared column that the server did not fill would render "—"; these
    // are the values, not the headers.
    expect(screen.getAllByText("47").length).toBeGreaterThan(0);
    // The month/year filter reaches the endpoint as the server's own params.
    const call = get.mock.calls.find(([path]) => path === "/hr/attendance/summary");
    expect(call?.[1]?.params).toEqual(
      expect.objectContaining({ month: expect.any(String), year: expect.any(String) }),
    );
  });

  it("refuses the page itself to a user without the report's capability", async () => {
    caps["people.attendance.view"] = true; // a DIFFERENT people capability
    render(
      <Wrapper>
        <PeopleReportPage reportId="payroll-register" />
      </Wrapper>,
    );

    await waitFor(() =>
      expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument(),
    );
    // and it never asked the server for the payroll it may not see
    expect(get.mock.calls.some(([path]) => String(path).includes("payroll"))).toBe(false);
  });

  it("surfaces an HTTP-200 { success:false } as an error, never as an empty report", async () => {
    caps["pos.shifts.view"] = true;
    get.mockImplementation((path: string) => {
      if (path === "/shifts/") return Promise.resolve({ success: false, error: "تعذّر تحميل الورديات" });
      return Promise.reject(new Error("unexpected call"));
    });

    render(
      <Wrapper>
        <OperationsReportPage reportId="shift-variance" />
      </Wrapper>,
    );

    expect(await screen.findByText("تعذّر تحميل الورديات")).toBeInTheDocument();
  });

  it("requests the complete guarded contract for every capped operations report", async () => {
    get.mockResolvedValue([]);
    const filters = { from: "2026-08-01", to: "2026-08-31", status: "" };
    for (const id of ["shift-variance", "user-actions", "transaction-log"]) {
      const report = OPERATIONS_REPORTS_SECTION.reports.find((candidate) => candidate.id === id);
      expect(report, id).toBeDefined();
      await report!.load(filters);
    }

    expect(get).toHaveBeenCalledWith(
      "/shifts/",
      expect.objectContaining({ params: expect.objectContaining({ report: 1 }) }),
    );
    expect(get).toHaveBeenCalledWith(
      "/erp/audit-logs",
      expect.objectContaining({ params: { report: 1, from: "2026-08-01", to: "2026-08-31" } }),
    );
    expect(get).toHaveBeenCalledWith(
      "/workflow/reports/transaction-log",
      expect.objectContaining({ params: expect.objectContaining({ startDate: "2026-08-01", endDate: "2026-08-31" }) }),
    );
  });
});
