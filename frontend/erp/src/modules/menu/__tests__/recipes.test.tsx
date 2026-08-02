/**
 * Recipe catalog (/menu/recipes) + full-page recipe (/menu/recipes/:source/:productId).
 *
 * The four behaviours worth pinning, because each one is a contract someone can
 * quietly break:
 *   1. the catalog lists products WITHOUT a recipe (status "none") — the whole
 *      reason the screen replaced the old BOM-only list;
 *   2. a deep link straight to the detail route renders the recipe page (no
 *      "open the list first" coupling);
 *   3. a component line offers the component's REGISTERED units, not free text;
 *   4. a 409 VERSION_CONFLICT surfaces a real reload affordance instead of
 *      silently retrying or overwriting the other person's save.
 */
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/shared/ui";
import { I18nProvider } from "@/i18n";
import MenuModule from "@/modules/menu";

// ── controllable capability gate + mutation outcome ───────────────────────────
const { caps, state } = vi.hoisted(() => ({
  caps: {} as Record<string, boolean>,
  state: { saveConflict: false },
}));

vi.mock("@/shared/permissions", () => ({
  useCan: (cap: string) => caps[cap] ?? false,
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
  Can: ({ cap, children, fallback = null }: { cap: string; children: React.ReactNode; fallback?: React.ReactNode }) =>
    (caps[cap] ?? false) ? <>{children}</> : <>{fallback}</>,
}));

// ── fixtures ─────────────────────────────────────────────────────────────────
const META = {
  brands: [{ id: "B1", name: "براند تجريبي", nameEn: "Test Brand" }],
  categories: ["أطباق رئيسية"],
  productTypes: ["sold", "semi_finished", "combo", "stock_item"],
  recipeStatuses: ["draft", "active", "archived", "none"],
  outputTypes: ["primary", "co_product", "by_product", "rework", "scrap"],
  allocMethods: ["fixed_pct", "standard_cost", "weight", "nrv"],
  costAnomalies: ["ZERO_COST", "COMPONENT_WITHOUT_COST", "COST_EXCEEDS_PRICE", "FOOD_COST_HIGH", "COST_STALE"],
  sorts: ["name", "name_en", "product_type", "category", "status", "updated_at"],
};

const WITH_RECIPE = {
  productSource: "menu",
  productId: "MENU-1",
  sku: "MENU-1",
  name: "برجر لحم",
  nameEn: "Beef Burger",
  productType: "sold",
  brandId: "B1",
  brandName: "براند تجريبي",
  brandNameEn: "Test Brand",
  category: "أطباق رئيسية",
  unit: "PCS",
  imageVersion: null,
  bomId: "BOM-1",
  recipeStatus: "active",
  version: 2,
  rowVersion: 5,
  yieldQuantity: 1,
  yieldUnit: "PCS",
  lineCount: 1,
  needsReview: false,
  effectiveFrom: null,
  effectiveTo: null,
  updatedAt: "2026-07-30T09:00:00.000Z",
  sellingPrice: 25,
  batchCost: 9,
  unitCost: 9,
  foodCostPct: 36,
  marginPct: 64,
  costAnomalies: [],
};

// The headline case: a product with NO recipe must be listed, not filtered away.
const NO_RECIPE = {
  ...WITH_RECIPE,
  productId: "MENU-9",
  sku: "MENU-9",
  name: "سلطة يونانية",
  nameEn: "Greek Salad",
  bomId: null,
  recipeStatus: "none",
  version: null,
  rowVersion: null,
  yieldQuantity: null,
  yieldUnit: null,
  lineCount: 0,
  sellingPrice: 18,
  batchCost: null,
  unitCost: null,
  foodCostPct: null,
  marginPct: null,
};

const CATALOG = {
  success: true,
  data: [WITH_RECIPE, NO_RECIPE],
  pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
  kpis: { products: 2, withoutRecipe: 1, needsReview: 0, avgFoodCostPct: 36 },
  canViewCost: true,
};

const RECIPE_LINE = {
  id: "BL-1",
  componentItemId: "INV-1",
  itemName: "دقيق",
  itemNameEn: "Flour",
  itemKind: "raw",
  trackingMode: "none",
  enteredUnitId: 10,
  enteredUnitCode: "KG",
  enteredUnitName: "كيلوجرام",
  baseUnit: "KG",
  conversionFactor: 1,
  quantity: 2,
  baseQuantity: 2,
  wastePct: 5,
  grossQuantity: 2.1,
  costBasis: "wac",
  unitCost: 4,
  lineCost: 8.4,
  lineNo: 0,
  notes: null,
};

const PRODUCT = {
  id: "MENU-1",
  sku: "MENU-1",
  name: "برجر لحم",
  nameEn: "Beef Burger",
  productType: "sold",
  category: "أطباق رئيسية",
  brandId: "B1",
  unit: "PCS",
  imageVersion: null,
  sellingPrice: 25,
  productionMethod: "made_at_branch",
  deductStrategy: "on_sale",
  trackingMode: null,
};

const DETAIL = {
  success: true,
  canViewCost: true,
  data: {
    productSource: "menu",
    productId: "MENU-1",
    product: PRODUCT,
    recipe: {
      bomId: "BOM-1",
      productSource: "menu",
      productId: "MENU-1",
      product: PRODUCT,
      status: "active",
      version: 2,
      rowVersion: 5,
      revisionOf: null,
      yieldQuantity: 1,
      yieldUnit: "PCS",
      yieldUnitId: null,
      effectiveFrom: null,
      effectiveTo: null,
      needsReview: false,
      notes: "",
      consumptionWarehouseId: null,
      createdBy: "admin",
      createdAt: "2026-07-01T08:00:00.000Z",
      updatedBy: "admin",
      updatedAt: "2026-07-30T09:00:00.000Z",
      approvedBy: "admin",
      approvedAt: "2026-07-02T08:00:00.000Z",
      lines: [RECIPE_LINE],
      outputs: [],
      cost: {
        batchCost: 8.4,
        unitCost: 8.4,
        sellingPrice: 25,
        foodCostPct: 33.6,
        marginPct: 66.4,
        computedAt: "2026-07-30T09:00:00.000Z",
        cachedBatchCost: 8.4,
        anomalies: [],
      },
    },
    versions: [
      {
        bomId: "BOM-1",
        version: 2,
        rowVersion: 5,
        status: "active",
        yieldQuantity: 1,
        yieldUnit: "PCS",
        effectiveFrom: null,
        effectiveTo: null,
        revisionOf: null,
        needsReview: false,
        createdBy: "admin",
        createdAt: "2026-07-01T08:00:00.000Z",
        updatedBy: "admin",
        updatedAt: "2026-07-30T09:00:00.000Z",
        approvedBy: "admin",
        approvedAt: "2026-07-02T08:00:00.000Z",
        cachedUnitCost: 8.4,
      },
    ],
  },
};

// Registered units (item_units, allow_production=1) — the ONLY thing a line may
// carry. Free text was removed from the domain.
const COMPONENTS = {
  success: true,
  canViewCost: true,
  data: [
    {
      itemId: "INV-1",
      name: "دقيق",
      nameEn: "Flour",
      sku: "INV-1",
      baseUnit: "KG",
      kind: "raw",
      trackingMode: "none",
      category: "جاف",
      unitCost: 4,
      units: [
        { id: 10, name: "كيلوجرام", code: "KG", isBase: true, conversionToBase: 1, precision: 3 },
        { id: 11, name: "جرام", code: "G", isBase: false, conversionToBase: 0.001, precision: 0 },
      ],
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
};

const AVAILABILITY = {
  success: true,
  data: {
    bomId: "BOM-1",
    warehouseId: null,
    batches: 1,
    items: [
      { itemId: "INV-1", itemName: "دقيق", itemNameEn: "Flour", unit: "KG", required: 2.1, available: 40, delta: 37.9, status: "ok" },
    ],
    summary: { shortageCount: 0, allAvailable: true, itemCount: 1, makeableBatches: 19, makeableQuantity: 19 },
  },
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        if (path === "/recipes") return CATALOG;
        if (path.startsWith("/recipes/meta")) return { success: true, data: META };
        if (path.startsWith("/recipes/components")) return COMPONENTS;
        if (path.includes("/availability")) return AVAILABILITY;
        if (path.startsWith("/recipes/where-used")) {
          return { success: true, data: { itemId: "INV-1", usedIn: [], activeCount: 0, totalCount: 0 } };
        }
        if (path.startsWith("/recipes/menu/")) return DETAIL;
        if (path.startsWith("/erp/warehouses-list")) return [];
        return { success: true, data: [] };
      }),
      post: vi.fn(async () => {
        if (state.saveConflict) {
          throw new actual.ApiError({
            kind: "conflict",
            status: 409,
            code: "VERSION_CONFLICT",
            message: "تغيّرت الوصفة منذ آخر تحميل — أعد التحميل",
          });
        }
        return {
          success: true,
          data: {
            bomId: "BOM-2",
            productSource: "menu",
            productId: "MENU-1",
            version: 3,
            rowVersion: 1,
            status: "draft",
            action: "revise",
            batchCost: 8.4,
            unitCost: 8.4,
          },
          warnings: [],
        };
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
  localStorage.clear();
  // Pin the UI language so the assertions below are deterministic (the provider
  // defaults to "ar" but persists the last choice).
  localStorage.setItem("erp_lang", "ar");
  for (const k of Object.keys(caps)) delete caps[k];
  caps["menu.view"] = true;
  caps["menu.cost.view"] = true;
  caps["menu.recipes.manage"] = true;
  state.saveConflict = false;
});

describe("Recipe catalog — /menu/recipes", () => {
  it("lists products WITH and WITHOUT a recipe, and flags the recipeless one as 'none'", async () => {
    renderAt("/menu/recipes");

    await waitFor(() => expect(screen.getAllByText("برجر لحم").length).toBeGreaterThan(0));
    // The product with no recipe is a first-class row, not an omission.
    expect(screen.getAllByText("سلطة يونانية").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Greek Salad").length).toBeGreaterThan(0);

    // Scope to the desktop table so the KPI card / filter chip copy (which reuses
    // the same words) cannot satisfy the assertion by accident.
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("بلا وصفة").length).toBe(1);
    expect(within(table).getAllByText("نشطة").length).toBe(1);
  });

  it("shows the cost columns when menu.cost.view is held and hides them when it is not", async () => {
    const { unmount } = renderAt("/menu/recipes");
    await waitFor(() => expect(screen.getAllByText("برجر لحم").length).toBeGreaterThan(0));
    expect(screen.getAllByText("تكلفة الوحدة").length).toBeGreaterThan(0);
    unmount();

    caps["menu.cost.view"] = false;
    renderAt("/menu/recipes");
    await waitFor(() => expect(screen.getAllByText("برجر لحم").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("تكلفة الوحدة")).toHaveLength(0);
  });
});

describe("Recipe detail — deep link to /menu/recipes/:source/:productId", () => {
  it("renders the full page directly from the URL", async () => {
    renderAt("/menu/recipes/menu/MENU-1");

    await waitFor(() => expect(screen.getByRole("heading", { name: "برجر لحم" })).toBeInTheDocument());
    // The seven facets are real tabs on a real route.
    expect(screen.getByRole("tab", { name: "المكوّنات" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "النسخ والتدقيق" })).toBeInTheDocument();
    // An ACTIVE recipe announces the revision rule BEFORE any edit is made.
    expect(screen.getByTestId("recipe-revision-banner")).toBeInTheDocument();
  });

  it("offers the component's REGISTERED units in the line unit select", async () => {
    renderAt("/menu/recipes/menu/MENU-1?tab=components");

    await waitFor(() => expect(screen.getAllByText("دقيق").length).toBeGreaterThan(0));
    const unitSelect = await screen.findByRole("combobox", { name: "وحدة السطر" });
    await waitFor(() =>
      expect(within(unitSelect).getAllByRole("option").map((o) => o.textContent)).toEqual(
        expect.arrayContaining(["كيلوجرام", "جرام"]),
      ),
    );
    // The saved unit is the selected one.
    expect((unitSelect as HTMLSelectElement).value).toBe("10");
  });
});

describe("Recipe detail — optimistic locking", () => {
  it("surfaces a reload affordance when the save returns 409 VERSION_CONFLICT", async () => {
    state.saveConflict = true;
    renderAt("/menu/recipes/menu/MENU-1?tab=components");

    // Make the form dirty (Save is disabled while nothing changed — an unchanged
    // save on an active recipe would mint a pointless revision).
    const qty = await screen.findByRole("spinbutton", { name: "الكمية الصافية" });
    fireEvent.change(qty, { target: { value: "3" } });

    const save = await screen.findByRole("button", { name: /حفظ/ });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByTestId("recipe-conflict")).toBeInTheDocument());
    expect(screen.getByTestId("recipe-conflict-reload")).toBeInTheDocument();
    // The banner explains the rule rather than dumping a status code.
    expect(screen.getByText("تغيّرت الوصفة منذ آخر تحميل")).toBeInTheDocument();
  });
});
