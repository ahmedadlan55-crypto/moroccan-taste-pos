/**
 * Offline engine tests — in-memory KV stores (no IndexedDB) + a scripted api.
 * Covers: FIFO queue order (sync batches split around checkouts), trailing
 * upsert dedupe (new opId, old removed), debounced saveCart coalescing,
 * opId stability across network retries, and VERSION_CONFLICT → park-as-draft.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAtomicRunner, memoryStore } from "../idb";
import { OfflineEngine, type EngineApi, type EngineEvent } from "../offline";
import { ApiError } from "../api";
import type { LocalOrder, QueueOp } from "../types";

function makeDoc(id: string, overrides: Partial<LocalOrder> = {}): LocalOrder {
  return {
    id,
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
    lines: [{ menuId: "M1", name: "شاي مغربي", qty: 2, unitPrice: 23, lineDiscount: 0, vatCategory: "S", notes: null }],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

interface Harness {
  engine: OfflineEngine;
  orders: ReturnType<typeof memoryStore<LocalOrder>>;
  queue: ReturnType<typeof memoryStore<QueueOp>>;
  api: {
    upsertOrder: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
    submitOrder: ReturnType<typeof vi.fn>;
    postLegacySale: ReturnType<typeof vi.fn>;
    completeOrder: ReturnType<typeof vi.fn>;
    postSync: ReturnType<typeof vi.fn>;
  };
  callLog: string[];
  events: EngineEvent[];
  setOnline: (v: boolean) => void;
}

function makeHarness(): Harness {
  const orders = memoryStore<LocalOrder>();
  const queue = memoryStore<QueueOp>();
  const callLog: string[] = [];
  const events: EngineEvent[] = [];
  let online = true;
  let idCounter = 0;

  const api = {
    upsertOrder: vi.fn(),
    transition: vi.fn(async (id: string, action: string) => {
      callLog.push(`transition:${action}:${id}`);
      return { success: true, data: { id }, status: action, version: 99 };
    }),
    submitOrder: vi.fn(async (id: string, _body: unknown, idemKey: string) => {
      callLog.push(`submit:${id}:${idemKey}`);
      return {
        success: true,
        data: { id, legacyPayload: { clientOrderId: id, totalFinal: 46 }, total: 46 },
        status: "submitted",
        version: 5,
      };
    }),
    postLegacySale: vi.fn(async (payload: { clientOrderId: string }) => {
      callLog.push(`sale:${payload.clientOrderId}`);
      return { success: true, orderId: "SALE-1", invoiceNumber: "INV-20260703-0001" };
    }),
    completeOrder: vi.fn(async (id: string) => {
      callLog.push(`complete:${id}`);
      return { success: true, idempotent: false, data: { id, saleId: "SALE-1" }, version: 6 };
    }),
    postSync: vi.fn(async (ops: Array<{ opId: string; type: string; orderId?: string }>) => {
      callLog.push(`sync:${ops.map((o) => `${o.type}(${o.orderId})`).join(",")}`);
      return { success: true, results: ops.map((o) => ({ opId: o.opId, ok: true, result: { version: 2 } })) };
    }),
  };

  const engine = new OfflineEngine({
    orders,
    queue,
    atomic: memoryAtomicRunner({ orders, queue } as never),
    api: api as unknown as EngineApi,
    isOnline: () => online,
    now: () => 1_700_000_000_000,
    newId: () => `OP${String(++idCounter).padStart(6, "0")}`,
    debounceMs: 600,
    autoStart: false,
  });
  engine.onEvent((e) => events.push(e));

  return { engine, orders, queue, api, callLog, events, setOnline: (v) => (online = v) };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe("queue ordering", () => {
  it("flushes ops in FIFO order, splitting sync batches around checkout ops", async () => {
    h.setOnline(false);
    const docA = makeDoc("ORDERA");
    const docB = makeDoc("ORDERB");
    await h.orders.put(docA.id, docA);
    await h.orders.put(docB.id, docB);

    await h.engine.enqueue("upsert", "ORDERA", { id: "ORDERA", lines: [] });
    await h.engine.enqueue("hold", "ORDERA", {});
    const outcome = await h.engine.checkout(docB, [{ method: "cash", amount: 46 }], { cashTendered: 50, changeDue: 4 });
    expect(outcome.state).toBe("queued");
    await h.engine.enqueue("void", "ORDERA", { reason: "اختبار" });

    h.setOnline(true);
    await h.engine.flush();

    // Batch 1 (A ops + B's final upsert) → checkout B → batch 2 (void A).
    expect(h.callLog).toEqual([
      "sync:upsert(ORDERA),hold(ORDERA),upsert(ORDERB)",
      expect.stringMatching(/^submit:ORDERB:OP/),
      "sale:ORDERB",
      "complete:ORDERB",
      "sync:void(ORDERA)",
    ]);
    expect(await h.queue.getAll()).toHaveLength(0);

    const docBAfter = await h.orders.get("ORDERB");
    expect(docBAfter?.status).toBe("completed");
    expect(docBAfter?.invoiceNumber).toBe("INV-20260703-0001");
    expect(docBAfter?.saleId).toBe("SALE-1");
  });

  it("uses the checkout opId as the submit Idempotency-Key", async () => {
    h.setOnline(false);
    const doc = makeDoc("ORDERC");
    await h.orders.put(doc.id, doc);
    await h.engine.checkout(doc, [{ method: "cash", amount: 46 }], {});
    const ops = await h.engine.queuedOps();
    const checkoutOp = ops.find((o) => o.type === "submit-and-sale")!;
    h.setOnline(true);
    await h.engine.flush();
    expect(h.api.submitOrder).toHaveBeenCalledWith("ORDERC", expect.anything(), checkoutOp.opId);
  });
});

describe("dedupe by opId", () => {
  it("replaces the trailing upsert for the same order under a NEW opId", async () => {
    await h.engine.enqueue("upsert", "ORDERA", { id: "ORDERA", v: 1 }, { replaceTrailingUpsert: true });
    const first = (await h.engine.queuedOps())[0];
    await h.engine.enqueue("upsert", "ORDERA", { id: "ORDERA", v: 2 }, { replaceTrailingUpsert: true });
    const ops = await h.engine.queuedOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].opId).not.toBe(first.opId); // payload changed → fresh opId
    expect(ops[0].payload).toEqual({ id: "ORDERA", v: 2 });
  });

  it("does NOT replace an upsert that is no longer the trailing op (order preserved)", async () => {
    await h.engine.enqueue("upsert", "ORDERA", { v: 1 }, { replaceTrailingUpsert: true });
    await h.engine.enqueue("hold", "ORDERA", {});
    await h.engine.enqueue("upsert", "ORDERA", { v: 2 }, { replaceTrailingUpsert: true });
    const ops = await h.engine.queuedOps();
    expect(ops.map((o) => o.type)).toEqual(["upsert", "hold", "upsert"]);
  });

  it("debounced saveCart coalesces rapid edits into ONE queued upsert", async () => {
    vi.useFakeTimers();
    try {
      h.setOnline(false);
      const doc = makeDoc("ORDERD");
      await h.engine.saveCart(doc);
      await h.engine.saveCart({ ...doc, lines: [{ ...doc.lines[0], qty: 3 }] });
      await h.engine.saveCart({ ...doc, lines: [{ ...doc.lines[0], qty: 4 }] });
      await vi.advanceTimersByTimeAsync(700);
      const ops = await h.engine.queuedOps();
      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe("upsert");
      const lines = (ops[0].payload as { lines: Array<{ qty: number }> }).lines;
      expect(lines[0].qty).toBe(4); // latest snapshot wins
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the SAME opId across a network-failure retry (server-side idempotency)", async () => {
    await h.engine.enqueue("upsert", "ORDERA", { id: "ORDERA" });
    h.api.postSync.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await h.engine.flush();
    expect(await h.engine.queuedOps()).toHaveLength(1); // kept, not dropped

    await h.engine.flush();
    expect(h.api.postSync).toHaveBeenCalledTimes(2);
    const firstIds = (h.api.postSync.mock.calls[0][0] as Array<{ opId: string }>).map((o) => o.opId);
    const secondIds = (h.api.postSync.mock.calls[1][0] as Array<{ opId: string }>).map((o) => o.opId);
    expect(secondIds).toEqual(firstIds);
    expect(await h.engine.queuedOps()).toHaveLength(0);
  });

  it("treats replayed results (ok+replay) as success and clears the op", async () => {
    await h.engine.enqueue("hold", "ORDERA", {});
    h.api.postSync.mockResolvedValueOnce({
      success: true,
      results: [{ opId: (await h.engine.queuedOps())[0].opId, ok: true, replay: true, result: { version: 7 } }],
    });
    await h.engine.flush();
    expect(await h.engine.queuedOps()).toHaveLength(0);
    expect(h.engine.getStatus().lastReport?.results[0].replay).toBe(true);
  });
});

describe("VERSION_CONFLICT → park as new draft", () => {
  it("keeps the server copy, duplicates the local doc as a fresh draft with the conflict note", async () => {
    const doc = makeDoc("ORDERX", { serverVersion: 3, note: "بدون سكر" });
    await h.orders.put(doc.id, doc);
    await h.engine.enqueue("upsert", "ORDERX", { id: "ORDERX" });
    h.api.postSync.mockResolvedValueOnce({
      success: true,
      results: [{ opId: (await h.engine.queuedOps())[0].opId, ok: false, code: "VERSION_CONFLICT", error: "conflict" }],
    });

    await h.engine.flush();

    expect(await h.orders.get("ORDERX")).toBeUndefined(); // server copy wins
    const all = await h.orders.getAll();
    expect(all).toHaveLength(1);
    const draft = all[0];
    expect(draft.id).not.toBe("ORDERX");
    expect(draft.status).toBe("open");
    expect(draft.serverVersion).toBeNull();
    expect(draft.note).toContain("نسخة محلية متعارضة");
    expect(draft.note).toContain("بدون سكر");
    expect(draft.lines).toEqual(doc.lines);

    const conflictEvent = h.events.find((e) => e.type === "conflict");
    expect(conflictEvent).toBeTruthy();
    expect(await h.engine.queuedOps()).toHaveLength(0);
  });

  it("drops later queued ops for the conflicted order", async () => {
    const doc = makeDoc("ORDERY", { serverVersion: 2 });
    await h.orders.put(doc.id, doc);
    await h.engine.enqueue("upsert", "ORDERY", { id: "ORDERY" });
    await h.engine.enqueue("hold", "ORDERY", {});
    h.api.postSync.mockResolvedValueOnce({
      success: true,
      results: [
        { opId: (await h.engine.queuedOps())[0].opId, ok: false, code: "VERSION_CONFLICT", error: "conflict" },
        { opId: (await h.engine.queuedOps())[1].opId, ok: false, code: "VERSION_CONFLICT", error: "conflict" },
      ],
    });
    await h.engine.flush();
    expect(await h.engine.queuedOps()).toHaveLength(0);
  });
});

describe("checkout failure path", () => {
  it("reopens the order and surfaces the error when the legacy sale is rejected", async () => {
    h.setOnline(true);
    const doc = makeDoc("ORDERZ");
    await h.orders.put(doc.id, doc);
    h.api.postLegacySale.mockRejectedValueOnce(new ApiError(422, "VALIDATION_ERROR", "وردية مغلقة"));

    const outcome = await h.engine.checkout(doc, [{ method: "cash", amount: 46 }], {});

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("وردية");
    expect(h.api.transition).toHaveBeenCalledWith("ORDERZ", "reopen", {});
    const after = await h.orders.get("ORDERZ");
    expect(after?.status).toBe("open"); // editable again
    expect(await h.engine.queuedOps()).toHaveLength(0); // op dropped, not jammed
  });

  it("keeps the checkout op queued when the network dies mid-chain", async () => {
    h.setOnline(true);
    const doc = makeDoc("ORDERW");
    await h.orders.put(doc.id, doc);
    h.api.postLegacySale.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const outcome = await h.engine.checkout(doc, [{ method: "cash", amount: 46 }], {});

    expect(outcome.state).toBe("queued"); // safe replay later
    const ops = await h.engine.queuedOps();
    expect(ops.some((o) => o.type === "submit-and-sale")).toBe(true);
  });
});

describe("void semantics", () => {
  it("purely-local drafts evaporate without queueing anything", async () => {
    const doc = makeDoc("LOCALONLY");
    await h.orders.put(doc.id, doc);
    await h.engine.voidOrder(doc, "خطأ إدخال");
    expect(await h.orders.get("LOCALONLY")).toBeUndefined();
    expect(await h.engine.queuedOps()).toHaveLength(0);
  });

  it("synced orders enqueue a void op with the reason", async () => {
    h.setOnline(false);
    const doc = makeDoc("SYNCED", { serverVersion: 4 });
    await h.orders.put(doc.id, doc);
    await h.engine.voidOrder(doc, "طلب العميل");
    const ops = await h.engine.queuedOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("void");
    expect(ops[0].payload).toEqual({ reason: "طلب العميل" });
    expect((await h.orders.get("SYNCED"))?.status).toBe("voided");
  });
});

// ── Fix B — no more raw "HTTP 200" toast on a partial sync-batch failure ────
// Root cause: POST /api/pos/v2/sync always answers HTTP 200 with
// {success: results.every(r=>r.ok), results} — a legitimate partial-failure
// report, no top-level error/message. api.ts's postSync() now opts OUT of
// the generic success:false hard-throw (allowPartialSuccess; see
// lib/__tests__/api.test.ts for that half), so — exactly like the REAL
// api.postSync() would now behave — the mock below resolves (never rejects)
// with a mixed-outcome batch, and runSyncBatch must read results[] itself.
function errorToasts(events: EngineEvent[]): Array<Extract<EngineEvent, { type: "toast" }>> {
  return events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast" && e.kind === "error");
}

describe("Fix B — partial sync-batch failure toasts a real message, never a raw HTTP-status string", () => {
  it("a failing op in an otherwise-200 batch surfaces ITS OWN error, never the literal HTTP-status fallback", async () => {
    await h.engine.enqueue("hold", "ORDERA", {});
    const opId = (await h.engine.queuedOps())[0].opId;
    h.api.postSync.mockResolvedValueOnce({
      success: false, // the batch-level flag the OLD code used to hard-throw on
      results: [{ opId, ok: false, code: "VALIDATION_ERROR", error: "لا يمكن تعليق طلب فارغ" }],
    });

    await h.engine.flush();

    const toasts = errorToasts(h.events);
    expect(toasts.length).toBeGreaterThan(0);
    for (const toast of toasts) {
      expect(toast.message).not.toMatch(/^HTTP \d+$/); // the exact bug this fix kills
    }
    expect(toasts.some((t) => t.message === "لا يمكن تعليق طلب فارغ")).toBe(true);
    // Permanent domain failure — dropped so the queue never jams.
    expect(await h.engine.queuedOps()).toHaveLength(0);
  });

  it("setTranslator(t) resolves a KNOWN error code to the localized string instead of the server's raw per-op message", async () => {
    const fakeT = (path: string) => (path === "errors.O2C_MODULE_ACTIVE" ? "هذه الميزة معطلة مؤقتًا" : path);
    h.engine.setTranslator(fakeT);

    await h.engine.enqueue("hold", "ORDERB", {});
    const opId = (await h.engine.queuedOps())[0].opId;
    h.api.postSync.mockResolvedValueOnce({
      success: false,
      results: [{ opId, ok: false, code: "O2C_MODULE_ACTIVE", error: "some raw technical string" }],
    });

    await h.engine.flush();

    const toasts = errorToasts(h.events);
    expect(toasts.some((t) => t.message === "هذه الميزة معطلة مؤقتًا")).toBe(true);
    expect(toasts.some((t) => t.message === "some raw technical string")).toBe(false);
  });

  it("checkout: a domain failure at the 'complete' step (sale already booked) keeps its translated-message prefix, never a raw .message", async () => {
    h.setOnline(true);
    const doc = makeDoc("ORDERCOMPLETEFAIL");
    await h.orders.put(doc.id, doc);
    h.api.completeOrder.mockRejectedValueOnce(new ApiError(409, "SOME_UNMAPPED_CODE", "فشل تسجيل الإتمام"));

    await h.engine.checkout(doc, [{ method: "cash", amount: 46 }], {});

    const toasts = errorToasts(h.events);
    expect(toasts.some((t) => t.message === "تم تسجيل البيع لكن تعذّر إكمال الطلب: فشل تسجيل الإتمام")).toBe(true);
    for (const toast of toasts) expect(toast.message).not.toMatch(/HTTP \d+/);
  });
});
