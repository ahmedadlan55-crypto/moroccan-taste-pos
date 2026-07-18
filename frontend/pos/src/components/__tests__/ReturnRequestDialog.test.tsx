/**
 * طلب مرتجع (close2/pos-returns) — the cashier-facing O2C return-request dialog.
 * usePos() is mocked; the api layer runs against a stubbed fetch that serves the
 * invoice detail and a programmable POST /api/order-to-cash/returns result.
 *
 * Proven here (the frontend half; money actually moving is proven server-side by
 * tests/integration/salesReturns.api.test.js):
 *   • opens with the sale's line items + sold quantities,
 *   • blocks submission when a qty exceeds the sold qty (local guard),
 *   • submits the right body (originalSaleId, per-line restock:false) with an
 *     Idempotency-Key header and expectedVersion as If-Match,
 *   • shows the LITERAL returned status (draft → awaiting manager),
 *   • surfaces a server OVER_RETURN as a specific, readable message.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReturnRequestDialog, returnErrorMessage, returnStatusMessage } from "../dialogs/ReturnRequestDialog";
import { ApiError } from "@/lib/api";
import type { SaleRow } from "@/lib/types";

const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock("@/state/store", () => ({ usePos: () => h.ctx }));

afterEach(() => vi.unstubAllGlobals());

function baseCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { pushToast: vi.fn(), ...over };
}

function row(over: Partial<SaleRow> = {}): SaleRow {
  return {
    orderId: "ORD-1",
    date: "2026-07-17T10:00:00",
    total: 76,
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
    invoiceNumber: "INV-1",
    voidSerial: null,
    returnSerial: null,
    ...over,
  };
}

// The invoice-detail response the returns flow consumes: per-line `lineId`
// (= ar_document_lines.id / originalLineId) + a document `version` (expectedVersion).
const INVOICE = {
  orderId: "ORD-1",
  date: "2026-07-17T10:00:00",
  invoiceNumber: "INV-1",
  totalFinal: 76,
  version: 4,
  items: [
    { name: "شاي أتاي", qty: 2, price: 23, total: 46, lineId: "ARL-1" },
    { name: "ماء", qty: 3, price: 10, total: 30, lineId: "ARL-2" },
  ],
};

const CREATE_OK = {
  status: 201,
  body: {
    success: true,
    data: { id: "SRET-1", status: "draft", version: 1, return_number: "DRAFT-abc123" },
    documentNumber: "DRAFT-abc123",
    status: "draft",
    version: 1,
  },
};

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

type Captured = { url: string; init: RequestInit };

/** fetch stub: GET the invoice detail; POST returns → a programmable result. */
function stubFetch(createResult: { status: number; body: unknown } = CREATE_OK) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/sales/invoice/")) return jsonRes(INVOICE);
    if (url.includes("/api/order-to-cash/returns")) return jsonRes(createResult.body, createResult.status);
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return { fn, calls };
}

function renderDialog(props: Partial<Parameters<typeof ReturnRequestDialog>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReturnRequestDialog open row={row()} onClose={vi.fn()} onCreated={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

function reasonField() {
  return screen.getByLabelText("سبب الإرجاع");
}
function qtyInputs() {
  return screen.getAllByLabelText(/كمية إرجاع/);
}
function submitButton() {
  return screen.getByRole("button", { name: /إنشاء طلب المرتجع/ });
}

describe("ReturnRequestDialog — cashier O2C return request", () => {
  it("opens with the sale's line items and sold quantities", async () => {
    h.ctx = baseCtx();
    stubFetch();
    renderDialog();
    expect(await screen.findByText("شاي أتاي")).toBeInTheDocument();
    expect(screen.getByText("ماء")).toBeInTheDocument();
    // one qty input per sold line, and the sold quantities are shown (2.00 / 3.00)
    expect(qtyInputs()).toHaveLength(2);
    expect(screen.getByText("2.00")).toBeInTheDocument();
    expect(screen.getByText("3.00")).toBeInTheDocument();
  });

  it("blocks submission when a return qty exceeds the sold qty (local guard)", async () => {
    h.ctx = baseCtx();
    const { fn } = stubFetch();
    renderDialog();
    await screen.findByText("شاي أتاي");
    fireEvent.change(reasonField(), { target: { value: "تالف" } });
    // sold=2 on line 1 → enter 5
    fireEvent.change(qtyInputs()[0], { target: { value: "5" } });
    expect(screen.getByText("الكمية تتجاوز المُباع")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    // no create request fired
    expect(fn.mock.calls.some((c) => String(c[0]).includes("/api/order-to-cash/returns"))).toBe(false);
  });

  it("submits originalSaleId + per-line restock:false with Idempotency-Key and expectedVersion (If-Match)", async () => {
    h.ctx = baseCtx();
    const { calls } = stubFetch();
    renderDialog();
    await screen.findByText("شاي أتاي");
    fireEvent.change(reasonField(), { target: { value: "طلب العميل" } });
    fireEvent.change(qtyInputs()[0], { target: { value: "1" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/order-to-cash/returns"))).toBe(true));
    const post = calls.find((c) => c.url.includes("/api/order-to-cash/returns"))!;
    const headers = post.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["If-Match"]).toBe("4"); // expectedVersion from the invoice's version
    const body = JSON.parse(String(post.init.body));
    expect(body.originalSaleId).toBe("ORD-1");
    expect(body.reason).toBe("طلب العميل");
    // restock is ALWAYS false from the cashier dialog
    expect(body.lines).toEqual([{ originalLineId: "ARL-1", returnQty: 1, restock: false }]);
  });

  it("shows the LITERAL returned status (draft → awaiting manager) after create", async () => {
    h.ctx = baseCtx();
    stubFetch();
    const onCreated = vi.fn();
    renderDialog({ onCreated });
    await screen.findByText("شاي أتاي");
    fireEvent.change(reasonField(), { target: { value: "سبب" } });
    fireEvent.change(qtyInputs()[0], { target: { value: "1" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText("تم إنشاء طلب المرتجع — بانتظار اعتماد المدير")).toBeInTheDocument();
    expect(screen.getByText("DRAFT-abc123")).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalled();
  });

  it("surfaces a server OVER_RETURN as a specific, readable message", async () => {
    h.ctx = baseCtx();
    stubFetch({
      status: 422,
      body: { success: false, code: "OVER_RETURN", error: "كمية المرتجع (5) تتجاوز المتاح (2) للسطر" },
    });
    renderDialog();
    await screen.findByText("شاي أتاي");
    fireEvent.change(reasonField(), { target: { value: "سبب" } });
    fireEvent.change(qtyInputs()[0], { target: { value: "1" } });
    fireEvent.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("الكمية المطلوبة تتجاوز المتاح للإرجاع");
    // the specific server detail rides along (not a generic failure)
    expect(alert).toHaveTextContent(/تتجاوز المتاح \(2\)/);
  });
});

describe("ReturnRequestDialog — pure helpers", () => {
  it("returnStatusMessage maps the create status to a plain cashier line", () => {
    expect(returnStatusMessage("draft")).toBe("تم إنشاء طلب المرتجع — بانتظار اعتماد المدير");
    expect(returnStatusMessage("approved")).toContain("بانتظار الترحيل");
    expect(returnStatusMessage("posted")).toContain("ترحيله");
    expect(returnStatusMessage("weird")).toContain("weird");
  });

  it("returnErrorMessage gives OVER_RETURN its own readable message", () => {
    const over = new ApiError(422, "OVER_RETURN", "كمية المرتجع (5) تتجاوز المتاح (2) للسطر");
    expect(returnErrorMessage(over)).toContain("الكمية المطلوبة تتجاوز المتاح للإرجاع");
    const generic = new ApiError(500, "SERVER_ERROR", "boom");
    expect(returnErrorMessage(generic)).toBe("boom");
  });
});
