/**
 * W2-B — two capabilities the cashier already HELD but could not reach.
 *
 * 1. CREDIT EXPOSURE BEFORE THE TENDER. `customers.view` is granted to the
 *    cashier role (db/migrations/order-to-cash/capabilities.js), yet the credit
 *    ceiling only ever appeared as a server 422 CREDIT_LIMIT_EXCEEDED — after
 *    the whole cart was built and «آجل» was chosen, with the customer standing
 *    at the counter. The limit now shows at ATTACH time and the cart warns
 *    before the payment dialog opens.
 *
 * 2. سند قبض. `payments.create` is granted to the cashier too, but a regular
 *    settling their tab meant fetching a manager just to write it down. The
 *    till now records a DRAFT; approve/post stay manager capabilities.
 *
 * Both must DEGRADE, never break: /api/order-to-cash is behind
 * ORDER_TO_CASH_ENABLE (404 when off) and behind middleware/posPortalScope
 * (403 when the path is not on the cashier allow-list).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PosContextValue } from "@/state/store";
import { _resetCreditExposureCache, exceedsCreditLimit } from "../CustomerPicker";
import type { CustomerExposure } from "@/lib/api";
import { makeCtx, makeOrder, makeLine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { CustomerPicker } from "../CustomerPicker";
import { CustomerHistoryDialog } from "../dialogs/CustomerHistoryDialog";
import { CartPanel, type CartPanelProps } from "../CartPanel";
import { I18nProvider } from "@/i18n/I18nProvider";

const CUSTOMER = { id: "C1", name: "شركة الأفق", phone: "0551234567" };

const SUMMARY = {
  success: true,
  customer: { id: "C1", name: "شركة الأفق", nameEn: "", phone: "0551234567", email: "", gender: "unknown", customerType: "B2C", balance: 0, creditLimit: 5000, createdAt: "", isActive: true },
  kpi: { orderCount: 3, totalSpent: 900, avgInvoice: 300, firstVisit: null, lastVisit: null },
  recentInvoices: [],
};

function exposureBody(over: Partial<CustomerExposure> = {}) {
  return {
    success: true,
    data: {
      creditLimit: 5000,
      exposure: 1250.5,
      available: 3749.5,
      utilizationPct: 25.01,
      paymentTerms: "Net30",
      creditDays: 30,
      isActive: true,
      ...over,
    },
  };
}

/** URL-fragment-routed fetch stub. Entries are matched in insertion order, so
 *  the more specific fragment must come first. */
function stubRoutes(routes: Array<[string, { ok?: boolean; status?: number; body: unknown }]>) {
  const fn = vi.fn(async (url: string) => {
    for (const [frag, r] of routes) {
      if (String(url).includes(frag)) {
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => r.body,
        };
      }
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

function qcp(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  _resetCreditExposureCache();
  localStorage.setItem("pos_token", "tok-test");
  currentCtx = makeCtx();
});
afterEach(() => vi.unstubAllGlobals());

// ── the pure rule ───────────────────────────────────────────────────────────
describe("exceedsCreditLimit — mirrors CreditLimitService.assess", () => {
  const base: CustomerExposure = {
    creditLimit: 1000, exposure: 900, available: 100, utilizationPct: 90,
    paymentTerms: "Net30", creditDays: 30, isActive: true,
  };

  it("is false for a cash sale (no credit portion at all)", () => {
    expect(exceedsCreditLimit(base, 0)).toBe(false);
  });

  it("allows exactly up to the limit, refuses beyond it (halala tolerance)", () => {
    expect(exceedsCreditLimit(base, 100)).toBe(false);
    expect(exceedsCreditLimit(base, 100.005)).toBe(false); // inside the tolerance
    expect(exceedsCreditLimit(base, 150)).toBe(true);
  });

  it("a ZERO limit means no credit at all — the service throws CREDIT_LIMIT_EXCEEDED", () => {
    expect(exceedsCreditLimit({ ...base, creditLimit: 0, exposure: 0, available: 0 }, 1)).toBe(true);
  });
});

// ── 1. exposure at attach time ──────────────────────────────────────────────
describe("credit exposure on the attached customer", () => {
  it("shows limit / used / available with English digits", async () => {
    stubRoutes([
      ["/exposure", { body: exposureBody() }],
      ["/summary", { body: SUMMARY }],
    ]);
    qcp(<CustomerPicker value={CUSTOMER} onChange={vi.fn()} />);
    const strip = await screen.findByLabelText("حد الائتمان");
    expect(strip).toHaveTextContent("5,000.00");
    expect(strip).toHaveTextContent("1,250.50");
    expect(strip).toHaveTextContent("3,749.50");
    expect(/[٠-٩]/.test(strip.textContent || "")).toBe(false);
  });

  it("reads the endpoint the route actually exposes", async () => {
    const fetchFn = stubRoutes([
      ["/exposure", { body: exposureBody() }],
      ["/summary", { body: SUMMARY }],
    ]);
    qcp(<CustomerPicker value={CUSTOMER} onChange={vi.fn()} />);
    await screen.findByLabelText("حد الائتمان");
    const urls = fetchFn.mock.calls.map((c) => String((c as unknown as [string])[0]));
    expect(urls).toContain("/api/order-to-cash/customers/C1/exposure");
  });

  it("a cash-only walk-in (no limit, no balance) gets NO strip — attaching stays quiet", async () => {
    stubRoutes([
      ["/exposure", { body: exposureBody({ creditLimit: 0, exposure: 0, available: 0, utilizationPct: null }) }],
      ["/summary", { body: SUMMARY }],
    ]);
    qcp(<CustomerPicker value={CUSTOMER} onChange={vi.fn()} />);
    await screen.findByRole("button", { name: "سجل العميل" });
    expect(screen.queryByLabelText("حد الائتمان")).not.toBeInTheDocument();
  });

  it("DEGRADES on 403 (outside the cashier portal): no strip AND no سند قبض button", async () => {
    stubRoutes([
      ["/exposure", { ok: false, status: 403, body: { success: false, code: "PERMISSION_DENIED", reason: "PORTAL_FORBIDDEN", error: "خارج الصلاحيات" } }],
      ["/summary", { body: SUMMARY }],
    ]);
    qcp(<CustomerPicker value={CUSTOMER} onChange={vi.fn()} />);
    // the picker itself keeps working
    expect(await screen.findByRole("button", { name: "سجل العميل" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "سند قبض" })).not.toBeInTheDocument());
    expect(screen.queryByLabelText("حد الائتمان")).not.toBeInTheDocument();
  });

  it("DEGRADES on 404 (ORDER_TO_CASH_ENABLE off) the same way", async () => {
    stubRoutes([
      ["/exposure", { ok: false, status: 404, body: { success: false, error: "Not Found" } }],
      ["/summary", { body: SUMMARY }],
    ]);
    qcp(<CustomerPicker value={CUSTOMER} onChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "سجل العميل" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "سند قبض" })).not.toBeInTheDocument());
  });

  it("a REAL failure (500) says so instead of pretending the feature is absent", async () => {
    stubRoutes([
      ["/exposure", { ok: false, status: 500, body: { success: false, error: "boom" } }],
      ["/summary", { body: SUMMARY }],
    ]);
    qcp(<CustomerPicker value={CUSTOMER} onChange={vi.fn()} />);
    expect(await screen.findByText("تعذّر قراءة حد الائتمان.")).toBeInTheDocument();
  });
});

// ── the pre-tender warning in the cart ──────────────────────────────────────
describe("the cart warns BEFORE the payment dialog", () => {
  const PANEL: CartPanelProps = {
    heldCount: 0, onPay: vi.fn(), onHold: vi.fn(), onOpenHeld: vi.fn(), onVoid: vi.fn(),
    onOpenDiscount: vi.fn(), holdBusy: false, voidDisabledReason: null,
  };

  function renderPanel(over: Parameters<typeof makeCtx>[0] = {}) {
    currentCtx = makeCtx({
      o2cEnabled: true,
      cart: makeOrder({ customerId: "C1", customerName: "شركة الأفق", lines: [makeLine()] }), // 2 × 23 = 46.00
      ...over,
    });
    render(
      <I18nProvider>
        <CartPanel {...PANEL} />
      </I18nProvider>,
    );
  }

  it("warns when the cart total would break the limit, quoting the real headroom", async () => {
    stubRoutes([["/exposure", { body: exposureBody({ creditLimit: 1000, exposure: 990, available: 10 }) }]]);
    renderPanel();
    const alert = await screen.findByText(/المتاح من ائتمان العميل/);
    expect(alert).toHaveTextContent("10.00");
    expect(alert).toHaveTextContent("46.00");
  });

  it("says plainly when the customer has NO credit limit at all", async () => {
    stubRoutes([["/exposure", { body: exposureBody({ creditLimit: 0, exposure: 0, available: 0, utilizationPct: null }) }]]);
    renderPanel();
    expect(await screen.findByText(/لا يوجد حد ائتمان لهذا العميل/)).toBeInTheDocument();
  });

  it("stays silent when there is room — no scare on a customer in good standing", async () => {
    stubRoutes([["/exposure", { body: exposureBody() }]]); // 3,749.50 available vs 46.00
    renderPanel();
    await waitFor(() => expect(screen.queryByText(/المتاح من ائتمان العميل/)).not.toBeInTheDocument());
  });

  it("never blocks selling: «دفع» stays enabled even while over the limit", async () => {
    stubRoutes([["/exposure", { body: exposureBody({ creditLimit: 1000, exposure: 1000, available: 0 }) }]]);
    renderPanel();
    await screen.findByText(/المتاح من ائتمان العميل/);
    expect(screen.getByTitle("الدفع (F4)")).not.toBeDisabled();
  });

  it("makes NO exposure call at all with O2C off — the endpoint is not even mounted", async () => {
    const fetchFn = stubRoutes([["/exposure", { body: exposureBody() }]]);
    renderPanel({ o2cEnabled: false });
    await waitFor(() => expect(screen.getByTitle("الدفع (F4)")).toBeInTheDocument());
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── 2. سند قبض ──────────────────────────────────────────────────────────────
describe("سند قبض — a collection on account, recorded as a DRAFT", () => {
  function renderHistory() {
    return qcp(<CustomerHistoryDialog open onClose={vi.fn()} customer={CUSTOMER} allowCollect collectInitiallyOpen />);
  }

  it("is absent unless the caller opts in — a standalone history render is unchanged", async () => {
    stubRoutes([["/summary", { body: SUMMARY }]]);
    qcp(<CustomerHistoryDialog open onClose={vi.fn()} customer={CUSTOMER} />);
    await screen.findByText("إجمالي المشتريات");
    expect(screen.queryByRole("button", { name: "تسجيل السند" })).not.toBeInTheDocument();
  });

  it("POSTs the draft and shows the document number + the «no money moved yet» note", async () => {
    const fetchFn = stubRoutes([
      ["/order-to-cash/payments", { body: { success: true, data: { id: "CR-1", status: "draft", version: 1, payment_number: "DRAFT-77" }, documentNumber: "DRAFT-77", status: "draft", version: 1 } }],
      ["/summary", { body: SUMMARY }],
    ]);
    renderHistory();
    fireEvent.change(screen.getByLabelText("المبلغ (ر.س)"), { target: { value: "250.75" } });
    fireEvent.click(screen.getByRole("radio", { name: "بنك" }));
    fireEvent.click(screen.getByRole("button", { name: "تسجيل السند" }));

    expect(await screen.findByText("DRAFT-77")).toBeInTheDocument();
    expect(screen.getByText(/مسودة بانتظار اعتماد وترحيل المدير/)).toBeInTheDocument();

    const call = fetchFn.mock.calls.find((c) => String((c as unknown as [string])[0]).includes("/order-to-cash/payments"));
    const [, init] = call as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(JSON.parse(String(init.body))).toMatchObject({
      customerId: "C1", amount: 250.75, destinationType: "bank", paymentMethod: "bank",
    });
  });

  it("refuses to submit a non-positive amount client-side — the service would 422 anyway", async () => {
    const fetchFn = stubRoutes([["/summary", { body: SUMMARY }]]);
    renderHistory();
    expect(screen.getByRole("button", { name: "تسجيل السند" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("المبلغ (ر.س)"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "تسجيل السند" })).toBeDisabled();
    expect(fetchFn.mock.calls.every((c) => !String((c as unknown as [string])[0]).includes("/payments"))).toBe(true);
  });

  it("a 403 reads as «not from this screen», not as a bug to retry", async () => {
    stubRoutes([
      ["/order-to-cash/payments", { ok: false, status: 403, body: { success: false, code: "PERMISSION_DENIED", reason: "PORTAL_FORBIDDEN", error: "خارج الصلاحيات" } }],
      ["/summary", { body: SUMMARY }],
    ]);
    renderHistory();
    fireEvent.change(screen.getByLabelText("المبلغ (ر.س)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل السند" }));
    expect(await screen.findByText("تسجيل السندات غير متاح من هذه الشاشة.")).toBeInTheDocument();
  });

  it("a REAL server refusal surfaces the server's own message", async () => {
    stubRoutes([
      ["/order-to-cash/payments", { ok: false, status: 422, body: { success: false, code: "VALIDATION_ERROR", error: "العميل مطلوب لسند القبض" } }],
      ["/summary", { body: SUMMARY }],
    ]);
    renderHistory();
    fireEvent.change(screen.getByLabelText("المبلغ (ر.س)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل السند" }));
    expect(await screen.findByText("العميل مطلوب لسند القبض")).toBeInTheDocument();
  });
});
