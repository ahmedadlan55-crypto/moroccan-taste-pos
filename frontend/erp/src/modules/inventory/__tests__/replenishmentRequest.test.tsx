import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "@/i18n";

/**
 * «طلب النواقص» — the replenishment page used to be advisory-only: it listed the
 * shortages and left you to re-key them into a requisition by hand. This drives
 * the REAL ReplenishmentPage and asserts what its button actually PUTS ON THE
 * WIRE, because a control that renders but posts the wrong body is the same
 * defect with a green screenshot.
 *
 * The assertions are properties of the listed rows (quantity = recommendedQty,
 * unit price = recommendedValue ÷ recommendedQty, shortage rows only), not
 * hard-coded literals copied out of the component.
 */

const ROWS = vi.hoisted(() => [
  // two real shortages in the same warehouse …
  { itemId: "IT-1", sku: "S1", name: "دقيق", unit: "كجم", warehouseId: "WH-1", warehouseName: "المستودع الرئيسي",
    onHand: 2, reorderPoint: 10, recommendedQty: 8, recommendedValue: 20, daysOfCover: 1, reorderStatus: "critical", stockoutRisk: "high" },
  { itemId: "IT-2", sku: "S2", name: "سكر", unit: "كجم", warehouseId: "WH-1", warehouseName: "المستودع الرئيسي",
    onHand: 5, reorderPoint: 12, recommendedQty: 7, recommendedValue: 35, daysOfCover: 2, reorderStatus: "reorder", stockoutRisk: "medium" },
  // … and one healthy row that must NOT be requested
  { itemId: "IT-3", sku: "S3", name: "ملح", unit: "كجم", warehouseId: "WH-1", warehouseName: "المستودع الرئيسي",
    onHand: 50, reorderPoint: 10, recommendedQty: 0, recommendedValue: 0, daysOfCover: 40, reorderStatus: "ok", stockoutRisk: "low" },
]);

const SECOND_WAREHOUSE_ROW = vi.hoisted(() => ({
  itemId: "IT-4", sku: "S4", name: "زيت", unit: "لتر", warehouseId: "WH-2", warehouseName: "مستودع الفرع",
  onHand: 1, reorderPoint: 9, recommendedQty: 4, recommendedValue: 24, daysOfCover: 1, reorderStatus: "critical", stockoutRisk: "high",
}));

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], posts: [] as Array<{ path: string; body: unknown }> }));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/summary")) {
          return { data: { total: state.rows.length, reorderItems: 2, recommendedValue: 55, lookbackDays: 30, byStatus: {}, byRisk: {} } };
        }
        if (path.includes("replenishment")) {
          return { data: state.rows, pagination: { page: 1, pageSize: 25, total: state.rows.length, totalPages: 1 }, lookbackDays: 30, filters: {} };
        }
        return { data: [], rows: [], warehouses: [], accessibleWarehouses: [], allWarehousesAccess: true, capabilities: {} };
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        state.posts.push({ path, body });
        return { success: true, data: { id: "PR-TEST-1" }, documentNumber: "PR-20260802-0009", status: "draft", version: 1 };
      }),
      put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    },
  };
});

// The button is gated on purchasing.requisitions.manage; the backend stays
// authoritative, so granting it here is exactly what the real provider does for
// a user who holds the capability.
vi.mock("@/app/providers", () => ({ useCan: () => true }));

import { ReplenishmentPage } from "@/modules/inventory/features/replenishment/ReplenishmentPage";

function renderPage(search = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/inventory/replenishment" + search]}>
          <ReplenishmentPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const clickRequest = async () => {
  const btn = await screen.findByRole("button", { name: /طلب النواقص/ });
  fireEvent.click(btn);
};

describe("replenishment → requisition", () => {
  beforeEach(() => {
    state.rows = ROWS.map((r) => ({ ...r }));
    state.posts = [];
  });

  it("files the listed shortages as a draft requisition on the existing endpoint", async () => {
    renderPage();
    await screen.findAllByText("دقيق");
    await clickRequest();

    await waitFor(() => expect(state.posts.length).toBe(1));
    const { path, body } = state.posts[0] as { path: string; body: Record<string, unknown> };
    // the EXISTING purchasing endpoint — no new API was invented for this
    expect(path).toBe("/procurement/requisitions");

    const shortages = ROWS.filter((r) => r.recommendedQty > 0);
    const lines = body.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(shortages.length);
    // the healthy row is not requested
    expect(lines.map((l) => l.itemId)).not.toContain("IT-3");

    for (const s of shortages) {
      const line = lines.find((l) => l.itemId === s.itemId);
      expect(line, `item ${s.itemId} missing from the requisition`).toBeTruthy();
      // quantity is the plan's recommendation, not a re-derived guess
      expect(line!.quantity).toBe(s.recommendedQty);
      // and the unit price is the cost the plan valued that shortage at
      expect(line!.estimatedPrice).toBeCloseTo(s.recommendedValue / s.recommendedQty, 6);
      expect(line!.unit).toBe(s.unit);
    }
    // a requisition carries ONE warehouse — the one the listed rows belong to
    expect(body.warehouseId).toBe("WH-1");
  });

  it("links to the requisition it just created", async () => {
    renderPage();
    await screen.findAllByText("دقيق");
    await clickRequest();

    // the created document number is reported back, with a way to go open it
    expect(await screen.findByText(/PR-20260802-0009/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /طلبات الشراء/ });
    expect(link.getAttribute("href")).toBe("/purchasing/requisitions");
  });

  it("refuses to file rows that straddle two warehouses instead of guessing one", async () => {
    state.rows = [...ROWS.map((r) => ({ ...r })), { ...SECOND_WAREHOUSE_ROW }];
    renderPage();
    await screen.findAllByText("زيت");
    await clickRequest();

    expect(await screen.findByText(/اختر مستودعًا واحدًا/)).toBeInTheDocument();
    expect(state.posts).toHaveLength(0);
  });

  it("uses the active warehouse filter to resolve the ambiguity", async () => {
    state.rows = [...ROWS.map((r) => ({ ...r })), { ...SECOND_WAREHOUSE_ROW }];
    renderPage("?wh=WH-2");
    await screen.findAllByText("زيت");
    await clickRequest();

    await waitFor(() => expect(state.posts.length).toBe(1));
    expect((state.posts[0].body as Record<string, unknown>).warehouseId).toBe("WH-2");
  });
});
