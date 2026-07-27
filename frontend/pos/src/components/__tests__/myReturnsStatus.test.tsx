/**
 * W2-B — «مرتجعاتي»: the cashier can finally SEE what happened to a return.
 *
 * The cashier holds `returns.create` and raises an O2C draft from فواتيري, then
 * loses all sight of it: nothing in the POS ever mentioned it again, so "did
 * the manager approve my return?" had no answer short of asking the manager.
 * `returns.view` was granted the whole time (capabilities.js ROLE_GRANTS).
 *
 * The one honest complication: SalesReturnService.list() filters by status /
 * customerId / return_number ONLY — no created_by filter, and the SELECT does
 * not project the column. So "mine" is resolved by intersecting the server list
 * with a local ledger of what THIS till raised; the server stays the sole
 * authority on STATUS, and a row it does not return is shown as unknown rather
 * than with a stale local guess.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PosContextValue } from "@/state/store";
import { _resetRaisedReturns, listRaisedReturns, recordRaisedReturn } from "@/lib/api";
import { makeCtx } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { MyInvoicesDialog, returnStatusKey, returnStatusTone } from "../dialogs/MyInvoicesDialog";
import { ReturnRequestDialog } from "../dialogs/ReturnRequestDialog";
import { I18nProvider } from "@/i18n/I18nProvider";

function returnRow(over: Record<string, unknown> = {}) {
  return {
    id: "SR-1",
    return_number: "SRET-100",
    original_ar_document_id: "AR-9",
    customer_name: "شركة الأفق",
    return_date: "2026-07-26",
    total_amount: "46.00",
    status: "draft",
    credit_note_id: null,
    version: 1,
    ...over,
  };
}

/** URL-fragment-routed stub; entries match in insertion order. */
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

function open(ctxOver: Parameters<typeof makeCtx>[0] = {}) {
  currentCtx = makeCtx({ o2cEnabled: true, ...ctxOver });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MyInvoicesDialog open onClose={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  _resetRaisedReturns();
  localStorage.setItem("pos_token", "tok-test");
});
afterEach(() => vi.unstubAllGlobals());

describe("returnStatusKey / returnStatusTone — the lifecycle, in the cashier's words", () => {
  it("maps every sales_returns status", () => {
    expect(returnStatusKey("draft")).toBe("myInvoicesDialog.returns.status.draft");
    expect(returnStatusKey("approved")).toBe("myInvoicesDialog.returns.status.approved");
    expect(returnStatusKey("posted")).toBe("myInvoicesDialog.returns.status.posted");
    expect(returnStatusKey("reversed")).toBe("myInvoicesDialog.returns.status.reversed");
    expect(returnStatusKey("cancelled")).toBe("myInvoicesDialog.returns.status.cancelled");
  });

  it("an UNKNOWN status returns null so the raw value is rendered — never silently «done»", () => {
    expect(returnStatusKey("something_new")).toBeNull();
    expect(returnStatusKey(null)).toBeNull();
    expect(returnStatusTone("something_new")).toContain("slate");
  });

  it("a terminal-negative status is not dressed up as progress", () => {
    expect(returnStatusTone("posted")).toContain("teal");
    expect(returnStatusTone("draft")).toContain("amber");
    expect(returnStatusTone("reversed")).toContain("red");
    expect(returnStatusTone("cancelled")).toContain("red");
  });
});

describe("the «مرتجعاتي» tab", () => {
  it("is not offered at all with O2C off — the returns namespace is not mounted", () => {
    stubRoutes([["/api/sales", { body: [] }]]);
    open({ o2cEnabled: false });
    expect(screen.queryByRole("tab", { name: "مرتجعاتي" })).not.toBeInTheDocument();
  });

  it("shows the SERVER's status for a return this till raised", async () => {
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-77" });
    stubRoutes([
      ["/order-to-cash/returns", { body: { success: true, data: [returnRow({ status: "approved" })] } }],
      ["/api/sales", { body: [] }],
    ]);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    expect(await screen.findByText("معتمد — بانتظار الترحيل")).toBeInTheDocument();
    expect(screen.getByText("SRET-100")).toBeInTheDocument();
    expect(screen.getByText("ORD-77")).toBeInTheDocument();
    expect(screen.getByText("46.00")).toBeInTheDocument();
  });

  it("shows ONLY the returns this till raised — a branch-mate's return stays out", async () => {
    recordRaisedReturn({ id: "SR-MINE", documentNumber: "DRAFT-1", originalSaleId: "ORD-1" });
    stubRoutes([
      [
        "/order-to-cash/returns",
        {
          body: {
            success: true,
            data: [
              returnRow({ id: "SR-MINE", return_number: "SRET-MINE" }),
              returnRow({ id: "SR-THEIRS", return_number: "SRET-THEIRS" }),
            ],
          },
        },
      ],
      ["/api/sales", { body: [] }],
    ]);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    expect(await screen.findByText("SRET-MINE")).toBeInTheDocument();
    expect(screen.queryByText("SRET-THEIRS")).not.toBeInTheDocument();
  });

  it("a ledger row the server list does not carry reads «غير معروفة», not a stale status", async () => {
    recordRaisedReturn({ id: "SR-OLD", documentNumber: "DRAFT-OLD", originalSaleId: "ORD-5" });
    stubRoutes([
      ["/order-to-cash/returns", { body: { success: true, data: [] } }],
      ["/api/sales", { body: [] }],
    ]);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    expect(await screen.findByText("غير معروفة")).toBeInTheDocument();
    // it still names the document, so the cashier can quote it to the manager
    expect(screen.getByText("DRAFT-OLD")).toBeInTheDocument();
  });

  it("with nothing raised it shows an empty state and makes NO request", async () => {
    const fetchFn = stubRoutes([["/api/sales", { body: [] }]]);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    expect(await screen.findByText("لم ترفع أي طلب مرتجع بعد")).toBeInTheDocument();
    const urls = fetchFn.mock.calls.map((c) => String((c as unknown as [string])[0]));
    expect(urls.some((u) => u.includes("/order-to-cash/returns"))).toBe(false);
  });

  it("DEGRADES on 403 to «not available from this screen» — not an error to retry", async () => {
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1" });
    stubRoutes([
      ["/order-to-cash/returns", { ok: false, status: 403, body: { success: false, code: "PERMISSION_DENIED", reason: "PORTAL_FORBIDDEN", error: "خارج الصلاحيات" } }],
      ["/api/sales", { body: [] }],
    ]);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    expect(await screen.findByText("متابعة المرتجعات غير متاحة من هذه الشاشة")).toBeInTheDocument();
  });

  it("a REAL failure keeps the retry affordance", async () => {
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1" });
    stubRoutes([
      ["/order-to-cash/returns", { ok: false, status: 500, body: { success: false, error: "boom" } }],
      ["/api/sales", { body: [] }],
    ]);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("offline says so rather than showing an empty list", async () => {
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1" });
    stubRoutes([["/api/sales", { body: [] }]]);
    open({ online: false });
    fireEvent.click(screen.getByRole("tab", { name: "مرتجعاتي" }));
    await waitFor(() => expect(screen.getByText(/عرض الفواتير يتطلب اتصالًا بالخادم/)).toBeInTheDocument());
  });
});

describe("the ledger is written by the RETURN dialog, not by the list", () => {
  const INVOICE = {
    orderId: "ORD-1",
    date: "2026-07-26T10:00:00",
    invoiceNumber: "INV-1",
    totalFinal: 46,
    version: 4,
    items: [{ name: "شاي أتاي", qty: 2, price: 23, total: 46, lineId: "ARL-1" }],
  };
  const saleRow = {
    orderId: "ORD-1", date: "2026-07-26T10:00:00", total: 46, payment: "كاش", username: "cashier1",
    items: [{ name: "شاي أتاي", qty: 2 }], discount: 0, shiftId: "SH-77",
    customerId: null, customerName: null, customerPhone: null, paymentNotes: null,
    zatcaType: null, hasCreditNote: false, invoiceNumber: "INV-1", voidSerial: null, returnSerial: null,
  };

  it("stays empty until a return is actually raised", () => {
    expect(listRaisedReturns()).toEqual([]);
  });

  it("a successful create records the return's IDENTITY (never its status)", async () => {
    currentCtx = makeCtx({ o2cEnabled: true });
    stubRoutes([
      ["/api/sales/invoice/", { body: INVOICE }],
      [
        "/order-to-cash/returns",
        {
          status: 201,
          body: {
            success: true,
            data: { id: "SRET-9", status: "draft", version: 1, return_number: "DRAFT-abc" },
            documentNumber: "DRAFT-abc",
            status: "draft",
            version: 1,
          },
        },
      ],
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ReturnRequestDialog open row={saleRow} onClose={vi.fn()} onCreated={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("شاي أتاي");
    fireEvent.change(screen.getByLabelText("سبب الإرجاع"), { target: { value: "تالف" } });
    fireEvent.change(screen.getAllByLabelText(/كمية إرجاع/)[0], { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /إنشاء طلب المرتجع/ }));

    await waitFor(() => expect(listRaisedReturns()).toHaveLength(1));
    expect(listRaisedReturns()[0]).toMatchObject({
      id: "SRET-9",
      documentNumber: "DRAFT-abc",
      originalSaleId: "ORD-1",
    });
    expect(listRaisedReturns()[0]).not.toHaveProperty("status");
  });
});
