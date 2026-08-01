/**
 * The till must always show a visible way back to default prices.
 *
 * Two separate defects met here and produced the owner's «مشكلة لا تنحل»:
 *
 *  1. `channelPricesUnavailable` was computed in state/store.tsx and rendered
 *     NOWHERE. The till served base prices while the picker advertised a
 *     channel, and said nothing — so nobody could even name the problem.
 *
 *  2. The <select> is the only channel control, and it cannot clear a stored
 *     preference it is already displaying as cleared: App computes
 *     `activeChannelId = channels.some(c => c.id === channelId) ? channelId : null`,
 *     so a dead id shows «الأساسي», and re-picking the option a select is
 *     already on fires no change event. The only visible exit was a no-op.
 *
 * The store's self-heal (state/__tests__/channelSelfHeal.test.tsx) covers the
 * channel that no longer EXISTS. This covers the one that exists but cannot
 * serve prices — an empty price list, or a plain outage — where the preference
 * is deliberately kept and the cashier needs a manual way out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cartTotals } from "@/lib/cartMath";
import type { Catalog, LocalOrder } from "@/lib/types";
import type { PosContextValue } from "@/state/store";

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
import { I18nProvider } from "@/i18n/I18nProvider";
import { IDLE_ENGINE_STATUS } from "./parityTestkit";

const CATALOG: Catalog = {
  items: [{ id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" }],
  categories: ["مشروبات"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  channels: [{ id: "CH1", name: "هنقرستيشن" }],
  identity: null,
  serverTime: "2026-07-27T10:00:00Z",
};

function makeCart(): LocalOrder {
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
    lines: [],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function renderApp(overrides: Partial<PosContextValue>) {
  const cart = makeCart();
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
  fixture.value = {
    user: { username: "kashier1", role: "cashier" },
    supervisor: false,
    caps: null,
    posCan: () => false,
    deviceId: "DEV-1",
    engine: engine as unknown as PosContextValue["engine"],
    engineStatus: { ...IDLE_ENGINE_STATUS },
    catalog: CATALOG,
    catalogLoading: false,
    catalogError: null,
    catalogErrorObject: null,
    catalogStale: false,
    catalogAgeMs: null,
    refetchCatalog: vi.fn(),
    vatRatePct: CATALOG.vatRate,
    channels: CATALOG.channels ?? [],
    channelId: null,
    activeChannelId: null,
    channelPricesUnavailable: false,
    channelHealed: false,
    dismissChannelHealed: vi.fn(),
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
  } as PosContextValue;

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

afterEach(() => {
  cleanup();
  fixture.value = null;
});

describe("channel prices unavailable — the cashier is told, and can get out", () => {
  it("says which prices are actually ringing up", () => {
    renderApp({ channelId: "CH1", channelPricesUnavailable: true });
    const note = screen.getByTestId("channel-prices-unavailable");
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent("أسعار الأساسي");
  });

  it("offers a reset that clears the stored preference directly", () => {
    const ctx = renderApp({ channelId: "CH1", channelPricesUnavailable: true });
    fireEvent.click(screen.getByRole("button", { name: "العودة إلى الأساسي" }));
    // setChannel(null) — NOT a select change event, which is precisely the path
    // that could not fire when the picker already displayed «الأساسي».
    expect(ctx.setChannel).toHaveBeenCalledWith(null);
  });

  it("stays out of the way when the channel's own prices are being served", () => {
    renderApp({ channelId: "CH1", activeChannelId: "CH1", channelPricesUnavailable: false });
    expect(screen.queryByTestId("channel-prices-unavailable")).not.toBeInTheDocument();
  });

  it("is reachable even on the default, so a wedged device is never without an exit", () => {
    // The wedge state itself: a dead stored id renders the picker on «الأساسي»
    // while the served prices are not the channel's.
    renderApp({ channelId: "CH-DELETED", activeChannelId: null, channelPricesUnavailable: true });
    expect(screen.getByRole("button", { name: "العودة إلى الأساسي" })).toBeInTheDocument();
  });
});
