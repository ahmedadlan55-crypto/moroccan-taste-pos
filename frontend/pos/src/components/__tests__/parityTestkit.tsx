/**
 * Parity-test kit — a controllable fake PosContextValue for component tests.
 * Test files vi.mock("@/state/store") and route usePos() to the kit's current
 * context. NOT a test file itself (no .test. in the name — vitest skips it).
 */
import { vi } from "vitest";
import type { OfflineEngine, EngineStatus, CheckoutOutcome } from "@/lib/offline";
import type { PosContextValue } from "@/state/store";
import type { Catalog, CartLine, CartTotals, LocalOrder, Payment } from "@/lib/types";
import { cartTotals, DEFAULT_VAT_RATE_PCT } from "@/lib/cartMath";

export function makeLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    menuId: "M1",
    name: "شاي مغربي",
    qty: 2,
    unitPrice: 23,
    lineDiscount: 0,
    vatCategory: "S",
    // STATED, not assumed. The tax convention is per item now
    // (menu.is_tax_inclusive) and it changes the money: at 23.00 inclusive the
    // line is 46.00, exclusive it is 52.90. The UI specs built on this fixture
    // assert the 46.00 figures, so the fixture says which convention it means —
    // pass `taxInclusive: false` to exercise the other one. cartMath's own unit
    // tests cover both branches directly.
    taxInclusive: true,
    notes: null,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    id: "01TESTORDER0000000000000000",
    status: "open",
    orderType: "takeaway",
    tableNo: null,
    shiftId: "SH-77",
    deviceId: "DEV-1",
    discountType: null,
    discountValue: 0,
    discountName: null,
    note: null,
    customerId: null,
    customerName: null,
    customerPhone: null,
    lines: [makeLine()],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

export function makeCatalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    items: [
      { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" },
      { id: "M2", name: "طاجين لحم", price: 86, category: "أطباق", active: true, taxCategory: "S" },
      { id: "M3", name: "صنف موقوف", price: 10, category: "أطباق", active: false, taxCategory: "S" },
    ],
    categories: ["مشروبات", "أطباق"],
    vatRate: 15,
    maxCashierDiscountPct: 10,
    identity: null,
    serverTime: new Date(0).toISOString(),
    ...overrides,
  };
}

export interface FakeEngineOpts {
  status?: Partial<EngineStatus>;
}

/** A quiet, fully-synced till. One definition so a new EngineStatus field lands
 *  in every fake at once instead of in five hand-written literals. */
export const IDLE_ENGINE_STATUS: EngineStatus = {
  online: true,
  syncing: false,
  queueCount: 0,
  orphanCount: 0,
  orphanSaleCount: 0,
  orphanActors: [],
  lastReport: null,
};

export function makeFakeEngine(opts: FakeEngineOpts = {}) {
  const status: EngineStatus = { ...IDLE_ENGINE_STATUS, ...opts.status };
  const fake = {
    subscribe: vi.fn(() => () => {}),
    getStatus: vi.fn(() => status),
    onEvent: vi.fn(() => () => {}),
    getOrder: vi.fn(async () => undefined),
    putOrder: vi.fn(async () => {}),
    allOrders: vi.fn(async () => []),
    localHeldOrders: vi.fn(async () => []),
    latestOpenOrder: vi.fn(async () => undefined),
    saveCart: vi.fn(async () => {}),
    flushCartNow: vi.fn(async () => {}),
    enqueue: vi.fn(async () => ({}) as never),
    queuedOps: vi.fn(async () => []),
    isOrderSyncedOrQueued: vi.fn(async () => false),
    holdOrder: vi.fn(async (_doc: LocalOrder) => {}),
    resumeLocalOrder: vi.fn(async (d: LocalOrder) => d),
    voidOrder: vi.fn(async (_doc: LocalOrder, _reason: string) => {}),
    checkout: vi.fn(
      async (
        _doc: LocalOrder,
        _payments: Payment[],
        _opts: { cashTendered?: number; changeDue?: number; paymentNotes?: string },
      ): Promise<CheckoutOutcome> => ({ state: "completed", invoiceNumber: "INV-1", saleId: "SALE-1", zatcaQrDataUrl: null }),
    ),
    flush: vi.fn(async () => {}),
    pruneTerminalDocs: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return fake as unknown as OfflineEngine & typeof fake;
}

export interface MakeCtxOpts {
  cart?: LocalOrder;
  catalog?: Catalog | null;
  online?: boolean;
  supervisor?: boolean;
  shiftId?: string | null;
  o2cEnabled?: boolean;
  engine?: ReturnType<typeof makeFakeEngine>;
  overrides?: Partial<PosContextValue>;
}

/** Full fake PosContextValue; totals derive from the cart via the REAL cartMath. */
export function makeCtx(opts: MakeCtxOpts = {}): PosContextValue {
  const cart = opts.cart ?? makeOrder();
  const catalog = opts.catalog === undefined ? makeCatalog() : opts.catalog;
  // Mirrors the real provider: the rate rides on the catalog, and every cartMath
  // call goes through it. makeCatalog()'s 15 equals the old hardcoded default,
  // so every existing fixture's arithmetic is unchanged — but a spec that passes
  // a catalog with another rate now exercises the real threading.
  const vatRatePct = catalog?.vatRate ?? DEFAULT_VAT_RATE_PCT;
  const totals: CartTotals = cartTotals(
    cart.lines,
    cart.discountType ? { type: cart.discountType, value: cart.discountValue } : null,
    vatRatePct,
  );
  const engine = opts.engine ?? makeFakeEngine({ status: { online: opts.online ?? true } });
  const ctx: PosContextValue = {
    user: { username: "cashier1", role: "cashier" },
    supervisor: opts.supervisor ?? false,
    // Capability-aware fallback defaults to false so existing supervisor-only
    // expectations are unaffected; pass overrides.posCan / overrides.caps to
    // exercise capability-granted behavior in a specific test.
    caps: null,
    posCan: vi.fn(() => false),
    deviceId: "DEV-1",
    engine,
    engineStatus: { ...IDLE_ENGINE_STATUS, online: opts.online ?? true },
    catalog,
    catalogLoading: false,
    catalogError: null,
    catalogErrorObject: null,
    catalogStale: false,
    catalogAgeMs: null,
    refetchCatalog: vi.fn(),
    vatRatePct,
    channels: [],
    channelId: null,
    activeChannelId: null,
    channelPricesUnavailable: false,
    channelHealed: false,
    dismissChannelHealed: vi.fn(),
    setChannel: vi.fn(),
    shiftId: opts.shiftId === undefined ? "SH-77" : opts.shiftId,
    shiftLoading: false,
    openShiftNow: vi.fn(),
    openingShift: false,
    onShiftClosed: vi.fn(),
    cart,
    totals,
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
    o2cEnabled: opts.o2cEnabled ?? false,
    setNote: vi.fn(),
    startNewOrder: vi.fn(),
    loadOrderDoc: vi.fn(),
    toasts: [],
    pushToast: vi.fn(),
    dismissToast: vi.fn(),
    ...opts.overrides,
  };
  return ctx;
}
