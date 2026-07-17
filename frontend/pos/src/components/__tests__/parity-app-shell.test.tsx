/**
 * Parity — البيع (sell): App-level behaviors that live above the components:
 *   pay-open-keyboard (F4 opens the payment dialog),
 *   pay-open-from-total / payment-modal-open (the pay affordance opens the dialog),
 *   held-parked-orders (F9 holds the current order),
 *   mobile-cart-fab (bottom bar with live count + total, opens the cart sheet),
 *   product-search (F2 focuses the search / scan box).
 * usePos is mocked (parityTestkit); the api module is mocked so mounted-but-
 * closed dialogs never fetch.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeFakeEngine, makeOrder, makeLine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  isVersionConflict: () => false,
  fetchCatalog: vi.fn(),
  upsertOrder: vi.fn(),
  transition: vi.fn(),
  submitOrder: vi.fn(),
  completeOrder: vi.fn(),
  listOrders: vi.fn(async () => ({ success: true, data: [] })),
  postLegacySale: vi.fn(),
  postSync: vi.fn(),
  openShift: vi.fn(),
  findOpenShift: vi.fn(async () => null),
  closingDataV3: vi.fn(),
  closeShiftV3: vi.fn(),
  shiftSummary: vi.fn(async () => ({ success: true, data: { byStatus: {}, completedByMethod: {} } })),
  searchCustomers: vi.fn(async () => ({ success: true, data: [] })),
  getServerFlags: vi.fn(async () => ({})),
  listSales: vi.fn(async () => []),
  voidSale: vi.fn(),
  returnSale: vi.fn(),
}));

import App from "../../App";

async function renderApp(ctx: PosContextValue) {
  currentCtx = ctx;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  // Flush the initial async held-count refresh so no state lands outside act().
  await act(async () => {});
  return utils;
}

beforeEach(() => cleanup());

describe("pay-open-keyboard — F4 opens the payment dialog from anywhere", () => {
  it("F4 with lines in the cart opens الدفع", async () => {
    await renderApp(makeCtx());
    expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "F4" });
    expect(await screen.findByRole("dialog", { name: "الدفع" })).toBeInTheDocument();
  });

  it("F4 with an EMPTY cart does nothing (guard)", async () => {
    await renderApp(makeCtx({ cart: makeOrder({ lines: [] }) }));
    fireEvent.keyDown(window, { key: "F4" });
    expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument();
  });
});

describe("product-search — F2 focuses the search / barcode box", () => {
  it("F2 moves focus into the scan box", async () => {
    await renderApp(makeCtx());
    const box = screen.getByRole("searchbox", { name: /بحث في الأصناف/ });
    expect(box).not.toHaveFocus();
    fireEvent.keyDown(window, { key: "F2" });
    expect(box).toHaveFocus();
  });
});

describe("held-parked-orders — F9 holds the current order", () => {
  it("F9 snapshots the cart into engine.holdOrder and starts a new order", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ engine });
    await renderApp(ctx);
    fireEvent.keyDown(window, { key: "F9" });
    await waitFor(() => expect(engine.holdOrder).toHaveBeenCalledTimes(1));
    const held = engine.holdOrder.mock.calls[0]![0];
    expect(held.id).toBe(ctx.cart.id);
    expect(held.lines).toHaveLength(1);
    expect(ctx.startNewOrder).toHaveBeenCalledTimes(1);
    expect(ctx.pushToast).toHaveBeenCalledWith("success", expect.stringContaining("عُلّق الطلب"));
  });
});

describe("mobile-cart-fab — bottom bar carries live count + total and opens the sheet", () => {
  it("shows السلة with the item count (Σqty) and the cart total", async () => {
    const cart = makeOrder({ lines: [makeLine({ qty: 2 }), makeLine({ menuId: "M2", name: "طاجين لحم", qty: 3, unitPrice: 10 })] });
    await renderApp(makeCtx({ cart }));
    const fab = screen.getByRole("button", { name: /السلة/ });
    expect(fab).toHaveTextContent("5"); // 2 + 3 items
    expect(fab).toHaveTextContent("76.00"); // 46 + 30
  });

  it("tapping the bar opens the cart sheet (a second cart panel instance)", async () => {
    await renderApp(makeCtx());
    expect(screen.getAllByRole("region", { name: "سلة الطلب" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /السلة/ }));
    expect(screen.getAllByRole("region", { name: "سلة الطلب" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "إغلاق السلة" })).toBeInTheDocument();
  });
});
