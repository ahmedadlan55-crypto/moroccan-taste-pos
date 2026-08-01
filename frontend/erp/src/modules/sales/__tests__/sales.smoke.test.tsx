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
        if (path.includes("/invoices")) {
          return {
            success: true,
            data: [
              {
                id: "i1", document_number: "INV-1001", document_type: "invoice", source_type: "pos",
                customer_name: "متجر الأمل", issue_date: "2026-01-05", due_date: "2026-02-05",
                subtotal: 1087.39, vat_amount: 163.11, total_amount: 1250.5, paid_amount: 0,
                balance_amount: 1250.5, status: "issued", zatca_status: "accepted", version: 1,
              },
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

// Manual sales orders were removed with the credit-sales surfaces; invoices is
// now the sales group's first leaf AND the module's default section, so this
// smoke covers both the section it lands on and the fallback branch.
describe("sales module — invoices list smoke", () => {
  it("renders invoice rows from a mocked apiClient without console errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt("/sales/invoices");

    // Rows render in both the desktop table and the mobile stacked card (jsdom
    // applies no CSS, so both layouts are in the DOM) — assert at least one.
    expect((await screen.findAllByText("INV-1001")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText("متجر الأمل").length).toBeGreaterThan(0));
    // status label from the shared kit + domain adapter
    expect(screen.getAllByText("صادرة").length).toBeGreaterThan(0);

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("falls back to the invoices section for an unknown /sales segment", async () => {
    renderAt("/sales/orders");
    expect((await screen.findAllByText("INV-1001")).length).toBeGreaterThan(0);
  });
});
