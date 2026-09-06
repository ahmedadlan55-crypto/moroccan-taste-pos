/**
 * MenuItemPage — the price field means WHAT THE CUSTOMER PAYS.
 *
 * The money bug this pins (menu-price-semantics fallout): the product form's
 * price field was the STORED column. On a net-stored row the owner typed 25,
 * the row stored 25 NET, and the till charged 28.75 → whole-riyal 29.00. The
 * price dialog and the cashier card had already moved to "gross"; the form
 * had not.
 *
 * Contract pinned here:
 *   · on load, a net-stored row at 21.7391 shows 25 (its gross) — and a
 *     tax-inclusive row at 25 shows 25;
 *   · on EDIT, saving sends the figure the row's storage mode needs
 *     (21.7391 for a net row, 25 for an inclusive row) and never touches
 *     the row's taxInclusive flag;
 *   · on CREATE, the storage mode comes from settings.NewProductsTaxInclusive
 *     (the SAME setting routes/menu.js POST / reads) via GET /settings/all,
 *     and travels with the price as `taxInclusive` — never hardcoded.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";
import MenuModule from "@/modules/menu";

const { caps, settingsAll, putSpy, postSpy } = vi.hoisted(() => ({
  caps: {} as Record<string, boolean>,
  // Mutable per test: what GET /settings/all answers (NewProductsTaxInclusive
  // is stored as the string "true"/"false" by the Settings screen).
  settingsAll: { value: {} as Record<string, unknown> },
  putSpy: vi.fn(async (_path: string, _body?: unknown) => ({ success: true })),
  postSpy: vi.fn(async (_path: string, _body?: unknown) => ({ success: true, id: "MENU-NEW" })),
}));

vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children: React.ReactNode; fallback?: React.ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

const BASE = {
  name: "قنينة حرارية", nameEn: "Thermal Bottle", category: "أدوات", cost: 5, computedCost: 5, stock: 10, minStock: 1,
  active: true, brandId: "B1", brandName: "براند تجريبي", pricingMode: "fixed", markupPct: 30, isSemiFinished: false,
  isCombo: false, bomId: null, productionMethod: "made_at_branch", deductStrategy: "on_sale", unit: "حبة", bigUnit: null,
  convRate: 1, yieldQuantity: 1, yieldUnit: null, taxCategory: "S", costSource: "manual", hasImage: false, imageVer: null,
  imageData: null,
};
// Net-stored: 21.7391 × 1.15 = 25.00 on the till.
const NET_ITEM = { ...BASE, id: "MENU-NET", price: 21.7391, isTaxInclusive: false };
// Tax-inclusive: the stored figure IS the customer price.
const INCL_ITEM = { ...BASE, id: "MENU-INCL", price: 25, isTaxInclusive: true };

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        if (path.includes("/erp/brands")) return [{ id: "B1", name: "براند تجريبي", code: "BR", logo: null, isActive: true }];
        if (path.includes("/menu/semi-finished")) return [];
        if (path.includes("/menu/list")) return { data: [], pagination: { page: 1, pageSize: 20, total: 0 }, vatRate: 15 };
        if (path.includes("/menu/categories")) return [];
        if (path.match(/\/menu\/MENU-NET$/)) return NET_ITEM;
        if (path.match(/\/menu\/MENU-INCL$/)) return INCL_ITEM;
        if (path.includes("/sales-channels")) return [];
        if (path.endsWith("/settings/all")) return { VATRate: "15", ...settingsAll.value };
        if (path.includes("/settings")) return { VATRate: "15" };
        return [];
      }),
      put: putSpy,
      post: postSpy,
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

const PRICE_LABEL = /سعر البيع \(شامل الضريبة\)/;
const priceInput = () => screen.getByLabelText(PRICE_LABEL) as HTMLInputElement;
const lastBody = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls[spy.mock.calls.length - 1][1] as Record<string, unknown>;

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
  caps["menu.view"] = true;
  caps["menu.catalog.manage"] = true;
  caps["menu.cost.view"] = true;
  settingsAll.value = {};
  putSpy.mockClear();
  postSpy.mockClear();
});

describe("MenuItemPage — edit: the field shows the gross and stores the row's figure", () => {
  it("a NET-stored row at 21.7391 loads as 25, and saving 25 stores 21.7391 again (not 25 net → 29 on the till)", async () => {
    renderAt("/menu/brand/MENU-NET/edit");
    await waitFor(() => expect(priceInput().value).toBe("25"));

    fireEvent.click(screen.getByText("حفظ التغييرات"));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0][0]).toBe("/menu/MENU-NET");
    const body = lastBody(putSpy);
    expect(body.price).toBe(21.7391);
    // The edit never rewrites the row's storage mode.
    expect("taxInclusive" in body).toBe(false);
  });

  it("retyping the customer price on a NET row stores its net at 4 decimals (30 → 26.087)", async () => {
    renderAt("/menu/brand/MENU-NET/edit");
    await waitFor(() => expect(priceInput().value).toBe("25"));
    fireEvent.change(priceInput(), { target: { value: "30" } });
    fireEvent.click(screen.getByText("حفظ التغييرات"));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(lastBody(putSpy).price).toBe(26.087);
  });

  it("a tax-INCLUSIVE row at 25 loads as 25 and stores 25 — never grossed twice", async () => {
    renderAt("/menu/brand/MENU-INCL/edit");
    await waitFor(() => expect(priceInput().value).toBe("25"));
    fireEvent.click(screen.getByText("حفظ التغييرات"));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0][0]).toBe("/menu/MENU-INCL");
    expect(lastBody(putSpy).price).toBe(25);
  });

  it("the label says the price includes VAT (the owner is typing the customer price)", async () => {
    renderAt("/menu/brand/MENU-NET/edit");
    await waitFor(() => expect(screen.getByText("سعر البيع (شامل الضريبة)", { exact: false })).toBeInTheDocument());
  });
});

describe("MenuItemPage — create: storage mode comes from settings.NewProductsTaxInclusive", () => {
  async function createWithPrice(price: string) {
    renderAt("/menu/brand/new?brandId=B1");
    const name = await screen.findByLabelText(/الاسم بالعربية/);
    fireEvent.change(name, { target: { value: "منتج جديد" } });
    fireEvent.change(priceInput(), { target: { value: price } });
    fireEvent.click(screen.getByText("إنشاء المنتج"));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy.mock.calls[0][0]).toBe("/menu");
    return lastBody(postSpy);
  }

  it("setting = true → stores the gross and sends taxInclusive:true (25 → 25)", async () => {
    settingsAll.value = { NewProductsTaxInclusive: "true" };
    const body = await createWithPrice("25");
    expect(body.taxInclusive).toBe(true);
    expect(body.price).toBe(25);
  });

  it("setting = false → stores the net and sends taxInclusive:false (25 → 21.7391)", async () => {
    settingsAll.value = { NewProductsTaxInclusive: "false" };
    const body = await createWithPrice("25");
    expect(body.taxInclusive).toBe(false);
    expect(body.price).toBe(21.7391);
  });

  it("setting absent → the server's own default (net) — and the flag still travels with the price", async () => {
    settingsAll.value = {};
    const body = await createWithPrice("25");
    expect(body.taxInclusive).toBe(false);
    expect(body.price).toBe(21.7391);
  });
});
