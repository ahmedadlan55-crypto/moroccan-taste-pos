/**
 * Parity — shortcuts + navigation + auth-gate rows (docs/pos-parity-matrix.md):
 *   no-global-hotkeys / keyboard-cart-footer-activate — React EXCEEDS legacy
 *     (which had ZERO hotkeys): F2 focuses search, F4 opens payment, F9 holds
 *   onscreen-tender-keypad — the payment dialog exposes quick-tender buttons +
 *     a decimal tender input with live change math
 *   hard-auth-gate / auth-require-auth — no session ⇒ the PosLogin form,
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
// App renders Header/PosLogin/CartPanel/PaymentDialog, which resolve strings
// via useT() and throw without an ancestor I18nProvider (see
// i18n/I18nProvider.tsx) — normally supplied by main.tsx. Dialog and
// CustomerPicker below don't use i18n themselves, so their standalone
// render() calls are left unwrapped.
import { I18nProvider } from "@/i18n/I18nProvider";

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
    caps: null,
    posCan: () => false,
    deviceId: "DEV-1",
    engine: engine as unknown as PosContextValue["engine"],
    engineStatus: { online: true, syncing: false, queueCount: 0, lastReport: null },
    catalog: CATALOG,
    catalogLoading: false,
    catalogError: null,
    catalogErrorObject: null,
    catalogStale: false,
    catalogAgeMs: null,
    refetchCatalog: vi.fn(),
    vatRatePct: CATALOG.vatRate,
    channels: [],
    channelId: null,
    activeChannelId: null,
    channelPricesUnavailable: false,
    setChannel: vi.fn(),
    shiftId: "SH-1",
    shiftLoading: false,
    openShiftNow: vi.fn(),
    openingShift: false,
    onShiftClosed: vi.fn(),
    cart,
    totals: cartTotals(cart.lines, null),
    addItem: vi.fn(),
    decrementItem: vi.fn(),
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
    <I18nProvider>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return fixture.value;
}

beforeEach(() => {
  fixture.value = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("hard-auth-gate — no session renders ONLY the login screen", () => {
  it("shows the POS login form and no cashier surface", () => {
    renderApp({ user: null });
    // The POS now has its own login form (username/password) instead of a
    // bounce-to-main-system placeholder.
    expect(screen.getByLabelText("اسم المستخدم")).toBeInTheDocument();
    expect(screen.getByLabelText("كلمة المرور")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تسجيل الدخول/ })).toBeInTheDocument();
    // …and none of the cashier surface leaks through the gate.
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
    // onscreen-tender-keypad parity: quick amounts + decimal tender field.
    // This fixture's cart is tax-EXCLUSIVE 2 × 23 → 52.90 payable, so the
    // derived ladder (lib/tender.ts) is 52.90 / 55 / 60 / 100 / 200. The old
    // hardcoded "50" button is gone on purpose: 50 cannot settle a 52.90 bill,
    // which is the defect the ladder exists to remove.
    expect(screen.getByRole("button", { name: "المبلغ بالضبط" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "55" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "50" })).not.toBeInTheDocument();
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

  it("blocks destructive shortcuts while a payment overlay is open", async () => {
    const f = renderApp();
    fireEvent.keyDown(window, { key: "F4" });
    expect(screen.getAllByRole("dialog", { name: "الدفع" })).toHaveLength(1);
    fireEvent.keyDown(window, { key: "F9" });
    fireEvent.keyDown(window, { key: "F4" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.engine.holdOrder).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog", { name: "الدفع" })).toHaveLength(1);
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

  it("locks body scroll and wraps Tab focus inside the dialog", async () => {
    fixture.value = makeFixture();
    const { rerender } = render(
      <Dialog open onClose={() => {}} title="تجربة">
        <button type="button">الأول</button>
        <button type="button">الأخير</button>
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    const first = screen.getByRole("button", { name: "إغلاق" });
    const last = screen.getByRole("button", { name: "الأخير" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    rerender(<Dialog open={false} onClose={() => {}} title="تجربة"><span /></Dialog>);
    expect(document.body.style.overflow).toBe("");
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
