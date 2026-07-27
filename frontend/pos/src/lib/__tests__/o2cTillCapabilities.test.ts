/**
 * W2-B — the three Order-to-Cash contracts the till now speaks, pinned against
 * the ACTUAL route/service files:
 *   GET  /api/order-to-cash/customers/:id/exposure  (customers.js:52)
 *   POST /api/order-to-cash/payments                (payments.js:41)
 *   GET  /api/order-to-cash/returns                 (returns.js:24)
 *
 * Plus the two rules everything else depends on: what counts as "this till
 * cannot reach the feature" (vs a real error), and the local ledger that makes
 * «مرتجعاتي» possible at all — SalesReturnService.list() has no created_by
 * filter, so the server cannot answer "the returns I raised".
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  ApiError,
  _resetRaisedReturns,
  createCustomerPayment,
  getCustomerExposure,
  isFeatureUnavailable,
  listRaisedReturns,
  listSalesReturns,
  recordRaisedReturn,
} from "../api";

function stubJson(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  _resetRaisedReturns();
  localStorage.setItem("pos_token", "tok-test");
});
afterEach(() => vi.unstubAllGlobals());

describe("isFeatureUnavailable — «not from this till» vs a real failure", () => {
  it("404 (ORDER_TO_CASH_ENABLE off → the router is never mounted) is unavailable", () => {
    expect(isFeatureUnavailable(new ApiError(404, "SERVER_ERROR", "Not Found"))).toBe(true);
  });

  it("403 (middleware/posPortalScope PORTAL_FORBIDDEN, or a missing capability) is unavailable", () => {
    expect(isFeatureUnavailable(new ApiError(403, "PERMISSION_DENIED", "خارج صلاحيات بوابة الكاشير"))).toBe(true);
  });

  it("a validation / conflict / server error is a REAL failure and must surface", () => {
    expect(isFeatureUnavailable(new ApiError(422, "VALIDATION_ERROR", "مبلغ التحصيل يجب أن يكون موجبًا"))).toBe(false);
    expect(isFeatureUnavailable(new ApiError(409, "IDEMPOTENCY_CONFLICT", "x"))).toBe(false);
    expect(isFeatureUnavailable(new ApiError(500, "SERVER_ERROR", "boom"))).toBe(false);
    expect(isFeatureUnavailable(new Error("network down"))).toBe(false);
  });
});

describe("GET /customers/:id/exposure — the credit ceiling, before the tender", () => {
  it("hits the exact path with the POS bearer and unwraps H.sendData's envelope", async () => {
    const fetchFn = stubJson({
      success: true,
      generatedAt: "2026-07-27T00:00:00.000Z",
      data: {
        creditLimit: 5000,
        exposure: 1250.5,
        available: 3749.5,
        utilizationPct: 25.01,
        paymentTerms: "Net30",
        creditDays: 30,
        isActive: true,
      },
    });
    const e = await getCustomerExposure("C 1/x");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/order-to-cash/customers/${encodeURIComponent("C 1/x")}/exposure`);
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    expect(e).toEqual({
      creditLimit: 5000,
      exposure: 1250.5,
      available: 3749.5,
      utilizationPct: 25.01,
      paymentTerms: "Net30",
      creditDays: 30,
      isActive: true,
    });
  });

  it("a zero limit yields utilizationPct null — CreditLimitService cannot divide by it", async () => {
    stubJson({ success: true, data: { creditLimit: 0, exposure: 0, available: 0, utilizationPct: null } });
    expect((await getCustomerExposure("C1")).utilizationPct).toBeNull();
  });

  it("a 403 from the cashier-portal boundary throws an ApiError the caller can classify", async () => {
    stubJson({ success: false, code: "PERMISSION_DENIED", reason: "PORTAL_FORBIDDEN", error: "خارج الصلاحيات" }, false, 403);
    await expect(getCustomerExposure("C1")).rejects.toBeInstanceOf(ApiError);
    await expect(getCustomerExposure("C1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("POST /payments — سند قبض, DRAFT only", () => {
  it("sends the exact body CustomerPaymentService.create reads, with an Idempotency-Key", async () => {
    const fetchFn = stubJson({
      success: true,
      data: { id: "CR-1", status: "draft", version: 1, payment_number: "DRAFT-9" },
      documentNumber: "DRAFT-9",
      status: "draft",
      version: 1,
    });
    const res = await createCustomerPayment(
      { customerId: "C1", customerName: "هند", amount: 250.75, destinationType: "bank", reference: "TRX-9", notes: "تسوية" },
      { idempotencyKey: "KEY-1" },
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/order-to-cash/payments");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("KEY-1");
    expect(JSON.parse(String(init.body))).toEqual({
      customerId: "C1",
      customerName: "هند",
      amount: 250.75,
      destinationType: "bank",
      paymentMethod: "bank",
      reference: "TRX-9",
      notes: "تسوية",
    });
    expect(res.status).toBe("draft");
  });

  it("NEVER sends allocations — deciding which invoices a collection settles is the accountant's call", async () => {
    const fetchFn = stubJson({ success: true, data: { id: "CR-2", status: "draft", version: 1 }, documentNumber: null, status: "draft", version: 1 });
    await createCustomerPayment({ customerId: "C1", amount: 10, destinationType: "cash" }, { idempotencyKey: "K" });
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty("allocations");
    // Empty strings collapse to null so the column stays clean.
    expect(body.reference).toBeNull();
    expect(body.notes).toBeNull();
  });

  it("posts NOTHING to approve/post — those capabilities are not the cashier's", async () => {
    const fetchFn = stubJson({ success: true, data: { id: "CR-3", status: "draft", version: 1 }, documentNumber: null, status: "draft", version: 1 });
    await createCustomerPayment({ customerId: "C1", amount: 10, destinationType: "cash" }, { idempotencyKey: "K" });
    const urls = fetchFn.mock.calls.map((c) => String((c as unknown as [string])[0]));
    expect(urls.some((u) => /\/(approve|post)$/.test(u))).toBe(false);
  });
});

describe("GET /returns — status + history", () => {
  it("asks for the newest page and maps the snake_case SELECT", async () => {
    const fetchFn = stubJson({
      success: true,
      data: [
        {
          id: "SR-1",
          return_number: "SRET-100",
          original_ar_document_id: "AR-9",
          customer_name: "شركة الأفق",
          return_date: "2026-07-26",
          total_amount: "46.00",
          status: "draft",
          credit_note_id: null,
          version: 1,
        },
      ],
      pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    });
    const rows = await listSalesReturns({ pageSize: 100 });
    const url = String((fetchFn.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain("/api/order-to-cash/returns?");
    expect(url).toContain("pageSize=100");
    expect(url).toContain("sort=returnDate");
    expect(url).toContain("dir=DESC");
    expect(rows).toEqual([
      {
        id: "SR-1",
        returnNumber: "SRET-100",
        customerName: "شركة الأفق",
        returnDate: "2026-07-26",
        totalAmount: 46,
        status: "draft",
        creditNoteId: null,
      },
    ]);
  });

  it("an envelope with no data array yields [] rather than throwing", async () => {
    stubJson({ success: true });
    expect(await listSalesReturns()).toEqual([]);
  });
});

describe("the local «returns I raised» ledger", () => {
  it("starts empty and records newest-first", () => {
    expect(listRaisedReturns()).toEqual([]);
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1", raisedAt: 100 });
    recordRaisedReturn({ id: "SR-2", documentNumber: "DRAFT-2", originalSaleId: "ORD-2", raisedAt: 200 });
    expect(listRaisedReturns().map((r) => r.id)).toEqual(["SR-2", "SR-1"]);
  });

  it("de-duplicates on id — a replayed idempotent create does not double the row", () => {
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1", raisedAt: 100 });
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1", raisedAt: 300 });
    expect(listRaisedReturns()).toHaveLength(1);
  });

  it("holds identity ONLY — no status is ever cached locally", () => {
    recordRaisedReturn({ id: "SR-1", documentNumber: "DRAFT-1", originalSaleId: "ORD-1" });
    expect(Object.keys(listRaisedReturns()[0]).sort()).toEqual(["documentNumber", "id", "originalSaleId", "raisedAt"]);
  });

  it("ignores an id-less write and survives corrupt storage", () => {
    recordRaisedReturn({ id: "", documentNumber: null, originalSaleId: "ORD-1" });
    expect(listRaisedReturns()).toEqual([]);
    localStorage.setItem("pos_o2c_raised_returns", "{not json");
    expect(listRaisedReturns()).toEqual([]);
  });

  it("caps the ledger so it can never grow without bound", () => {
    for (let i = 0; i < 60; i += 1) {
      recordRaisedReturn({ id: `SR-${i}`, documentNumber: null, originalSaleId: "O", raisedAt: i });
    }
    expect(listRaisedReturns()).toHaveLength(50);
    expect(listRaisedReturns()[0].id).toBe("SR-59");
  });
});
