/**
 * A previous cashier's queued ops must never be sent under the new cashier's
 * token — and must never be destroyed.
 *
 * WHY: a live incident on a shared till. The offline queue is DEVICE-scoped;
 * authorization is USER-scoped (routes/pos-v2.js refuses any order whose
 * `username` is not the caller's). After a cashier switch the drain replayed
 * the previous cashier's ops under the new token, the server answered
 * PERMISSION_DENIED — a PERMANENT domain failure — and the engine's permanent
 * branch deletes the op. For an `upsert` that loses a draft. For a queued
 * offline `submit-and-sale` it deletes a COMPLETED SALE that never reached the
 * server, and fail() even reverts the order to 'open': money gone from the
 * device with nothing recorded anywhere. All the cashier saw was two identical
 * red cards reading «هذا الطلب يخص كاشيرًا آخر».
 *
 * These pin the fix: withhold, don't attempt. And they pin the three ways it
 * must NOT over-apply — no identity, no stamp, or a supervisor — because each
 * of those, if quarantined, would strand real sales instead of saving them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAtomicRunner, memoryStore } from "../idb";
import { OfflineEngine, type ActorIdentity, type EngineApi, type EngineEvent } from "../offline";
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
    lines: [{ menuId: "M1", name: "شاي مغربي", qty: 1, unitPrice: 20, lineDiscount: 0, vatCategory: "S", notes: null }],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeHarness(actor: ActorIdentity | null) {
  const orders = memoryStore<LocalOrder>();
  const queue = memoryStore<QueueOp>();
  const events: EngineEvent[] = [];
  const sent: string[] = [];
  let current = actor;
  let idCounter = 0;

  const api = {
    upsertOrder: vi.fn(),
    transition: vi.fn(),
    submitOrder: vi.fn(async (id: string) => {
      sent.push(`submit:${id}`);
      return { success: true, data: { id, legacyPayload: { clientOrderId: id, totalFinal: 20 }, total: 20 }, status: "submitted", version: 2 };
    }),
    postLegacySale: vi.fn(async (p: { clientOrderId: string }) => {
      sent.push(`sale:${p.clientOrderId}`);
      return { success: true, orderId: "SALE-1", invoiceNumber: "INV-1" };
    }),
    completeOrder: vi.fn(async (id: string) => {
      sent.push(`complete:${id}`);
      return { success: true, idempotent: false, data: { id, saleId: "SALE-1" }, version: 3 };
    }),
    postSync: vi.fn(async (ops: Array<{ opId: string; type: string; orderId?: string }>) => {
      sent.push(`sync:${ops.map((o) => `${o.type}(${o.orderId})`).join(",")}`);
      return { success: true, results: ops.map((o) => ({ opId: o.opId, ok: true, result: { version: 2 } })) };
    }),
  };

  const engine = new OfflineEngine({
    orders,
    queue,
    atomic: memoryAtomicRunner({ orders, queue } as never),
    api: api as unknown as EngineApi,
    isOnline: () => true,
    now: () => 1_700_000_000_000,
    newId: () => `OP${String(++idCounter).padStart(6, "0")}`,
    debounceMs: 600,
    autoStart: false,
    currentActor: () => current,
  });
  engine.onEvent((e) => events.push(e));

  return {
    engine,
    orders,
    queue,
    events,
    sent,
    /** Sign a different person in on the SAME device — the whole scenario. */
    signIn: async (next: ActorIdentity | null) => {
      current = next;
      await engine.refreshActor();
    },
  };
}

const AMIN: ActorIdentity = { username: "amin", isSupervisor: false };
const SARA: ActorIdentity = { username: "sara", isSupervisor: false };
const MANAGER: ActorIdentity = { username: "hala", isSupervisor: true };

let h: ReturnType<typeof makeHarness>;
beforeEach(() => {
  h = makeHarness(AMIN);
});

describe("the queue records who authored each op", () => {
  it("stamps the signed-in cashier at enqueue time", async () => {
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    const [op] = await h.queue.getAll();
    expect(op.actor).toBe("amin");
  });

  it("leaves the stamp off when nobody is signed in, so nothing is quarantined later", async () => {
    const anon = makeHarness(null);
    await anon.orders.put("O1", makeDoc("O1"));
    await anon.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    const [op] = await anon.queue.getAll();
    expect(op.actor).toBeUndefined();
  });
});

describe("after a cashier switch", () => {
  it("sends nothing that belongs to the previous cashier", async () => {
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });

    await h.signIn(SARA);
    await h.engine.flush();

    expect(h.sent).toEqual([]);
    expect(await h.queue.getAll()).toHaveLength(1); // withheld, NOT dropped
  });

  it("keeps the previous cashier's offline SALE intact instead of deleting it", async () => {
    await h.orders.put("O1", makeDoc("O1", { status: "submitted" }));
    await h.engine.enqueue("submit-and-sale", "O1", { payments: [{ method: "cash", amount: 20 }] });

    await h.signIn(SARA);
    await h.engine.flush();

    // The money path: nothing sent, the op survives, the doc is NOT reverted to
    // 'open', and no "your sale failed" is reported for a sale that is simply
    // waiting for its author.
    expect(h.sent).toEqual([]);
    expect(await h.queue.getAll()).toHaveLength(1);
    expect((await h.orders.get("O1"))?.status).toBe("submitted");
    expect(h.events.filter((e) => e.type === "checkout-done")).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "toast" && e.kind === "error")).toHaveLength(0);
  });

  it("drains the very same queue once its author signs back in", async () => {
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });

    await h.signIn(SARA);
    await h.engine.flush();
    expect(h.sent).toEqual([]);

    await h.signIn(AMIN);
    await h.engine.flush();
    expect(h.sent).toEqual(["sync:upsert(O1)"]);
    expect(await h.queue.getAll()).toHaveLength(0);
  });

  it("lets a manager release them — the server accepts any cashier's order from a supervisor", async () => {
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });

    await h.signIn(MANAGER);
    await h.engine.flush();

    expect(h.sent).toEqual(["sync:upsert(O1)"]);
    expect(h.engine.getStatus().orphanCount).toBe(0);
  });

  it("still drains ops written by a build that had no actor field", async () => {
    // Rows already sitting in IndexedDB on live devices. Withholding these would
    // strand real sales on upgrade — the opposite of the fix's purpose.
    await h.orders.put("O1", makeDoc("O1"));
    await h.queue.put("LEGACY1", {
      opId: "LEGACY1",
      type: "upsert",
      orderId: "O1",
      payload: { id: "O1", lines: [] },
      ts: 1,
      seq: 1,
    });

    await h.signIn(SARA);
    await h.engine.flush();

    expect(h.sent).toEqual(["sync:upsert(O1)"]);
  });

  it("does not touch the new cashier's own ops queued alongside", async () => {
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });

    await h.signIn(SARA);
    await h.orders.put("O2", makeDoc("O2"));
    await h.engine.enqueue("upsert", "O2", { id: "O2", lines: [] });
    await h.engine.flush();

    expect(h.sent).toEqual(["sync:upsert(O2)"]); // hers goes, his stays
    const left = await h.queue.getAll();
    expect(left.map((o) => o.orderId)).toEqual(["O1"]);
  });
});

describe("what the till is told", () => {
  it("counts withheld ops separately so the pending badge can still reach zero", async () => {
    await h.orders.put("O1", makeDoc("O1", { status: "submitted" }));
    await h.engine.enqueue("submit-and-sale", "O1", { payments: [] });
    await h.orders.put("O2", makeDoc("O2"));
    await h.engine.enqueue("upsert", "O2", { id: "O2", lines: [] });

    await h.signIn(SARA);

    const s = h.engine.getStatus();
    // queueCount is "what I can drain" — otherwise the header reads «Online (2)»
    // forever and App's queue-empty gate never opens for the new cashier.
    expect(s.queueCount).toBe(0);
    expect(s.orphanCount).toBe(2);
    expect(s.orphanSaleCount).toBe(1); // the sale is called out on its own
    expect(s.orphanActors).toEqual(["amin"]);
  });

  it("reports nothing withheld in the ordinary case", async () => {
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    const s = h.engine.getStatus();
    expect(s.queueCount).toBe(1);
    expect(s.orphanCount).toBe(0);
    expect(s.orphanActors).toEqual([]);
  });
});
