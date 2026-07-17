/**
 * Parity — offline domain (docs/pos-parity-matrix.md):
 *   auth-save-restore-state — latestOpenOrder() restores the most recent open
 *                             cart after a refresh (store.tsx restore effect)
 *   offline-quota-guard / offline-quota-honest — a storage write failure
 *                             REJECTS (surfaces to the cashier) instead of
 *                             silently pretending the sale was saved
 *   offline-auto-sync       — the window 'online' event triggers a flush that
 *                             drains the queue (engine.start() wiring)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStore, type KVStore } from "../idb";
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
    lines: [{ menuId: "M1", name: "شاي مغربي", qty: 1, unitPrice: 23, lineDiscount: 0, vatCategory: "S", notes: null }],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeEngine(opts: {
  orders?: KVStore<LocalOrder>;
  queue?: KVStore<QueueOp>;
  online?: () => boolean;
  autoStart?: boolean;
  postSync?: ReturnType<typeof vi.fn>;
}) {
  const orders = opts.orders ?? memoryStore<LocalOrder>();
  const queue = opts.queue ?? memoryStore<QueueOp>();
  let idCounter = 0;
  const postSync =
    opts.postSync ??
    vi.fn(async (ops: Array<{ opId: string }>) => ({
      success: true,
      results: ops.map((o) => ({ opId: o.opId, ok: true, result: { version: 2 } })),
    }));
  const api = {
    upsertOrder: vi.fn(),
    transition: vi.fn(),
    submitOrder: vi.fn(),
    postLegacySale: vi.fn(),
    completeOrder: vi.fn(),
    postSync,
  };
  const engine = new OfflineEngine({
    orders,
    queue,
    api: api as unknown as EngineApi,
    isOnline: opts.online ?? (() => true),
    now: () => 1_700_000_000_000,
    newId: () => `OP${String(++idCounter).padStart(6, "0")}`,
    debounceMs: 5,
    autoStart: opts.autoStart ?? false,
  });
  return { engine, orders, queue, postSync };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth-save-restore-state — cart survives a refresh via latestOpenOrder", () => {
  it("returns the MOST RECENTLY updated open doc, ignoring held/completed docs", async () => {
    const { engine, orders } = makeEngine({});
    await orders.put("A", makeDoc("A", { updatedAt: 100 }));
    await orders.put("B", makeDoc("B", { updatedAt: 300 }));
    await orders.put("C", makeDoc("C", { updatedAt: 900, status: "held" }));
    await orders.put("D", makeDoc("D", { updatedAt: 950, status: "completed" }));
    const restored = await engine.latestOpenOrder();
    expect(restored?.id).toBe("B");
  });

  it("returns undefined on a fresh device (no doc to restore)", async () => {
    const { engine } = makeEngine({});
    expect(await engine.latestOpenOrder()).toBeUndefined();
  });
});

describe("offline-quota-guard — storage-full is surfaced, never a false success", () => {
  function quotaStore<T>(): KVStore<T> {
    return {
      get: async () => undefined,
      getAll: async () => [],
      put: async () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
      delete: async () => {},
    } as unknown as KVStore<T>;
  }

  it("saveCart REJECTS when the order store cannot be written", async () => {
    const { engine } = makeEngine({ orders: quotaStore<LocalOrder>() });
    await expect(engine.saveCart(makeDoc("Q1"))).rejects.toThrow(/Quota/);
  });

  it("checkout REJECTS when the doc write fails — the dialog shows the failure", async () => {
    const { engine } = makeEngine({ orders: quotaStore<LocalOrder>(), online: () => false });
    await expect(
      engine.checkout(makeDoc("Q2"), [{ method: "cash", amount: 23 }], { cashTendered: 23, changeDue: 0 }),
    ).rejects.toThrow(/Quota/);
  });
});

describe("offline-auto-sync — the 'online' event drains the queue", () => {
  it("flushes queued ops when connectivity returns", async () => {
    let online = false;
    const { engine, queue, postSync } = makeEngine({ online: () => online, autoStart: true });
    try {
      await engine.enqueue("upsert", "O1", { id: "O1", lines: [{ menuId: "M1", qty: 1, unitPrice: 23 }] });
      expect((await queue.getAll()).length).toBe(1);
      expect(postSync).not.toHaveBeenCalled();

      online = true;
      window.dispatchEvent(new Event("online"));

      await vi.waitFor(async () => {
        expect(postSync).toHaveBeenCalled();
        expect((await queue.getAll()).length).toBe(0);
      });
    } finally {
      engine.stop();
    }
  });
});
