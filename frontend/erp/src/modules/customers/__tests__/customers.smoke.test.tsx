import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CustomersModule from "@/modules/customers";

// Mock only shared apiClient.get; the real o2cApi + shared kit render the list.
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        if (path.includes("/customers")) {
          return {
            success: true,
            data: [
              { id: "c1", name: "شركة النور", phone: "0555000111", customerType: "B2B", creditLimit: 50000, balance: 12000, paymentTerms: "Net30", creditDays: 30, isActive: true },
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
        <CustomersModule />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("customers module — list smoke", () => {
  it("renders customer rows from a mocked apiClient without console errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt("/customers");

    // Rows render in both the desktop table and the mobile stacked card (jsdom
    // applies no CSS, so both layouts are in the DOM) — assert at least one.
    expect((await screen.findAllByText("شركة النور")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText("0555000111").length).toBeGreaterThan(0));
    expect(screen.getAllByText("B2B").length).toBeGreaterThan(0);

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
