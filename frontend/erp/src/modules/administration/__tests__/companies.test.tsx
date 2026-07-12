import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/shared/ui";
import { apiClient } from "@/shared/api";
import CompaniesBrandsPage from "../pages/CompaniesBrands";

// Keep ApiError + everything else real; swap only the network client.
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/administration/companies"]}>
          <CompaniesBrandsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("CompaniesBrandsPage", () => {
  beforeEach(() => {
    (apiClient.get as unknown as Mock).mockReset();
  });

  it("renders the companies list from the mocked apiClient", async () => {
    (apiClient.get as unknown as Mock).mockImplementation((path: string) => {
      if (path === "/erp/companies") {
        return Promise.resolve([
          {
            id: "CO-1",
            name: "شركة الاختبار",
            legalName: "شركة الاختبار المحدودة",
            crNumber: "1010101010",
            taxNumber: "300000000000003",
            country: "SA",
            city: "الرياض",
            baseCurrency: "SAR",
            isActive: true,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    renderPage();

    const cells = await screen.findAllByText("شركة الاختبار");
    expect(cells.length).toBeGreaterThan(0);
    expect(apiClient.get).toHaveBeenCalledWith("/erp/companies", expect.anything());
  });
});
