// A loader that keeps a null null proves nothing about the sheet: the engine's
// cells decide what a null BECOMES. These render the real page against a
// stubbed endpoint and pin the only outcome that matters on a valuation — a
// figure the server did not have prints as "—", and never as a 0 or 0.00 that
// reads as measured. The fixtures carry no legitimate zero anywhere, so any
// "0" on the page is a null that leaked.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/i18n";

const { caps, get } = vi.hoisted(() => ({
  caps: {} as Record<string, boolean>,
  get: vi.fn(),
}));

vi.mock("@/shared/permissions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePermissions: () => ({ can: (cap: string) => caps[cap] ?? false }),
}));

// PARTIAL mock: ErrorState narrows on the real `ApiError` class.
vi.mock("@/shared/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiClient: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { OperationsReportPage } from "../OperationsReportPage";

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const NRV_BODY = {
  success: true,
  data: [
    {
      itemId: "ITEM-IMPAIRED", itemName: "زبدة", unit: "كجم", quantity: 5, unitCost: 12, inventoryValue: 60,
      basisSource: "menu:MENU-1", basisProductName: "خبز", unitsPerSale: 2, netSellingPrice: 22,
      sellingCostPct: 10, nrvUnit: 9.9, writeDownUnit: 2.1, writeDown: 10.5, status: "impaired",
    },
    {
      itemId: "ITEM-NOBASIS", itemName: "ملح", unit: "كجم", quantity: 7, unitCost: 4, inventoryValue: 28,
      basisSource: null, basisProductName: null, unitsPerSale: null, netSellingPrice: null,
      sellingCostPct: 10, nrvUnit: null, writeDownUnit: null, writeDown: null, status: "no-basis",
    },
  ],
  totals: { items: 2, itemsWithBasis: 1, noBasisCount: 1, impairedItems: 1, inventoryValue: 88, writeDown: 10.5 },
  basis: { vatRatePct: 15, sellingCostPct: 10, costSource: "item-wac", warehouseId: null, asOf: "2026-09-06T08:00:00.000Z" },
};

const BELOW_COST_BODY = {
  success: true,
  data: [
    {
      menuId: "MENU-1", productName: "خبز", netSellingPrice: 10, unitCost: 12, costSource: "recipe",
      shortfallUnit: 2, marginPct: -20, soldQty: null, exposure: null, status: "below-cost",
    },
  ],
  totals: { products: 1, noCostCount: 2, exposure: null },
  basis: { vatRatePct: 15, days: 30, salesSource: null, salesMeasure: null, salesFrom: null, asOf: "2026-09-06T08:00:00.000Z" },
};

const WAREHOUSES = {
  success: true,
  data: [{ id: "WH-A", code: "A", name: "المستودع الرئيسي", nameEn: "Main warehouse", isActive: true }],
};

/** Every text node on the page that is exactly `text` — table cells AND the stacked mobile cards. */
function textsEqualTo(text: string): number {
  return screen.queryAllByText((_, node) => node?.textContent?.trim() === text && node.children.length === 0).length;
}

describe("the NRV report pages", () => {
  beforeEach(() => {
    for (const key of Object.keys(caps)) delete caps[key];
    caps["finance.reports.view"] = true;
    get.mockReset();
    get.mockImplementation((path: string) => {
      if (path === "/erp/reports/inventory-value/nrv") return Promise.resolve(NRV_BODY);
      if (path === "/erp/reports/inventory-value/products-below-cost") return Promise.resolve(BELOW_COST_BODY);
      if (path === "/inventory/v2/warehouses") return Promise.resolve(WAREHOUSES);
      // The letterhead read must never decide whether a report renders.
      return Promise.reject(new Error("unexpected call: " + path));
    });
  });

  afterEach(cleanup);

  it("below cost with no sales source: units sold and exposure print as dashes, never as 0", async () => {
    render(
      <Wrapper>
        <OperationsReportPage reportId="products-below-cost" />
      </Wrapper>,
    );

    expect((await screen.findAllByText("خبز")).length).toBeGreaterThan(0);
    // The figures the server DID have.
    expect(textsEqualTo("10.00")).toBeGreaterThan(0);
    expect(textsEqualTo("12.00")).toBeGreaterThan(0);
    expect(textsEqualTo("-20.00")).toBeGreaterThan(0);
    // The status map went through the real translator.
    expect(textsEqualTo("محرّك الوصفات")).toBeGreaterThan(0);
    // Units sold, exposure and the sales source: three nulls, three dashes per rendering of the row.
    expect(textsEqualTo("—")).toBeGreaterThanOrEqual(3);
    // And NOWHERE a zero that looks like a measurement.
    expect(textsEqualTo("0")).toBe(0);
    expect(textsEqualTo("0.00")).toBe(0);
    // The exposure total is withheld, not printed as 0.00; the window and the
    // VAT basis are printed.
    const totals = document.querySelector("[data-report-totals]");
    expect(totals?.textContent).not.toContain("التعرّض");
    expect(totals?.textContent).toContain("نافذة المبيعات (يوم)");
    expect(totals?.textContent).toContain("30");
    expect(totals?.textContent).toContain("15");

    const call = get.mock.calls.find(([path]) => path === "/erp/reports/inventory-value/products-below-cost");
    expect(call?.[1]?.params).toEqual({ days: "30" });
  });

  it("NRV: a no-basis row names its status and dashes its valuation; the picker opens on every warehouse", async () => {
    render(
      <Wrapper>
        <OperationsReportPage reportId="inventory-nrv" />
      </Wrapper>,
    );

    expect((await screen.findAllByText("ملح")).length).toBeGreaterThan(0);
    expect(textsEqualTo("لا أساس بيعي")).toBeGreaterThan(0);
    expect(textsEqualTo("منخفض القيمة")).toBeGreaterThan(0);
    expect(textsEqualTo("متوسط مرجّح للصنف")).toBeGreaterThan(0);
    expect(textsEqualTo("10.50")).toBeGreaterThan(0);
    expect(textsEqualTo("0")).toBe(0);
    expect(textsEqualTo("0.00")).toBe(0);

    // The report ran over every warehouse without waiting on the picker …
    const call = get.mock.calls.find(([path]) => path === "/erp/reports/inventory-value/nrv");
    expect(call?.[1]?.params?.warehouseId).toBe("");
    // … and the picker, once loaded, offers that choice first, then the warehouses.
    await waitFor(() => expect(screen.getByText("المستودع الرئيسي")).toBeInTheDocument());
    const options = [...document.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["كل المستودعات (متوسط تكلفة الصنف)", "المستودع الرئيسي"]);
  });

  it("refuses the page to a user without finance.reports.view", async () => {
    delete caps["finance.reports.view"];
    caps["pos.shifts.view"] = true; // a DIFFERENT operations capability
    render(
      <Wrapper>
        <OperationsReportPage reportId="inventory-nrv" />
      </Wrapper>,
    );
    await waitFor(() => expect(document.querySelector('[data-state="permission-denied"]')).toBeInTheDocument());
    expect(get.mock.calls.some(([path]) => String(path).includes("inventory-value"))).toBe(false);
  });
});
