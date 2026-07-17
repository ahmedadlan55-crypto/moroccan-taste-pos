/**
 * Parity — shortcuts + navigation + auth-gate rows (docs/pos-parity-matrix.md):
 *   no-global-hotkeys / keyboard-cart-footer-activate — React EXCEEDS legacy
 *     (which had ZERO hotkeys): F2 focuses search, F4 opens payment, F9 holds
 *   onscreen-tender-keypad — the payment dialog exposes quick-tender buttons +
 *     a decimal tender input with live change math
 *   hard-auth-gate / auth-require-auth — no session ⇒ LoginRequired screen,
 *     nothing else renders
 *   generic-confirm-modal / keyboard-modal-esc-enter / keyboard-escape-close-menu
 *     — the shared Dialog closes on Escape (and refuses while locked)
 *   keyboard-customer-search-enter / keyboard-customer-card-enter — Enter in
 *     the customer picker picks the active result (search itself is live)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cartTotals } from "@/lib/cartMath";
import type { Catalog, LocalOrder } from "@/lib/types";
import type { PosContextValue } from "@/state/store";

// ── usePos mock (state/store is context-heavy; App consumes only the hook) ──
const fixture: { value: PosContextValue | null } = { value: null };
vi.mock("@/state/store", () => ({
  usePos: () => {
    if (!fixture.value) throw new Error("fixture not initialised");
    return fixture.value;
  },
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, listOrders: vi.fn(async () => ({ success: true, data: [] })) };
});

import App from "@/App";
import { Dialog } from "@/components/Dialog";
import { CustomerPicker } from "@/components/CustomerPicker";

const CATALOG: Catalog = {
  items: [{ id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" }],
  categories: ["مشروبات"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  identity: null,
  serverTime: "2026-07-17T10:00:00Z",
};

function makeCart(lines = 1): LocalOrder {
  return {
    id: "01JGABCDEFGHJKMNPQRSTVWXYZ",
    status: "open",
    orderType: "takeaway",
    tableNo: null,
    shiftId: "SH-1",
    deviceId: "DEV-1",
    discountType: null,
    discountValue: 0,
    discountName: null,
    note: null,
    customerId: null,
    customerName: null,
    customerPhone: null,
    lines: Array.from({ length: lines }, () => ({
      menuId: "M1",
      name: "شاي مغربي",
      qty: 2,
      unitPrice: 23,
      lineDiscount: 0,
      vatCategory: "S" as const,
      notes: null,
    })),
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeFixture(overrides: Partial<PosContextValue> = {}): PosContextValue {
  const cart = makeCart(1);
  const engine = {
    localHeldOrders: vi.fn(async () => []),
    holdOrder: vi.fn(async () => {}),
    voidOrder: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    checkout: vi.fn(),
    getOrder: vi.fn(async () => undefined),
    queuedOps: vi.fn(async () => []),
    flush: vi.fn(async () => {}),
  };
  return {
    user: { username: "kashier1", role: "cashier" },
    supervisor: false,
    deviceId: "DEV-1",
    engine: engine as unknown as PosContextValue["engine"],
    engineStatus: { online: true, syncing: false, queueCount: 0, lastReport: null },
    catalog: CATALOG,
    catalogLoading: false,
    catalogError: null,
    catalogStale: false,
    catalogAgeMs: null,
    refetchCatalog: vi.fn(),
    shiftId: "SH-1",
    shiftLoading: false,
    openShiftNow: vi.fn(),
    openingShift: false,
    onShiftClosed: vi.fn(),
    cart,
    totals: cartTotals(cart.lines, null),
    addItem: vi.fn(),
    setQty: vi.fn(),
    setLineUnit: vi.fn(),
    removeLine: vi.fn(),
    setLineNotes: vi.fn(),
    setLineDiscount: vi.fn(),
    setOrderType: vi.fn(),
    setTableNo: vi.fn(),
    setDiscount: vi.fn(),
    setCustomer: vi.fn(),
    setCustomerRef: vi.fn(),
    o2cEnabled: false,
    setNote: vi.fn(),
    startNewOrder: vi.fn(),
    loadOrderDoc: vi.fn(),
    toasts: [],
    pushToast: vi.fn(),
    dismissToast: vi.fn(),
    ...overrides,
  };
}

function renderApp(overrides: Partial<PosContextValue> = {}) {
  fixture.value = makeFixture(overrides);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return fixture.value;
}

beforeEach(() => {
  fixture.value = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("hard-auth-gate — no session renders ONLY the login screen", () => {
  it("shows LoginRequired and no cashier surface", () => {
    renderApp({ user: null });
    expect(screen.getByText(/لا توجد جلسة دخول نشطة/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /سجّل الدخول من النظام الرئيسي/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("بحث في الأصناف أو مسح باركود")).not.toBeInTheDocument();
  });
});

describe("global keyboard shortcuts (F2 / F4 / F9) — exceed legacy's zero hotkeys", () => {
  it("F2 focuses (and selects) the search / barcode box", () => {
    renderApp();
    const input = screen.getByLabelText("بحث في الأصناف أو مسح باركود");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: "F2" });
    expect(document.activeElement).toBe(input);
  });

  it("F4 opens the payment dialog when the cart has lines — with the on-screen quick-tender controls", () => {
    renderApp();
    fireEvent.keyDown(window, { key: "F4" });
    expect(screen.getByRole("dialog", { name: "الدفع" })).toBeInTheDocument();
    // onscreen-tender-keypad parity: quick amounts + decimal tender field
    expect(screen.getByRole("button", { name: "المبلغ بالضبط" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "50" })).toBeInTheDocument();
    expect(screen.getByText("الباقي للعميل")).toBeInTheDocument();
  });

  it("F4 does NOT open payment for an empty cart", () => {
    const empty = makeCart(0);
    renderApp({ cart: empty, totals: cartTotals(empty.lines, null) });
    fireEvent.keyDown(window, { key: "F4" });
    expect(screen.queryByRole("dialog", { name: "الدفع" })).not.toBeInTheDocument();
  });

  it("F9 holds the current order through the engine", async () => {
    const f = renderApp();
    fireEvent.keyDown(window, { key: "F9" });
    await waitFor(() => expect(f.engine.holdOrder).toHaveBeenCalledTimes(1));
  });
});

describe("generic dialog keyboard behaviour (Escape)", () => {
  it("Escape closes an open dialog", () => {
    fixture.value = makeFixture();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="تجربة">
        <p>محتوى</p>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape is refused while the dialog is locked (mid-payment)", () => {
    fixture.value = makeFixture();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="تجربة" locked>
        <p>محتوى</p>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("customer picker keyboard — Enter picks the active result", () => {
  it("ArrowDown + Enter select a customer (live search, no Enter needed to search)", async () => {
    fixture.value = makeFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          success: true,
          data: [
            { id: "C1", name: "شركة الأفق", phone: "0551234567" },
            { id: "C2", name: "أحمد التاجر", phone: "0509876543" },
          ],
        }),
      })) as unknown as typeof fetch,
    );
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <CustomerPicker value={null} onChange={onChange} />
      </QueryClientProvider>,
    );
    await screen.findByText("شركة الأفق");
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ id: "C2", name: "أحمد التاجر", phone: "0509876543" });
  });
});
