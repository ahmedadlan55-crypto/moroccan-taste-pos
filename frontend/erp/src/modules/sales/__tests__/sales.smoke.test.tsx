import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SalesModule from "@/modules/sales";

// Mock only the shared apiClient.get so the REAL o2cApi surface (URL building +
// envelope handling) is exercised end-to-end; ApiError etc. stay real.
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        if (path.includes("/orders")) {
          return {
            success: true,
            data: [
              { id: "o1", order_number: "SO-1001", customer_name: "متجر الأمل", order_date: "2026-01-05", total_amount: 1250.5, is_credit_sale: 1, status: "confirmed", version: 1 },
            ],
            pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
          };
        }
        return { success: true, data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } };
      }),
    },
  };
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SalesModule />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("sales module — orders list smoke", () => {
  it("renders order rows from a mocked apiClient without console errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt("/sales/orders");

    // Rows render in both the desktop table and the mobile stacked card (jsdom
    // applies no CSS, so both layouts are in the DOM) — assert at least one.
    expect((await screen.findAllByText("SO-1001")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText("متجر الأمل").length).toBeGreaterThan(0));
    // status label + credit badge from the shared kit + domain adapter
    expect(screen.getAllByText("مؤكَّد").length).toBeGreaterThan(0);
    expect(screen.getAllByText("آجل").length).toBeGreaterThan(0);

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
