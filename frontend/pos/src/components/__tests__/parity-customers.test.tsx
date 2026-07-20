/**
 * Parity evidence — العملاء (customers) domain of docs/pos-parity-matrix.md.
 * Each test names the matrix slug(s) it proves. The store hook is mocked so the
 * components under test run against a deterministic POS context.
 *
 * Slugs proven here:
 *   cust-status-bar, cust-unlink, cust-search-open, cust-search-debounce,
 *   cust-search-enter-autoselect, cust-search-empty-result,
 *   cust-modal-scaffold, cust-clear-after-sale
 * (cust-search-recent / cust-search-click-select / cust-search-null-guard are
 *  proven by the pre-existing CustomerPicker.test.tsx; cust-checkout-link by
 *  lib/__tests__/o2cPos.test.ts.)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CartPanel } from "../CartPanel";
import { CustomerPicker } from "../CustomerPicker";
import { Dialog } from "../Dialog";
import { PaymentDialog } from "../dialogs/PaymentDialog";
import type { CartTotals, LocalOrder } from "@/lib/types";
// CartPanel/PaymentDialog resolve strings via useT(), which throws without
// an ancestor I18nProvider (see i18n/I18nProvider.tsx). qcp() below wraps
// every render() through it — harmless for the CustomerPicker/Dialog cases
// that don't consume i18n context.
import { I18nProvider } from "@/i18n/I18nProvider";

// ── Mock the POS store hook (vi.mock is hoisted; state via vi.hoisted) ──────
const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ usePos: () => h.ctx }));

function makeCart(over: Partial<LocalOrder> = {}): LocalOrder {
  return {
    id: "01ORDER0000000000000000000",
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
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const ZERO_TOTALS: CartTotals = { subtotal: 0, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 0, netTotal: 0, total: 0 };

function baseCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { username: "c1", role: "cashier" },
    supervisor: false,
    caps: null,
    posCan: () => false,
    cart: makeCart(),
    totals: ZERO_TOTALS,
    catalog: null,
    setOrderType: vi.fn(),
    setTableNo: vi.fn(),
    setCustomer: vi.fn(),
    setCustomerRef: vi.fn(),
    o2cEnabled: true,
    setQty: vi.fn(),
    setLineUnit: vi.fn(),
    removeLine: vi.fn(),
    setLineNotes: vi.fn(),
    setLineDiscount: vi.fn(),
    engineStatus: { online: true, syncing: false, queueCount: 0 },
    pushToast: vi.fn(),
    ...over,
  };
}

const PAGE = {
  success: true,
  data: [
    { id: "C1", name: "شركة الأفق", phone: "0551234567", creditLimit: 0, balance: 0, derived: { arBalance: 0 }, isActive: true },
  ],
  pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
};

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

function stubFetch(body: unknown) {
  const fn = vi.fn(async (_input?: unknown) => jsonRes(body));
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

function qcp(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </I18nProvider>,
  );
}

const PANEL_PROPS = {
  heldCount: 0,
  onPay: vi.fn(),
  onHold: vi.fn(),
  onOpenHeld: vi.fn(),
  onVoid: vi.fn(),
  onOpenDiscount: vi.fn(),
  holdBusy: false,
  voidDisabledReason: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("cust-status-bar — العميل ظاهر دائمًا فوق السلة", () => {
  it("shows the empty state «عميل» when no customer is linked", () => {
    h.ctx = baseCtx();
    stubFetch(PAGE);
    qcp(<CartPanel {...PANEL_PROPS} />);
    expect(screen.getByRole("button", { name: "عميل" })).toBeInTheDocument();
  });

  it("shows the linked customer's name once attached", () => {
    h.ctx = baseCtx({ cart: makeCart({ customerId: "C2", customerName: "أحمد التاجر", customerPhone: "0509876543" }) });
    stubFetch(PAGE);
    qcp(<CartPanel {...PANEL_PROPS} />);
    expect(screen.getByRole("button", { name: "أحمد التاجر" })).toBeInTheDocument();
  });
});

describe("cust-unlink — إزالة ربط العميل", () => {
  it("«إزالة» in the attach popover clears the linked customer", () => {
    const setCustomerRef = vi.fn();
    h.ctx = baseCtx({
      cart: makeCart({ customerId: "C2", customerName: "أحمد التاجر", customerPhone: null }),
      setCustomerRef,
    });
    stubFetch(PAGE);
    qcp(<CartPanel {...PANEL_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "أحمد التاجر" }));
    fireEvent.click(screen.getByRole("button", { name: "إزالة" }));
    expect(setCustomerRef).toHaveBeenCalledWith(null);
  });

  it("the picker chip's X («مسح العميل») clears the selection", () => {
    const onChange = vi.fn();
    stubFetch(PAGE);
    qcp(<CustomerPicker value={{ id: "C1", name: "شركة الأفق", phone: "0551234567" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "مسح العميل" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("cust-search-open — فتح بحث العميل من السلة", () => {
  it("clicking «عميل» opens the searchable picker and loads the first page", async () => {
    h.ctx = baseCtx();
    stubFetch(PAGE);
    qcp(<CartPanel {...PANEL_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "عميل" }));
    expect(screen.getByPlaceholderText(/ابحث بالاسم أو الهاتف/)).toBeInTheDocument();
    expect(await screen.findByText("شركة الأفق")).toBeInTheDocument();
  });

  it("with O2C off, the legacy name/phone fields are shown instead (free-text customer)", () => {
    const setCustomer = vi.fn();
    h.ctx = baseCtx({ o2cEnabled: false, setCustomer });
    stubFetch(PAGE);
    qcp(<CartPanel {...PANEL_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "عميل" }));
    const name = screen.getByPlaceholderText("محمد أحمد");
    fireEvent.change(name, { target: { value: "محمد" } });
    expect(setCustomer).toHaveBeenCalledWith("محمد", null);
  });
});

describe("cust-search-debounce — بحث تدريجي بعد 250ms", () => {
  it("typing re-queries the server with the typed q after the debounce", async () => {
    const fetchMock = stubFetch(PAGE);
    qcp(<CustomerPicker value={null} onChange={vi.fn()} />);
    await screen.findByText("شركة الأفق"); // initial empty-q page
    const before = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "أفق" } });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.slice(before).map((c) => String(c[0]));
      expect(urls.some((u) => u.includes(`q=${encodeURIComponent("أفق")}`))).toBe(true);
    });
  });
});

describe("cust-search-enter-autoselect — Enter يختار النتيجة", () => {
  it("Enter picks the highlighted (single) result", async () => {
    const onChange = vi.fn();
    stubFetch(PAGE);
    qcp(<CustomerPicker value={null} onChange={onChange} />);
    await screen.findByText("شركة الأفق");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ id: "C1", name: "شركة الأفق", phone: "0551234567" });
  });
});

describe("cust-search-empty-result — حالة عدم وجود نتائج", () => {
  it("renders «لا عملاء مطابقون.» for an empty result set", async () => {
    stubFetch({ success: true, data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    qcp(<CustomerPicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByText("لا عملاء مطابقون.")).toBeInTheDocument();
  });
});

describe("cust-modal-scaffold — هيكل النوافذ (Esc / نقر خارجي / زر إغلاق)", () => {
  it("Escape closes the dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="اختبار">
        <p>محتوى</p>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the backdrop closes the dialog", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose} title="اختبار">
        <p>محتوى</p>
      </Dialog>,
    );
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("the header × («إغلاق») closes the dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="اختبار">
        <p>محتوى</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "إغلاق" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("cust-clear-after-sale — تصفير العميل بعد إتمام البيع", () => {
  it("a successful payment ends in startNewOrder (a fresh doc with no customer — store.tsx newLocalOrder)", async () => {
    const startNewOrder = vi.fn();
    const onClose = vi.fn();
    const checkout = vi.fn(async () => ({
      state: "completed" as const,
      invoiceNumber: "INV-20260717-0001",
      saleId: "S-1",
      zatcaQrDataUrl: null,
    }));
    h.ctx = baseCtx({
      cart: makeCart({
        customerId: "C1",
        customerName: "شركة الأفق",
        lines: [{ menuId: "M1", name: "شاي", qty: 1, unitPrice: 100, lineDiscount: 0, vatCategory: "S", notes: null }],
      }),
      totals: { subtotal: 100, lineDiscountTotal: 0, discountAmount: 0, vatTotal: 13.04, netTotal: 86.96, total: 100 },
      supervisor: true,
      startNewOrder,
      loadOrderDoc: vi.fn(),
      shiftId: "SH-1",
      o2cEnabled: true,
      engine: { onEvent: () => () => {}, checkout, getOrder: vi.fn(async () => null) },
    });
    stubFetch({});
    qcp(<PaymentDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await screen.findByText("تم الدفع بنجاح");
    expect(checkout).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "طلب جديد" }));
    expect(startNewOrder).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
