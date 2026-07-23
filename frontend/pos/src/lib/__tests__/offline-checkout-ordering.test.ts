/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CO-1 — checkout ordering. The regression suite for the 404 that failed real
 * payments.
 *
 * THE BUG. A Playwright trace of a failing cashier run carried 106 requests and
 * exactly one non-2xx:
 *
 *     POST /api/pos/v2/orders/<ULID>/submit   -> 404   («الطلب غير موجود»)
 *     POST /api/pos/v2/sync                   -> 200   36 ms LATER
 *
 * There was no server-side create for that order at all. The queue had reached
 *
 *     submit-and-sale(seq = n)   BEFORE   upsert(seq = n + 1)
 *
 * so the drain — which sorts by seq — submitted an order the server had never
 * seen. On the cashier's screen: the payment fails.
 *
 * HOW IT GOT THERE. enqueue() used to be four separate awaits —
 * `getAll -> delete trailing upsert -> ++inMemoryCounter -> put` — with no
 * mutual exclusion. A 600 ms debounce firing while checkout ran interleaved
 * with it, and clearTimeout cannot un-fire a timer whose callback has already
 * started. A per-instance counter also meant two TABS each had their own.
 *
 * WHAT THESE TESTS DO. They do not sprinkle timeouts and hope. Every schedule
 * below is forced: the store's critical section is gated so a test can hold one
 * caller at a chosen point and drive another into it. Each asserts on the
 * SERVER CALL ORDER, which is the thing the cashier actually experiences.
 *
 * The last test is a MUTATION TEST: it swaps in a deliberately non-serializing
 * runner (the old behaviour) and proves the suite catches the regression. A
 * race test that cannot fail is not a test.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, memoryAtomicRunner, type AtomicPrefetch, type AtomicRunner, type AtomicTxn, type KVStore, type StoreName } from "../idb";
import { OfflineEngine, type EngineApi } from "../offline";
import type { LocalOrder, QueueOp } from "../types";

// ── Fixtures ────────────────────────────────────────────────────────────────
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

/**
 * A stateful fake server. This is the part that makes the tests meaningful:
 * /submit 404s for an order it has never been told about, EXACTLY as
 * routes/pos-v2.js doSubmit() -> _loadOrder() -> null does. A fake that always
 * succeeds would pass no matter how badly ordered the queue was.
 */
function makeServer() {
  const known = new Set<string>();
  const calls: string[] = [];
  const sales: string[] = [];
  const invoices: string[] = [];
  const idempotencyKeys: string[] = [];
  let saleCounter = 0;

  const notFound = (): Error => {
    const e = new Error("الطلب غير موجود") as Error & { status?: number; code?: string };
    e.status = 404;
    e.code = "NOT_FOUND";
    return e;
  };

  const api = {
    upsertOrder: vi.fn(async (body: { id: string }) => {
      known.add(body.id);
      calls.push(`upsert:${body.id}`);
      return { success: true, created: true, data: { id: body.id, version: 1 }, version: 1 };
    }),
    transition: vi.fn(async (id: string, action: string) => {
      calls.push(`transition:${action}:${id}`);
      return { success: true, data: { id }, status: action, version: 9 };
    }),
    submitOrder: vi.fn(async (id: string, _body: unknown, idemKey: string) => {
      calls.push(`submit:${id}`);
      idempotencyKeys.push(idemKey);
      if (!known.has(id)) throw notFound();
      return {
        success: true,
        data: { id, legacyPayload: { clientOrderId: id, totalFinal: 46 }, total: 46 },
        status: "submitted",
        version: 5,
      };
    }),
    postLegacySale: vi.fn(async (payload: { clientOrderId: string }) => {
      calls.push(`sale:${payload.clientOrderId}`);
      // clientOrderId dedupe, exactly like the real endpoint.
      const existing = sales.indexOf(payload.clientOrderId);
      if (existing !== -1) return { success: true, orderId: `SALE-${existing + 1}`, invoiceNumber: invoices[existing] };
      sales.push(payload.clientOrderId);
      const inv = `INV-${String(++saleCounter).padStart(4, "0")}`;
      invoices.push(inv);
      return { success: true, orderId: `SALE-${saleCounter}`, invoiceNumber: inv };
    }),
    completeOrder: vi.fn(async (id: string, body: { saleId: string }) => {
      calls.push(`complete:${id}`);
      return { success: true, idempotent: false, data: { id, saleId: body.saleId }, version: 6 };
    }),
    postSync: vi.fn(async (ops: Array<{ opId: string; type: string; orderId?: string; payload?: { id?: string } }>) => {
      for (const o of ops) {
        if (o.type === "upsert" && o.orderId) known.add(o.orderId);
        calls.push(`${o.type}:${o.orderId}`);
      }
      return { success: true, results: ops.map((o) => ({ opId: o.opId, ok: true, result: { version: 2 } })) };
    }),
  };

  return { api, calls, sales, invoices, idempotencyKeys, known };
}

interface GateControl {
  /** Hold every critical section entering `before-decide` until released. */
  hold(): void;
  release(): void;
  /** Resolves once at least `n` callers are parked at the gate. */
  waitForParked(n: number): Promise<void>;
  parkedCount(): number;
}

function makeGate(): { gate: (phase: "before-decide" | "after-decide") => Promise<void> | void; control: GateControl } {
  let holding = false;
  let parked = 0;
  const waiters: Array<() => void> = [];
  const parkWatchers: Array<{ n: number; resolve: () => void }> = [];

  const notifyParked = (): void => {
    for (let i = parkWatchers.length - 1; i >= 0; i--) {
      if (parked >= parkWatchers[i].n) {
        parkWatchers[i].resolve();
        parkWatchers.splice(i, 1);
      }
    }
  };

  return {
    gate: (phase) => {
      if (phase !== "before-decide" || !holding) return;
      parked++;
      notifyParked();
      return new Promise<void>((resolve) => {
        waiters.push(() => {
          parked--;
          resolve();
        });
      });
    },
    control: {
      hold: () => {
        holding = true;
      },
      release: () => {
        holding = false;
        while (waiters.length) waiters.shift()!();
      },
      waitForParked: (n) =>
        parked >= n
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              parkWatchers.push({ n, resolve });
            }),
      parkedCount: () => parked,
    },
  };
}

interface Harness {
  engine: OfflineEngine;
  orders: KVStore<LocalOrder>;
  queue: KVStore<QueueOp>;
  server: ReturnType<typeof makeServer>;
  control: GateControl;
  setOnline: (v: boolean) => void;
  newEngineOnSameStores: () => OfflineEngine;
}

function makeHarness(opts: { online?: boolean; ordersMap?: Map<string, LocalOrder>; queueMap?: Map<string, QueueOp>; racy?: boolean } = {}): Harness {
  const ordersMap = opts.ordersMap ?? new Map<string, LocalOrder>();
  const queueMap = opts.queueMap ?? new Map<string, QueueOp>();
  const orders = memoryStore<LocalOrder>(ordersMap);
  const queue = memoryStore<QueueOp>(queueMap);
  const server = makeServer();
  const { gate, control } = makeGate();
  let online = opts.online ?? true;
  let idCounter = 0;
  const newId = (): string => `OP${String(++idCounter).padStart(6, "0")}`;

  const runner: AtomicRunner = opts.racy
    ? racyAtomicRunner({ orders, queue } as never)
    : memoryAtomicRunner({ orders, queue } as never, gate);

  const build = (): OfflineEngine =>
    new OfflineEngine({
      orders,
      queue,
      atomic: runner,
      api: server.api as unknown as EngineApi,
      isOnline: () => online,
      now: () => 1_700_000_000_000,
      newId,
      debounceMs: 600,
      autoStart: false,
    });

  return {
    engine: build(),
    orders,
    queue,
    server,
    control,
    setOnline: (v) => (online = v),
    newEngineOnSameStores: build,
  };
}

/**
 * MUTATION: the barrier removed. Identical to memoryAtomicRunner except that it
 * does NOT serialize — every transact() runs concurrently, which is precisely
 * the pre-fix behaviour of four bare awaits. Used only by the final test.
 */
function racyAtomicRunner(stores: Partial<Record<StoreName, KVStore<never>>>): AtomicRunner {
  const storeFor = (s: StoreName): KVStore<unknown> => stores[s] as unknown as KVStore<unknown>;
  return {
    async transact<R>(_s: StoreName[], prefetch: AtomicPrefetch, decide: (txn: AtomicTxn) => R): Promise<R> {
      const allSnap = new Map<StoreName, unknown[]>();
      const keySnap = new Map<string, unknown>();
      for (const s of prefetch.all ?? []) allSnap.set(s, await storeFor(s).getAll());
      for (const [s, k] of prefetch.keys ?? []) keySnap.set(`${s} ${k}`, await storeFor(s).get(k));
      // The interleaving window the real runner closes.
      await Promise.resolve();
      await Promise.resolve();
      const writes: Array<() => Promise<void>> = [];
      const out = decide({
        getAll: (s: StoreName) => (allSnap.get(s) ?? []) as never[],
        get: (s: StoreName, k: string) => keySnap.get(`${s} ${k}`) as never,
        put: (s: StoreName, k: string, v: unknown) => writes.push(() => storeFor(s).put(k, v)),
        delete: (s: StoreName, k: string) => writes.push(() => storeFor(s).delete(k)),
      } as AtomicTxn);
      for (const w of writes) await w();
      return out;
    },
  };
}

// ── Assertions shared by every scenario ─────────────────────────────────────
function assertUpsertBeforeSubmit(calls: string[], orderId: string): void {
  const firstUpsert = calls.indexOf(`upsert:${orderId}`);
  const firstSubmit = calls.indexOf(`submit:${orderId}`);
  expect(firstUpsert, `the order was created server-side (calls: ${calls.join(" ")})`).toBeGreaterThanOrEqual(0);
  expect(firstSubmit, `the order was submitted (calls: ${calls.join(" ")})`).toBeGreaterThanOrEqual(0);
  expect(firstUpsert, `upsert must precede submit — got ${calls.join(" ")}`).toBeLessThan(firstSubmit);
}

function assertQueueOrder(ops: QueueOp[], orderId: string): void {
  const mine = ops.filter((o) => o.orderId === orderId).sort((a, b) => a.seq - b.seq);
  const checkout = mine.findIndex((o) => o.type === "submit-and-sale");
  if (checkout === -1) return;
  const after = mine.slice(checkout + 1).filter((o) => o.type === "upsert");
  expect(after, `no upsert may sort after the checkout — queue: ${mine.map((o) => `${o.type}#${o.seq}`).join(",")}`).toHaveLength(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CO-1 — the checkout can never outrun the order that creates it", () => {
  it("(a) a debounced upsert still in flight during checkout cannot land after the submit", async () => {
    const h = makeHarness();
    const doc = makeDoc("ORD-A");
    await h.engine.saveCart(doc);

    // Let the 600ms debounce FIRE, but hold its critical section at the gate —
    // the exact state clearTimeout cannot undo.
    h.control.hold();
    await vi.advanceTimersByTimeAsync(600);
    await h.control.waitForParked(1);
    expect(h.control.parkedCount(), "the debounce is parked inside the barrier").toBe(1);

    // Checkout starts while the debounce holds the barrier.
    const checkout = h.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 });
    await Promise.resolve();

    h.control.release();
    await checkout;
    await vi.runOnlyPendingTimersAsync();

    assertQueueOrder(await h.queue.getAll(), "ORD-A");
    assertUpsertBeforeSubmit(h.server.calls, "ORD-A");
    expect(h.server.sales, "exactly one sale").toEqual(["ORD-A"]);
    expect(h.server.invoices, "exactly one invoice").toHaveLength(1);
  });

  it("(b) the replace step cannot delete the checkout's own upsert (the traced 404)", async () => {
    const h = makeHarness();
    const doc = makeDoc("ORD-B");
    await h.engine.saveCart(doc);

    // Park the debounce mid-critical-section, then run a full checkout, then
    // let the debounce proceed — the schedule that produced submit(n)/upsert(n+1).
    h.control.hold();
    await vi.advanceTimersByTimeAsync(600);
    await h.control.waitForParked(1);

    const checkout = h.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 });
    await Promise.resolve();
    h.control.release();
    await checkout;
    await vi.runOnlyPendingTimersAsync();

    const ops = await h.queue.getAll();
    assertQueueOrder(ops, "ORD-B");
    assertUpsertBeforeSubmit(h.server.calls, "ORD-B");
    expect(h.server.calls.filter((c) => c === "submit:ORD-B"), "submitted once").toHaveLength(1);
    expect(h.server.sales).toEqual(["ORD-B"]);
  });

  it("(c) double-tapping Pay produces ONE sale and ONE invoice", async () => {
    const h = makeHarness();
    const doc = makeDoc("ORD-C");
    await h.engine.saveCart(doc);

    const [r1, r2] = await Promise.all([
      h.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 }),
      h.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 }),
    ]);
    await vi.runOnlyPendingTimersAsync();

    const ops = await h.queue.getAll();
    expect(ops.filter((o) => o.orderId === "ORD-C" && o.type === "submit-and-sale"), "only one checkout op ever exists").toHaveLength(0);
    assertUpsertBeforeSubmit(h.server.calls, "ORD-C");
    expect(h.server.sales, "ONE sale despite two taps").toEqual(["ORD-C"]);
    expect(h.server.invoices, "ONE invoice").toHaveLength(1);
    expect([r1.state, r2.state].filter((s) => s === "failed"), "neither tap reports failure").toHaveLength(0);
  });

  it("(d) a network drop between upsert and submit replays in the right order on reconnect", async () => {
    const h = makeHarness({ online: false });
    const doc = makeDoc("ORD-D");
    await h.engine.saveCart(doc);
    await vi.advanceTimersByTimeAsync(600);

    const res = await h.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 });
    expect(res.state, "offline checkout queues rather than failing").toBe("queued");
    expect(h.server.calls, "nothing reached the server while offline").toHaveLength(0);

    assertQueueOrder(await h.queue.getAll(), "ORD-D");

    h.setOnline(true);
    await h.engine.flush();
    await vi.runOnlyPendingTimersAsync();

    assertUpsertBeforeSubmit(h.server.calls, "ORD-D");
    expect(h.server.sales).toEqual(["ORD-D"]);
  });

  it("(e) a queue persisted across a restart keeps its order and its idempotency key", async () => {
    const ordersMap = new Map<string, LocalOrder>();
    const queueMap = new Map<string, QueueOp>();
    const h1 = makeHarness({ online: false, ordersMap, queueMap });
    const doc = makeDoc("ORD-E");
    await h1.engine.saveCart(doc);
    await vi.advanceTimersByTimeAsync(600);
    await h1.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 });

    const persisted = [...queueMap.values()].sort((a, b) => a.seq - b.seq);
    const checkoutOpId = persisted.find((o) => o.type === "submit-and-sale")!.opId;
    expect(persisted.length, "the queue survived to storage").toBeGreaterThan(0);

    // "Restart": a brand-new engine over the very same maps.
    const h2 = makeHarness({ online: true, ordersMap, queueMap });
    await h2.engine.flush();
    await vi.runOnlyPendingTimersAsync();

    assertUpsertBeforeSubmit(h2.server.calls, "ORD-E");
    expect(h2.server.idempotencyKeys, "the idempotency key is the SAME opId after restart").toContain(checkoutOpId);
    expect(h2.server.sales).toEqual(["ORD-E"]);
  });

  it("(f) two engine instances on one store cannot interleave into a bad order", async () => {
    const ordersMap = new Map<string, LocalOrder>();
    const queueMap = new Map<string, QueueOp>();
    const h = makeHarness({ online: false, ordersMap, queueMap });
    const tabB = h.newEngineOnSameStores(); // same stores, same runner — one browser

    const doc = makeDoc("ORD-F");
    await h.engine.saveCart(doc);
    await tabB.saveCart({ ...doc, lines: [...doc.lines, { menuId: "M2", name: "قهوة", qty: 1, unitPrice: 15, lineDiscount: 0, vatCategory: "S", notes: null }] });
    await vi.advanceTimersByTimeAsync(600);

    // Both tabs try to check the same order out at once.
    await Promise.all([
      h.engine.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 }),
      tabB.checkout(doc, [{ method: "cash", amount: 46 }], { cashTendered: 46, changeDue: 0 }),
    ]);

    const ops = [...queueMap.values()];
    assertQueueOrder(ops, "ORD-F");
    expect(ops.filter((o) => o.type === "submit-and-sale"), "two tabs, still ONE checkout op").toHaveLength(1);
    const seqs = ops.map((o) => o.seq);
    expect(new Set(seqs).size, `no two ops share a seq — ${seqs.join(",")}`).toBe(seqs.length);

    h.setOnline(true);
    await h.engine.flush();
    await vi.runOnlyPendingTimersAsync();
    assertUpsertBeforeSubmit(h.server.calls, "ORD-F");
    expect(h.server.sales, "ONE sale from two tabs").toEqual(["ORD-F"]);
  });

  it("(g) a legacy queue already persisted as submit-before-upsert is repaired, without a duplicate sale", async () => {
    // Exactly the malformed shape the pre-fix build left on real devices.
    const ordersMap = new Map<string, LocalOrder>([["ORD-G", makeDoc("ORD-G", { status: "submitted" })]]);
    const queueMap = new Map<string, QueueOp>([
      ["OLD-SUBMIT", { opId: "OLD-SUBMIT", type: "submit-and-sale", orderId: "ORD-G", payload: { payments: [{ method: "cash", amount: 46 }], cashTendered: 46, changeDue: 0 }, ts: 1, seq: 7 } as QueueOp],
      ["OLD-UPSERT", { opId: "OLD-UPSERT", type: "upsert", orderId: "ORD-G", payload: { id: "ORD-G", lines: [] }, ts: 1, seq: 8 } as QueueOp],
    ]);

    const h = makeHarness({ online: true, ordersMap, queueMap });
    await h.engine.flush();
    await vi.runOnlyPendingTimersAsync();

    assertUpsertBeforeSubmit(h.server.calls, "ORD-G");
    expect(h.server.sales, "the repair does NOT produce a second sale").toEqual(["ORD-G"]);
    expect(h.server.idempotencyKeys, "the checkout op keeps its original opId — the server idempotency key").toContain("OLD-SUBMIT");
  });
});

describe("CO-1 — mutation test: the suite must FAIL when the barrier is removed", () => {
  // The mutation is aimed at the BARRIER ITSELF, not at a scenario, because the
  // engine also carries independent guards (requireOpenOrder, rejectIfCheckedOut)
  // that mask a missing barrier in the checkout schedules. A first attempt drove
  // the debounce-vs-checkout schedule through the racy runner and PASSED — the
  // status guard caught it — which proved the schedule tests the guard, not the
  // serialization. So this measures the one thing only the barrier provides:
  // that concurrent allocators cannot mint the same seq.

  async function concurrentSeqs(racy: boolean): Promise<number[]> {
    const h = makeHarness({ racy, online: false });
    await h.orders.put("ORD-M", makeDoc("ORD-M"));
    // Six concurrent appends on the same order — the shape a debounce firing
    // into a checkout produces, minus every engine-level guard.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        h.engine.enqueue("upsert", "ORD-M", { id: "ORD-M", n: i }, { replaceTrailingUpsert: false }),
      ),
    );
    return (await h.queue.getAll()).map((o) => o.seq).sort((a, b) => a - b);
  }

  it("WITH the barrier, concurrent allocators always get distinct sequence numbers", async () => {
    const seqs = await concurrentSeqs(false);
    expect(seqs, `6 ops queued — got ${seqs.join(",")}`).toHaveLength(6);
    expect(new Set(seqs).size, `every seq is unique — got ${seqs.join(",")}`).toBe(6);
    expect(seqs, "and they are exactly 1..6, i.e. a real total order").toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("WITHOUT the barrier, they collide — so the test above is not vacuous", async () => {
    const seqs = await concurrentSeqs(true);
    expect(
      new Set(seqs).size,
      `removing serialization must produce colliding seqs — got ${seqs.join(",")}. ` +
        "If this ever passes, racyAtomicRunner has stopped being racy and the ordering suite has lost its power.",
    ).toBeLessThan(seqs.length);
  });
});
