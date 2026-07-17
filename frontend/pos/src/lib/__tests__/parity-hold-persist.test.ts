/**
 * Parity — السلة (cart): hold / resume + cart persistence on the REAL engine
 * (in-memory stores, no IndexedDB). Pins the matrix rows:
 *   held-parked-orders  — legacy had NO park/hold/recall at all; React holds an
 *                         order (status 'held', upsert precedes hold in the
 *                         queue) and resumes it back to 'open'.
 *   cart-state-not-persisted — legacy lost the cart on reload; React persists
 *                         every doc and latestOpenOrder() restores the most
 *                         recently updated open one after a refresh.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { memoryStore } from "../idb";
import { OfflineEngine, type EngineApi } from "../offline";
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

let orders: ReturnType<typeof memoryStore<LocalOrder>>;
let queue: ReturnType<typeof memoryStore<QueueOp>>;
let engine: OfflineEngine;

beforeEach(() => {
  orders = memoryStore<LocalOrder>();
  queue = memoryStore<QueueOp>();
  let idCounter = 0;
  engine = new OfflineEngine({
    orders,
    queue,
    // OFFLINE the whole time — holds and drafts must work with no server.
    api: {} as EngineApi,
    isOnline: () => false,
    now: () => 1_700_000_000_000,
    newId: () => `OP${String(++idCounter).padStart(6, "0")}`,
    debounceMs: 600,
    autoStart: false,
  });
});

describe("held-parked-orders — hold, list, resume (all offline)", () => {
  it("holdOrder marks the doc 'held' and queues the final upsert BEFORE the hold op", async () => {
    const doc = makeDoc("O1");
    await engine.holdOrder(doc);
    const stored = await orders.get("O1");
    expect(stored?.status).toBe("held");
    const ops = await engine.queuedOps();
    expect(ops.map((o) => o.type)).toEqual(["upsert", "hold"]);
    expect(ops.every((o) => o.orderId === "O1")).toBe(true);
  });

  it("localHeldOrders lists held docs — the offline source of the held board", async () => {
    await engine.holdOrder(makeDoc("O1"));
    await orders.put("O2", makeDoc("O2")); // still open — must not appear
    const held = await engine.localHeldOrders();
    expect(held.map((d) => d.id)).toEqual(["O1"]);
  });

  it("resumeLocalOrder brings a held doc back to 'open' and queues the resume", async () => {
    const doc = makeDoc("O1");
    await engine.holdOrder(doc);
    const held = (await orders.get("O1"))!;
    const open = await engine.resumeLocalOrder(held);
    expect(open.status).toBe("open");
    expect((await orders.get("O1"))?.status).toBe("open");
    const ops = await engine.queuedOps();
    expect(ops.map((o) => o.type)).toEqual(["upsert", "hold", "resume"]);
  });
});

describe("cart-state-not-persisted — React persists what legacy lost on reload", () => {
  it("saveCart lands the doc instantly (before any debounce/network)", async () => {
    await engine.saveCart(makeDoc("O1"));
    expect((await orders.get("O1"))?.id).toBe("O1");
  });

  it("latestOpenOrder returns the most recently UPDATED open doc — the refresh restore", async () => {
    await orders.put("OLD", makeDoc("OLD", { updatedAt: 1000 }));
    await orders.put("NEW", makeDoc("NEW", { updatedAt: 2000 }));
    await orders.put("HELD", makeDoc("HELD", { status: "held", updatedAt: 3000 }));
    const restored = await engine.latestOpenOrder();
    expect(restored?.id).toBe("NEW"); // newest OPEN doc; held/terminal docs excluded
  });
});
