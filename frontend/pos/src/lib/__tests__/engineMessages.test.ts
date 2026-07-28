/**
 * The engine's OWN messages must obey the till's language, and must not call a
 * deliberately-resolved conflict a failure.
 *
 * From a production screenshot on an ENGLISH till (Stocktake / Requisitions /
 * Delivery / Hold all in English), three Arabic toasts stacked at once:
 *   «تعارض نسخ — اعتُمدت نسخة الخادم …»
 *   «تمت مزامنة 1 عملية بنجاح»
 *   «المزامنة: 0 نجحت، 1 فشلت»
 *
 * Two separate defects:
 *  1. lib/offline.ts carried raw Arabic string literals. The engine lives
 *     outside the React tree, so it only got a t() late (setTranslator), and
 *     its own literals were left behind — the register spoke English right up
 *     until something went wrong with a sale, which is the worst place to lose
 *     the reader.
 *  2. syncSummaryText counted a VERSION_CONFLICT as a FAILURE. It is not: the
 *     engine resolved it by design — the server copy became the record and the
 *     cashier's edits were parked as their own draft. "0 succeeded, 1 failed"
 *     turns a working design into a support call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAtomicRunner, memoryStore } from "../idb";
import { OfflineEngine, type EngineApi, type EngineEvent } from "../offline";
import type { LocalOrder, QueueOp } from "../types";
import { makeT } from "../../i18n/I18nProvider";

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
    lines: [{ menuId: "M1", name: "شاي", qty: 1, unitPrice: 20, lineDiscount: 0, vatCategory: "S", notes: null }],
    serverVersion: 1,
    invoiceNumber: null,
    saleId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Drives the real engine against a scripted /sync that answers with `result`. */
function makeHarness(syncResult: (opId: string) => Record<string, unknown>) {
  const orders = memoryStore<LocalOrder>();
  const queue = memoryStore<QueueOp>();
  const events: EngineEvent[] = [];
  let idCounter = 0;

  const api = {
    upsertOrder: vi.fn(),
    transition: vi.fn(),
    submitOrder: vi.fn(),
    postLegacySale: vi.fn(),
    completeOrder: vi.fn(),
    postSync: vi.fn(async (ops: Array<{ opId: string }>) => ({
      success: true,
      results: ops.map((o) => ({ opId: o.opId, ...syncResult(o.opId) })),
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
    debounceMs: 600,
    autoStart: false,
    currentActor: () => ({ username: "cashier1", isSupervisor: false }),
  });
  engine.onEvent((e) => events.push(e));
  return { engine, orders, queue, events };
}

const toasts = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast");

let h: ReturnType<typeof makeHarness>;

describe("the engine speaks the till's language", () => {
  beforeEach(() => {
    h = makeHarness(() => ({ ok: false, code: "VERSION_CONFLICT", error: "conflict" }));
  });

  it("emits ENGLISH on an English till — no Arabic literal survives", async () => {
    h.engine.setTranslator(makeT("en"));
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    await h.engine.flush();

    const messages = toasts(h.events).map((t) => t.message);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m).not.toMatch(/[؀-ۿ]/); // any Arabic letter is the bug
      expect(m).not.toMatch(/^syncEngine\./); // …and a raw key is not a message
    }
  });

  it("emits Arabic on an Arabic till", async () => {
    h.engine.setTranslator(makeT("ar"));
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    await h.engine.flush();

    const messages = toasts(h.events).map((t) => t.message);
    expect(messages.some((m) => /[؀-ۿ]/.test(m))).toBe(true);
  });
});

describe("a resolved version conflict is not reported as a failure", () => {
  it("says the server copy superseded it — not '0 succeeded, 1 failed'", async () => {
    h = makeHarness(() => ({ ok: false, code: "VERSION_CONFLICT", error: "conflict" }));
    h.engine.setTranslator(makeT("en"));
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    await h.engine.flush();

    const summary = toasts(h.events).filter((t) => t.kind === "info").map((t) => t.message);
    expect(summary.length).toBe(1);
    expect(summary[0]).toMatch(/superseded/i);
    expect(summary[0]).not.toMatch(/could not be sent/i);
  });

  it("still reports a REAL failure as a failure", async () => {
    h = makeHarness(() => ({ ok: false, code: "VALIDATION_ERROR", error: "bad" }));
    h.engine.setTranslator(makeT("en"));
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    await h.engine.flush();

    const summary = toasts(h.events).filter((t) => t.kind === "info").map((t) => t.message);
    expect(summary[0]).toMatch(/could not be sent/i);
  });

  it("reports a clean drain plainly", async () => {
    h = makeHarness(() => ({ ok: true, result: { version: 2 } }));
    h.engine.setTranslator(makeT("en"));
    await h.orders.put("O1", makeDoc("O1"));
    await h.engine.enqueue("upsert", "O1", { id: "O1", lines: [] });
    await h.engine.flush();

    const summary = toasts(h.events).filter((t) => t.kind === "info").map((t) => t.message);
    expect(summary[0]).toMatch(/1 pending operation synced/i);
  });
});
