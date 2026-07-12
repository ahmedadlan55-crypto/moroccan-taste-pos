import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";

// Mock only apiClient.get; keep ApiError (used by the shared ErrorState) real.
const getMock = vi.fn();
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: (path: string, opts?: unknown) => getMock(path, opts) },
  };
});

// Imported AFTER the mock so the module graph picks up the mocked client.
import { EmployeesPage } from "../pages/EmployeesPage";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <EmployeesPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("EmployeesPage", () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockImplementation((path: string) => {
      if (path === "/hr/employees") {
        return Promise.resolve([
          {
            id: "e1",
            employeeNumber: "EMP-001",
            fullName: "محمد أحمد",
            jobTitle: "محاسب",
            departmentName: "المالية",
            branchName: "الرئيسي",
            status: "active",
            basicSalary: 5000,
            totalAllowances: 0,
            grossSalary: 5000,
            employmentType: "full_time",
          },
        ]);
      }
      return Promise.resolve([]); // departments + anything else
    });
  });

  it("renders the employees list from the mocked apiClient", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText("محمد أحمد").length).toBeGreaterThan(0));
    expect(getMock).toHaveBeenCalledWith("/hr/employees", expect.anything());
    expect(screen.getAllByText("EMP-001").length).toBeGreaterThan(0);
  });
});
