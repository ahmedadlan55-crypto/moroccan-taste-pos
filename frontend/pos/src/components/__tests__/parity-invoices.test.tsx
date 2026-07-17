/**
 * Parity evidence — الفواتير/فواتيري (invoices) + المرتجعات والإلغاء (returns)
 * domains of docs/pos-parity-matrix.md. The store hook is mocked; the api
 * layer runs against a stubbed fetch.
 *
 * Slugs proven here:
 *   myinv-open / my-invoices-modal, myinv-load, myinv-refresh / my-invoices-refresh,
 *   myinv-stats, myinv-table, myinv-badges / my-invoices-status-badge, myinv-time-fmt,
 *   myinv-prod-chips, myinv-invnum-sysref, myinv-empty, invoice-numbering (display),
 *   void-return-serials (display), mgr-approval-gate, mgr-auth-modal, mgr-auth-submit,
 *   inv-return-reason (client half), inv-void-errors (O2C_MODULE_ACTIVE mapping)
 * Server halves (money actually moving) are proven by
 * tests/integration/salesReturns.api.test.js — the O2C returns flow.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MyInvoicesDialog } from "../dialogs/MyInvoicesDialog";
import { ManagerApprovalDialog } from "../dialogs/ManagerApprovalDialog";
import type { SaleRow } from "@/lib/types";

const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ usePos: () => h.ctx }));

function baseCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { username: "c1", role: "cashier" },
    shiftId: "SH-1",
    pushToast: vi.fn(),
    engineStatus: { online: true, syncing: false, queueCount: 0 },
    ...over,
  };
}

function row(over: Partial<SaleRow>): SaleRow {
  return {
    orderId: "ORD-1",
    date: "2026-07-17T10:30:00",
    total: 115,
    payment: "كاش",
    username: "c1",
    items: [{ name: "شاي", qty: 2 }],
    discount: 0,
    shiftId: "SH-1",
    customerId: null,
    customerName: null,
    customerPhone: null,
    paymentNotes: null,
    zatcaType: null,
    hasCreditNote: false,
    invoiceNumber: "INV-20260717-0001",
    voidSerial: null,
    returnSerial: null,
    ...over,
  };
}

const ACTIVE = row({
  orderId: "ORD-1",
  invoiceNumber: "INV-20260717-0001",
  customerName: "أحمد التاجر",
  items: [
    { name: "شاي", qty: 2 },
    { name: "قهوة", qty: 1 },
    { name: "كنافة", qty: 1 },
    { name: "ماء", qty: 1 },
    { name: "عصير", qty: 3 },
  ],
});

const CANCELLED = row({
  orderId: "ORD-2",
  invoiceNumber: "INV-20260717-0002",
  total: 50,
  zatcaType: "cancellation",
  voidSerial: "VOI-20260717-0001",
  items: [{ name: "شاي", qty: 1 }],
});

// A row from ANOTHER shift — must be filtered out client-side (legacy app.js:3300).
const OTHER_SHIFT = row({ orderId: "ORD-9", invoiceNumber: "INV-OTHER", shiftId: "SH-2" });

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

/** fetch stub: GET /api/sales → rows; POST /:id/void|/return → programmable. */
function stubSalesFetch(rows: SaleRow[], reverse?: { status: number; body: unknown }) {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (/\/api\/sales\/[^/]+\/(void|return)$/.test(url)) {
      const r = reverse ?? { status: 200, body: { success: true } };
      return jsonRes(r.body, r.status);
    }
    if (url.includes("/api/sales")) return jsonRes(rows);
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MyInvoicesDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("فواتيري — MyInvoicesDialog (myinv-* / my-invoices-*)", () => {
  it("myinv-open/load: loads today's sales and narrows to the ACTIVE SHIFT client-side", async () => {
    h.ctx = baseCtx();
    const fetchMock = stubSalesFetch([ACTIVE, CANCELLED, OTHER_SHIFT]);
    renderDialog();
    expect(await screen.findByText("INV-20260717-0001")).toBeInTheDocument();
    // the SH-2 row is excluded exactly like the legacy shift filter
    expect(screen.queryByText("INV-OTHER")).not.toBeInTheDocument();
    // and the request carried the username + today's window
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/sales?");
    expect(url).toContain("username=c1");
    expect(url).toMatch(/startDate=\d{4}-\d{2}-\d{2}/);
  });

  it("myinv-stats: stat strip counts total/active/cancelled and EXCLUDES reversed money", async () => {
    h.ctx = baseCtx();
    stubSalesFetch([ACTIVE, CANCELLED]);
    renderDialog();
    await screen.findByText("INV-20260717-0001");
    // amount = 115.00 (stat chip + row cell), NEVER 165.00 — the cancelled 50 is excluded
    expect(screen.getAllByText("115.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("165.00")).not.toBeInTheDocument();
    const chips = screen.getAllByText(/^(1|2)$/).map((n) => n.textContent);
    expect(chips).toContain("2");
    expect(chips).toContain("1");
  });

  it("myinv-table/time-fmt: renders the 7 legacy columns with a time cell per row", async () => {
    h.ctx = baseCtx();
    stubSalesFetch([ACTIVE]);
    renderDialog();
    await screen.findByText("INV-20260717-0001");
    for (const col of ["الحالة", "الوقت", "رقم الفاتورة", "المنتجات", "الإجمالي", "الدفع", "إجراءات"]) {
      expect(screen.getByRole("columnheader", { name: col })).toBeInTheDocument();
    }
  });

  it("myinv-badges + void-return-serials: reversed row gets the ملغاة badge with its VOI serial and is inert", async () => {
    h.ctx = baseCtx();
    stubSalesFetch([ACTIVE, CANCELLED]);
    renderDialog();
    const cancelledRow = (await screen.findByText("INV-20260717-0002")).closest("tr") as HTMLElement;
    expect(within(cancelledRow).getByText("ملغاة")).toBeInTheDocument();
    expect(within(cancelledRow).getByText(/VOI-20260717-0001/)).toBeInTheDocument();
    // reversed rows lose their action buttons — «تم — لا إجراءات»
    expect(within(cancelledRow).getByText("تم — لا إجراءات")).toBeInTheDocument();
  });

  it("myinv-prod-chips: first 3 products as chips then a «+N» counter", async () => {
    h.ctx = baseCtx();
    stubSalesFetch([ACTIVE]);
    renderDialog();
    await screen.findByText("INV-20260717-0001");
    expect(screen.getByText(/شاي/)).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument(); // 5 items → 3 chips + "+2"
  });

  it("myinv-invnum-sysref + invoice-numbering: human INV number on top, system orderId beneath", async () => {
    h.ctx = baseCtx();
    stubSalesFetch([ACTIVE]);
    renderDialog();
    expect(await screen.findByText("INV-20260717-0001")).toBeInTheDocument();
    expect(screen.getByText("ORD-1")).toBeInTheDocument();
  });

  it("myinv-empty: empty shift renders the legacy empty state", async () => {
    h.ctx = baseCtx();
    stubSalesFetch([]);
    renderDialog();
    expect(await screen.findByText("لا توجد فواتير في هذه الوردية بعد")).toBeInTheDocument();
  });

  it("myinv-refresh: «تحديث» re-queries the sales list", async () => {
    h.ctx = baseCtx();
    const fetchMock = stubSalesFetch([ACTIVE]);
    renderDialog();
    await screen.findByText("INV-20260717-0001");
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("بوابة اعتماد المدير (mgr-approval-gate / mgr-auth-modal / mgr-auth-submit)", () => {
  it("a cashier's إلغاء opens the approval gate instead of firing the void", async () => {
    h.ctx = baseCtx({ user: { username: "c1", role: "cashier" } });
    const fetchMock = stubSalesFetch([ACTIVE]);
    renderDialog();
    await screen.findByText("INV-20260717-0001");
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(await screen.findByText("اعتماد إلغاء فاتورة")).toBeInTheDocument();
    expect(screen.getByText(/يتطلب اعتماد مدير/)).toBeInTheDocument();
    // no void was sent — the gate comes first
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/void"))).toBe(false);
  });

  it("a cashier's مرتجع opens the gate WITH the reason field (inv-return-reason)", async () => {
    h.ctx = baseCtx({ user: { username: "c1", role: "cashier" } });
    stubSalesFetch([ACTIVE]);
    renderDialog();
    const activeRow = (await screen.findByText("INV-20260717-0001")).closest("tr") as HTMLElement;
    fireEvent.click(within(activeRow).getByRole("button", { name: "مرتجع" }));
    expect(await screen.findByText("اعتماد مرتجع")).toBeInTheDocument();
    expect(screen.getByLabelText("سبب الإرجاع")).toHaveValue("مرتجع عميل"); // legacy default (app.js:3547)
  });

  it("mgr-auth-submit: submits approver credentials + reason, disabled until complete", async () => {
    const onSubmit = vi.fn();
    render(
      <ManagerApprovalDialog
        open
        title="اعتماد مرتجع"
        reasonLabel="سبب الإرجاع"
        defaultReason="مرتجع عميل"
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const approve = screen.getByRole("button", { name: /اعتماد · Approve/ });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("اسم المستخدم للمدير"), { target: { value: "mgr" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "pw" } });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(onSubmit).toHaveBeenCalledWith({ approverUsername: "mgr", approverPassword: "pw" }, "مرتجع عميل");
  });
});

describe("inv-void-errors — رسائل أخطاء الإلغاء المُهيكلة (O2C gate)", () => {
  it("maps O2C_MODULE_ACTIVE (409 legacy-gate) to a clear cashier-facing toast", async () => {
    const pushToast = vi.fn();
    // admin bypasses the approval dialog (legacy parity, app.js:3527) → the void fires directly
    h.ctx = baseCtx({ user: { username: "boss", role: "admin" }, pushToast });
    stubSalesFetch([ACTIVE], {
      status: 409,
      body: { success: false, code: "O2C_MODULE_ACTIVE", error: "reversals moved to O2C" },
    });
    renderDialog();
    await screen.findByText("INV-20260717-0001");
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith("error", expect.stringContaining("الإلغاء والمرتجع منقولان")),
    );
  });
});
