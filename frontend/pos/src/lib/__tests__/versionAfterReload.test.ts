/**
 * A page reload must not make every SECOND cart edit conflict — nor charge the
 * customer the pre-reload total.
 *
 * THE LIVE INCIDENT. The owner's till showed «تعارض نسخ — اعتُمدت نسخة الخادم
 * وحُفظت تعديلاتك كمسودة جديدة» on one device, one shift, no concurrency. His
 * tablet had auto-reloaded across three deploys that day (App.tsx reloads an
 * idle till when a new build lands), and the register reloads itself far more
 * often than anyone thinks.
 *
 * The mechanism, end to end:
 *   • store.tsx:743 restores the cart with `setCart(doc)` — serverVersion and
 *     all — so React state now holds a version number.
 *   • mergeServerVersion USED to early-out on any non-null serverVersion,
 *     justified by a comment claiming "React state snapshots never carry it".
 *     That premise was false, and this file is the proof.
 *   • The drain advances the STORED version on ack (offline.ts). React is never
 *     told; there is no engine→React channel for it.
 *   • So the second saveCart writes React's stale N back over the stored N+1,
 *     the cursor is seeded from N, expectedVersion N goes on the wire, and
 *     routes/pos-v2.js's `WHERE ... AND version=?` matches nothing.
 *
 * THE HARNESS MATTERS. memoryStore hands back the SAME object reference it was
 * given, so the engine's own ack mutation is visible through React's copy and
 * the bug silently disappears — which is why an entire green suite never saw
 * it. IndexedDB returns a structured clone every read. This file uses a cloning
 * store so the test rig matches the real storage semantics.
 */
import { describe, expect, it, vi } from "vitest";
import { memoryAtomicRunner } from "../idb";
import type { KVStore } from "../idb";
import { OfflineEngine, type EngineApi, type EngineEvent } from "../offline";
import type { LocalOrder, QueueOp } from "../types";

/** What IndexedDB actually does: every read is a fresh copy. */
function cloningStore<T>(): KVStore<T> {
  const m = new Map<string, T>();
  return {
    get: async (k: string) => (m.has(k) ? (structuredClone(m.get(k) as T) as T) : undefined),
    put: async (k: string, v: T) => {
      m.set(k, structuredClone(v));
    },
    delete: async (k: string) => {
      m.delete(k);
    },
    getAll: async () => [...m.values()].map((v) => structuredClone(v)),
  } as KVStore<T>;
}

function makeDoc(id: string, qty: number): LocalOrder {
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
    lines: [{ menuId: "M1", name: "شاي", qty, unitPrice: 25, lineDiscount: 0, vatCategory: "S", taxInclusive: true, notes: null }],
    serverVersion: null,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

/**
 * A server that enforces the real optimistic-concurrency rule:
 * routes/pos-v2.js UPDATE ... WHERE id=? AND status='open' AND version=?
 */
function makeHarness() {
  const orders = cloningStore<LocalOrder>();
  const queue = cloningStore<QueueOp>();
  const events: EngineEvent[] = [];
  const wire: Array<{ orderId: string; expectedVersion: number | null }> = [];
  const server = new Map<string, number>(); // orderId → version
  let idCounter = 0;

  const api = {
    upsertOrder: vi.fn(),
    transition: vi.fn(),
    submitOrder: vi.fn(async (id: string) => {
      const v = (server.get(id) ?? 0) + 1;
      server.set(id, v);
      return { success: true, data: { id, legacyPayload: { clientOrderId: id, totalFinal: 0 }, total: 0 }, status: "submitted", version: v };
    }),
    postLegacySale: vi.fn(async () => ({ success: true, orderId: "SALE-1", invoiceNumber: "INV-1" })),
    completeOrder: vi.fn(async (id: string) => ({ success: true, idempotent: false, data: { id, saleId: "SALE-1" }, version: (server.get(id) ?? 0) + 1 })),
    postSync: vi.fn(async (ops: Array<{ opId: string; type: string; orderId: string; payload: Record<string, unknown> }>) => ({
      success: true,
      results: ops.map((o) => {
        const expected = (o.payload.expectedVersion as number | undefined) ?? null;
        wire.push({ orderId: o.orderId, expectedVersion: expected });
        const current = server.get(o.orderId);
        if (current == null) {
          server.set(o.orderId, 1);
          return { opId: o.opId, ok: true, result: { version: 1 } };
        }
        if (expected !== current) {
          return { opId: o.opId, ok: false, code: "VERSION_CONFLICT", error: "version mismatch" };
        }
        server.set(o.orderId, current + 1);
        return { opId: o.opId, ok: true, result: { version: current + 1 } };
      }),
    })),
  };

  const engine = new OfflineEngine({
    orders,
    queue,
    atomic: memoryAtomicRunner({ orders, queue } as never),
    api: api as unknown as EngineApi,
    isOnline: () => true,
    now: () => 1_700_000_000_000,
    newId: () => `OP${String(++idCounter).padStart(6, "0")}`,
    debounceMs: 0, // saveCart's debounce is not what is under test
    autoStart: false,
    currentActor: () => ({ username: "cashier1", isSupervisor: false }),
  });
  engine.onEvent((e) => events.push(e));
  return { engine, orders, queue, events, wire, server, api };
}

/** saveCart + let the 0ms debounce fire + drain. */
async function saveAndSync(h: ReturnType<typeof makeHarness>, doc: LocalOrder) {
  await h.engine.saveCart(doc);
  await new Promise((r) => setTimeout(r, 5));
  await h.engine.flush();
}

describe("editing a cart that was restored after a reload", () => {
  it("advances expectedVersion instead of replaying the pre-reload one", async () => {
    const h = makeHarness();
    await saveAndSync(h, makeDoc("ORD1", 1));
    expect(h.server.get("ORD1")).toBe(1);

    // EXACTLY what store.tsx:740-744 does on boot: read the doc and put it into
    // React state, serverVersion included.
    const reactCart = (await h.engine.latestOpenOrder()) as LocalOrder;
    expect(reactCart.serverVersion).toBe(1);

    // Two edits, spread-style, the way store.tsx's mutate() builds them.
    await saveAndSync(h, { ...reactCart, lines: [{ ...reactCart.lines[0], qty: 2 }] });
    await saveAndSync(h, { ...reactCart, lines: [{ ...reactCart.lines[0], qty: 3 }] });

    // Before the fix the second upsert repeated expectedVersion 1 and the
    // server refused it. The stored version is the authority now.
    expect(h.wire.map((w) => w.expectedVersion)).toEqual([null, 1, 2]);
    expect(h.events.filter((e) => e.type === "conflict")).toHaveLength(0);
    expect((await h.orders.get("ORD1"))?.serverVersion).toBe(3);
  });

  it("does not park the cashier's cart as a conflicted draft", async () => {
    const h = makeHarness();
    await saveAndSync(h, makeDoc("ORD2", 1));
    const reactCart = (await h.engine.latestOpenOrder()) as LocalOrder;

    await saveAndSync(h, { ...reactCart, lines: [{ ...reactCart.lines[0], qty: 2 }] });
    await saveAndSync(h, { ...reactCart, lines: [{ ...reactCart.lines[0], qty: 4 }] });

    const docs = await h.orders.getAll();
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("ORD2");
    expect(docs[0].note).toBeNull(); // never «نسخة محلية متعارضة»
  });

  it("charges the cart that is on screen, not the pre-reload one", async () => {
    // The money tail of the same bug: checkout submits the snapshot, and a
    // stale expectedVersion made the submit fail after the cashier had already
    // added lines — the total on screen and the total charged diverged.
    const h = makeHarness();
    await saveAndSync(h, makeDoc("ORD3", 1));
    const reactCart = (await h.engine.latestOpenOrder()) as LocalOrder;

    await saveAndSync(h, { ...reactCart, lines: [{ ...reactCart.lines[0], qty: 2 }] });

    const finalCart: LocalOrder = { ...reactCart, lines: [{ ...reactCart.lines[0], qty: 3 }] };
    const outcome = await h.engine.checkout(finalCart, [{ method: "cash", amount: 75 }], {});

    expect(outcome.state).toBe("completed");
    expect((await h.orders.get("ORD3"))?.lines[0].qty).toBe(3);
  });
});
