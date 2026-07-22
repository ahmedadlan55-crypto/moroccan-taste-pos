import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";
import { ar } from "@/i18n/dictionaries/ar";

// ── controllable capability mock (item.cost.view gating) ──
const perm = vi.hoisted(() => ({ cost: true }));
vi.mock("@/modules/inventory/lib/permission-provider", () => ({
  useCan: (a: string) => (a === "item.cost.view" ? perm.cost : true),
  usePermissions: () => ({ can: (a: string) => (a === "item.cost.view" ? perm.cost : true) }),
  WarehousePermissionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ── URL-routed apiClient mock ──
const ITEM_ROW = {
  id: "INV1", name: "صنف اختبار", name_en: "", sku: "SKU-1", category: "خضار",
  unit: "حبة", cost: 12.5, stock: 8, min_stock: 2, active: 1, kind: "raw", version: 1,
};
function route(url: string): unknown {
  if (url === "/inventory/v2/items")
    return { data: [ITEM_ROW], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 }, kpis: { total: 1, active: 1, inactive: 0, noSku: 0 } };
  if (url.startsWith("/inventory/v2/warehouses"))
    return { data: [{ id: "WH1", code: "W1", name: "مستودع 1", branchId: "BR1", branchName: "فرع 1", isActive: true, isMain: true }], totals: {} };
  if (url === "/inventory/v2/categories") return { data: ["خضار"] };
  if (url === "/inventory/v2/units") return { data: [{ code: "حبة", nameAr: "حبة", nameEn: "Piece", type: "base" }] };
  if (url === "/settings") return { VATRate: "15" };
  if (url.includes("saved-views")) return { data: [] };
  return {};
}
vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn((url: string) => Promise.resolve(route(url))),
      post: vi.fn(() => Promise.resolve({})),
      put: vi.fn(() => Promise.resolve({})),
      patch: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    },
  };
});

import { ItemsPage } from "@/modules/inventory/features/items/ItemsPage";
import { ItemFormPage } from "@/modules/inventory/features/items/ItemFormPage";
import {
  findCrossBranchAssignment,
  findDuplicateWarehouse,
  assignmentRuleIssue,
  validateAssignments,
  blankAssignment,
  type WarehouseUniverseRow,
} from "@/modules/inventory/features/items/assignment-utils";

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  perm.cost = true;
});

describe("ItemsPage — server-mode list", () => {
  it("renders a row from the paginating server payload", async () => {
    renderWithProviders(<ItemsPage />);
    expect(await screen.findByText(ar.items.listTitle)).toBeInTheDocument();
    expect((await screen.findAllByText("صنف اختبار")).length).toBeGreaterThan(0);
  });

  it("shows the base-unit cost column when item.cost.view is granted", async () => {
    perm.cost = true;
    renderWithProviders(<ItemsPage />);
    await screen.findAllByText("صنف اختبار");
    expect(screen.queryAllByText(ar.items.col.baseCost).length).toBeGreaterThan(0);
  });

  it("hides the cost columns when item.cost.view is denied", async () => {
    perm.cost = false;
    renderWithProviders(<ItemsPage />);
    await screen.findAllByText("صنف اختبار");
    expect(screen.queryAllByText(ar.items.col.baseCost).length).toBe(0);
    expect(screen.queryAllByText(ar.items.col.majorCost).length).toBe(0);
  });

  it("flags a row missing its English name", async () => {
    renderWithProviders(<ItemsPage />);
    await screen.findAllByText("صنف اختبار");
    expect(screen.queryAllByText(ar.items.badge.missingNameEn).length).toBeGreaterThan(0);
  });
});

describe("ItemFormPage — create validation", () => {
  it("rejects a create with no English name (required for new records)", async () => {
    renderWithProviders(<ItemFormPage mode="create" />);
    fireEvent.click(await screen.findByRole("button", { name: ar.items.form.create }));
    expect(await screen.findByText(ar.items.form.validation.nameEnRequiredNew)).toBeInTheDocument();
    expect(screen.getByText(ar.items.form.validation.codeRequired)).toBeInTheDocument();
  });

  it("shows the live conversion preview and rejects a zero factor", async () => {
    renderWithProviders(<ItemFormPage mode="create" />);
    // no major unit → "single unit"
    expect(screen.getByTestId("conv-preview").textContent).toContain(ar.items.conversionNone);

    fireEvent.change(screen.getByLabelText(ar.items.form.field.baseUnitName), { target: { value: "حبة" } });
    fireEvent.change(screen.getByLabelText(ar.items.form.field.majorUnitName), { target: { value: "كرتون" } });
    fireEvent.change(screen.getByLabelText(ar.items.form.field.conversionFactor), { target: { value: "12" } });
    await waitFor(() => expect(screen.getByTestId("conv-preview").textContent).toContain("12"));
    expect(screen.getByTestId("conv-preview").textContent).toContain("كرتون");

    // zero factor with a major unit set → factor validation error on save
    fireEvent.change(screen.getByLabelText(ar.items.form.field.conversionFactor), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: ar.items.form.create }));
    expect(await screen.findByText(ar.items.form.validation.factorPositive)).toBeInTheDocument();
  });
});

describe("assignment-utils — cross-branch & rule guards", () => {
  const universe: WarehouseUniverseRow[] = [
    { id: "WH1", name: "مستودع أ", code: "A", branchId: "BR1", branchName: "فرع 1", isActive: true, isMain: true },
    { id: "WH2", name: "مستودع ب", code: "B", branchId: "BR2", branchName: "فرع 2", isActive: true, isMain: false },
  ];

  it("rejects a warehouse that is not under the selected branch", () => {
    const drafts = [{ ...blankAssignment("BR1", "WH2") }]; // WH2 belongs to BR2
    const cross = findCrossBranchAssignment(drafts, universe);
    expect(cross).not.toBeNull();
    expect(cross?.warehouse).toBe("مستودع ب");
    expect(validateAssignments(drafts, universe).ok).toBe(false);
  });

  it("accepts a warehouse that is under the selected branch", () => {
    const drafts = [{ ...blankAssignment("BR1", "WH1") }];
    expect(findCrossBranchAssignment(drafts, universe)).toBeNull();
    expect(validateAssignments(drafts, universe).ok).toBe(true);
  });

  it("detects a duplicate warehouse assignment", () => {
    const drafts = [blankAssignment("BR1", "WH1"), blankAssignment("BR1", "WH1")];
    expect(findDuplicateWarehouse(drafts, universe)).toBe("مستودع أ");
  });

  it("requires a positive reorder qty when a rule is enabled", () => {
    const d = { ...blankAssignment("BR1", "WH1"), reorderPoint: "5", reorderQty: "0" };
    expect(assignmentRuleIssue(d)).toBe("reorderQtyPositive");
  });

  it("requires max >= reorder point", () => {
    const d = { ...blankAssignment("BR1", "WH1"), reorderPoint: "10", reorderQty: "3", maxStock: "5" };
    expect(assignmentRuleIssue(d)).toBe("maxGteReorder");
  });
});
