import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";
import MenuModule from "@/modules/menu";

// Mock only the shared apiClient.get so the REAL menu api surface (URL building +
// query hooks + response typing) is exercised end-to-end; ApiError etc. stay real.
// BrandMenu is now server-mode over GET /api/menu/list (D3); the Hub still reads
// /menu/all, so both shapes are stubbed.
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
  taxCategory: "S",
  costSource: "manual",
};

const LIST_ROW = {
  id: "MENU-1",
  name: "شاورما دجاج",
  nameEn: "Chicken Shawarma",
  category: "ساندويتش",
  brandId: "B1",
  brandName: "براند تجريبي",
  price: 18,
  cost: 6,
  costSource: "manual",
  computedCost: 6,
  preTaxPrice: 15.65,
  marginValue: 9.65,
  marginPct: 61.66,
  taxCategory: "S",
  isTaxInclusive: true,
  branchCount: 2,
  channelCount: 1,
  active: true,
  hasImage: false,
  imageVer: null,
  hasRecipe: false,
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
        if (path.includes("/menu/list")) return { data: [LIST_ROW], pagination: { page: 1, pageSize: 25, total: 1 }, vatRate: 15 };
        if (path.includes("/menu/categories")) return [{ categoryAr: "ساندويتش", categoryEn: "Sandwich", itemCount: 1 }];
        if (path.includes("/menu/all")) return [ITEM];
        if (path.includes("/sales-channels")) return [];
        if (path.includes("/settings")) return { VATRate: "15" };
        return [];
      }),
    },
  };
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <MenuModule />
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("menu module — smoke", () => {
  it("hub renders brand cards from a mocked apiClient without console errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt("/menu/hub");
    expect((await screen.findAllByText("براند تجريبي")).length).toBeGreaterThan(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("brand menu renders catalog item rows from /menu/list", async () => {
    renderAt("/menu/brand");
    await waitFor(() => expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0));
  });
});
