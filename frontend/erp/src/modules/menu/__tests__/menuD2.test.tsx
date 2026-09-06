/**
 * Sprint 3 · D2 (menu frontend) — behavioural tests for the redesigned menu
 * products list (server-mode DataTable over GET /api/menu/list) and the
 * full-page New/Details/Edit product screen.
 *
 * Covers: server-mode rows render; cost/margin columns respect menu.cost.view;
 * full-page create validates brand-required + surfaces the missing-English-name
 * state; cost-locked-by-recipe surfaces as an unlock workflow (not a crash); the
 * POS cashier-card preview renders both Arabic and English. Everything is
 * wrapped in an I18nProvider (default Arabic).
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";
import MenuModule from "@/modules/menu";

// ── Controllable capability gate ──────────────────────────────────────────────
const { caps } = vi.hoisted(() => ({ caps: {} as Record<string, boolean> }));
vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children: React.ReactNode; fallback?: React.ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

// ── Item fixtures ─────────────────────────────────────────────────────────────
const LIST_ROW = {
  id: "MENU-1", name: "شاورما دجاج", nameEn: "Chicken Shawarma", category: "ساندويتش",
  brandId: "B1", brandName: "براند تجريبي", price: 18, cost: 6, costSource: "manual",
  computedCost: 6, preTaxPrice: 15.65, marginValue: 9.65, marginPct: 61.66,
  taxCategory: "S", isTaxInclusive: true, branchCount: 2, channelCount: 1,
  active: true, hasImage: false, imageVer: null, hasRecipe: false,
};

const MANUAL_ITEM = {
  id: "MENU-1", name: "شاورما دجاج", nameEn: "Chicken Shawarma", price: 18, category: "ساندويتش",
  cost: 6, computedCost: 6, stock: 100, minStock: 5, active: true, brandId: "B1", brandName: "براند تجريبي",
  pricingMode: "fixed", markupPct: 30, isSemiFinished: false, isCombo: false, bomId: null,
  productionMethod: "made_at_branch", deductStrategy: "on_sale", unit: "حبة", bigUnit: null,
  convRate: 1, yieldQuantity: 1, yieldUnit: null, isTaxInclusive: true, taxCategory: "S", costSource: "manual",
};

const RECIPE_ITEM = { ...MANUAL_ITEM, id: "MENU-2", name: "برجر لحم", nameEn: "Beef Burger", cost: 9, computedCost: 9, bomId: "BOM-2", costSource: "recipe" };

const RECIPE_BOM = {
  menuId: "MENU-2", menuName: "برجر لحم", bomId: "BOM-2", version: 1, yieldQuantity: 1, yieldUnit: "PCS",
  productionMethod: "made_at_branch", deductStrategy: "on_sale", allowNegativeStock: true, minStockAlert: 0,
  lines: [{ id: "L1", componentItemId: "INV-1", itemName: "خبز برجر", unit: "PCS", quantity: 1, wastePct: 0, avgCost: 2, lineCost: 2 }],
  totalCost: 9, hasLegacyRecipe: false,
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
        if (path.match(/\/menu\/MENU-2\/recipe-bom/)) return RECIPE_BOM;
        // menu-hardening: the product page hydrates from GET /menu/:id (the one
        // read that still carries imageData), no longer from the /menu/all list.
        if (path.match(/\/menu\/MENU-1$/)) return MANUAL_ITEM;
        if (path.match(/\/menu\/MENU-2$/)) return RECIPE_ITEM;
        if (path.includes("/menu/all")) return [MANUAL_ITEM, RECIPE_ITEM];
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

beforeEach(() => {
  for (const k of Object.keys(caps)) delete caps[k];
  caps["menu.view"] = true;
});

describe("BrandMenu — server-mode list over /api/menu/list", () => {
  // DataTable renders a desktop table AND mobile cards (both in the DOM under
  // jsdom, which ignores media queries), so names appear more than once — assert
  // with *AllBy*.
  it("renders rows from the paginated list response", async () => {
    renderAt("/menu/brand");
    await waitFor(() => expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0));
    // English name (business data) rendered too
    expect(screen.getAllByText("Chicken Shawarma").length).toBeGreaterThan(0);
  });

  it("shows the cost & margin columns when the user holds menu.cost.view", async () => {
    caps["menu.cost.view"] = true;
    renderAt("/menu/brand");
    await waitFor(() => expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0));
    // Cost + margin column headers (menu.col.cost / .margin) present.
    expect(screen.getAllByText("التكلفة").length).toBeGreaterThan(0);
    expect(screen.getAllByText("الهامش").length).toBeGreaterThan(0);
  });

  it("hides the cost & margin columns when menu.cost.view is denied", async () => {
    caps["menu.cost.view"] = false;
    renderAt("/menu/brand");
    await waitFor(() => expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("التكلفة")).toHaveLength(0);
    expect(screen.queryAllByText("الهامش")).toHaveLength(0);
  });
});

describe("MenuItemPage — full-page create", () => {
  it("validates brand-required and surfaces the missing-English-name state", async () => {
    caps["menu.catalog.manage"] = true;
    caps["menu.cost.view"] = true;
    renderAt("/menu/brand/new");
    // Missing-English badge visible while nameEn is empty.
    await waitFor(() => expect(screen.getByTestId("missing-nameen")).toBeInTheDocument());
    // Submit without a brand → brand-required validation surfaces.
    fireEvent.click(screen.getByText("إنشاء المنتج"));
    await waitFor(() => expect(screen.getByText("العلامة التجارية مطلوبة")).toBeInTheDocument());
  });
});

describe("MenuItemPage — cost lock (COST_LOCKED_BY_RECIPE workflow)", () => {
  it("renders a recipe-derived cost as a lock with an unlock action, not a crash", async () => {
    caps["menu.catalog.manage"] = true;
    caps["menu.cost.view"] = true;
    renderAt("/menu/brand/MENU-2/edit");
    // The recipe-locked notice + unlock button render (workflow, not a raw error).
    await waitFor(() => expect(screen.getByText("التكلفة مشتقّة من الوصفة")).toBeInTheDocument());
    const unlock = screen.getByText("فتح القفل للتعديل اليدوي");
    expect(unlock).toBeInTheDocument();
    // Unlocking reveals the manual cost field label without throwing.
    fireEvent.click(unlock);
    await waitFor(() => expect(screen.getByText("التكلفة اليدوية")).toBeInTheDocument());
  });
});

describe("MenuItemPage — POS cashier-card preview", () => {
  it("renders both the Arabic and English cards", async () => {
    caps["menu.catalog.manage"] = true;
    caps["menu.cost.view"] = true;
    renderAt("/menu/brand/MENU-1/edit");
    await waitFor(() => expect(screen.getByText("بالعربية")).toBeInTheDocument());
    expect(screen.getByText("بالإنجليزية")).toBeInTheDocument();
    // Arabic name in the AR card, English name in the EN card.
    expect(screen.getAllByText("شاورما دجاج").length).toBeGreaterThan(0);
    expect(screen.getByText("Chicken Shawarma")).toBeInTheDocument();
  });
});
