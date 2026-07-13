import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import MenuModule from "@/modules/menu";

// Mock only the shared apiClient.get so the REAL menu api surface (URL building +
// query hooks + response typing) is exercised end-to-end; ApiError etc. stay real.
const ITEM = {
  id: "MENU-1",
  name: "شاورما دجاج",
  nameEn: "Chicken Shawarma",
  price: 18,
  category: "ساندويتش",
  cost: 6,
  computedCost: 6,
  stock: 100,
  minStock: 5,
  active: true,
  brandId: "B1",
  brandName: "براند تجريبي",
  pricingMode: "fixed",
  markupPct: 30,
  isSemiFinished: false,
  isCombo: false,
  bomId: null,
  productionMethod: "made_at_branch",
  deductStrategy: "on_sale",
  unit: "حبة",
  bigUnit: null,
  convRate: 1,
  yieldQuantity: 1,
  yieldUnit: null,
  isTaxInclusive: true,
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        if (path.includes("/erp/brands")) return [{ id: "B1", name: "براند تجريبي", code: "BR", logo: null, isActive: true }];
        if (path.includes("/menu/semi-finished")) return [];
        if (path.includes("/menu/all")) return [ITEM];
        return [];
      }),
    },
  };
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <MenuModule />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("menu module — smoke", () => {
  it("hub renders brand cards from a mocked apiClient without console errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt("/menu/hub");
    expect((await screen.findAllByText("براند تجريبي")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("لوحة القوائم").length).toBeGreaterThan(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("brand menu renders catalog item rows", async () => {
    renderAt("/menu/brand");
    await waitFor(() => expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0));
  });
});
