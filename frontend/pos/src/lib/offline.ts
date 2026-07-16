/**
 * Offline-first engine — local-first order docs + FIFO op queue + flush.
 *
 * Design (mirrors routes/pos-v2.js /sync contract):
 *  - Every cart change saves the LocalOrder doc to IndexedDB FIRST (instant),
 *    then a debounced (600ms) 'upsert' op is enqueued; when online the queue
 *    flushes immediately.
 *  - Flush sends the queue via POST /api/pos/v2/sync in batches, order
 *    preserved. 'submit-and-sale' ops are special: they run CLIENT-SIDE as
 *    (1) POST /orders/:id/submit with Idempotency-Key = opId,
 *    (2) POST /api/sales with the returned legacyPayload EXACTLY,
 *    (3) POST /orders/:id/complete — clientOrderId dedupe + the stable
 *    idempotency key make retries safe at every step.
 *  - VERSION_CONFLICT → server copy wins: the local doc is duplicated as a
 *    NEW draft ULID with note "نسخة محلية متعارضة" and a toast is surfaced.
 *  - expectedVersion for queued ops is computed AT FLUSH TIME: each op on an
 *    order bumps the server version by exactly 1, so we walk a per-order
 *    version cursor starting from the last acknowledged serverVersion.
 *
 * The engine takes injected stores + api so tests can run it against
 * in-memory Maps and a scripted api (src/lib/__tests__/offline.test.ts).
 */
import type { KVStore } from "./idb";
import { idbStore } from "./idb";
import * as realApi from "./api";
import { ApiError } from "./api";
import { ulid } from "./ulid";
import type {
  CartLine,
  LocalOrder,
  Payment,
  QueueOp,
  QueueOpType,
  SubmitResult,
  SyncOpReport,
  SyncReport,
} from "./types";

// ── Injected dependency surfaces ─────────────────────────────────────────────
export interface EngineApi {
  upsertOrder: typeof realApi.upsertOrder;
  transition: typeof realApi.transition;
  submitOrder: typeof realApi.submitOrder;
  postLegacySale: typeof realApi.postLegacySale;
  completeOrder: typeof realApi.completeOrder;
  postSync: typeof realApi.postSync;
}

export interface EngineDeps {
  orders: KVStore<LocalOrder>;
  queue: KVStore<QueueOp>;
  api: EngineApi;
  isOnline: () => boolean;
  now: () => number;
  newId: () => string;
  debounceMs: number;
  /** start timers + window listeners (false in tests) */
  autoStart: boolean;
}

export interface EngineStatus {
  online: boolean;
  syncing: boolean;
  queueCount: number;
  lastReport: SyncReport | null;
}

export type EngineEvent =
  | { type: "toast"; kind: "success" | "error" | "info"; message: string }
  | { type: "conflict"; originalId: string; draftId: string }
  | { type: "checkout-progress"; orderId: string; stage: "submit" | "sale" | "complete" }
  | {
      type: "checkout-done";
      orderId: string;
      ok: boolean;
      queued: boolean;
      invoiceNumber: string | null;
      saleId: string | null;
      error?: string;
    };

export interface CheckoutOutcome {
  state: "completed" | "queued" | "failed";
  invoiceNumber: string | null;
  saleId: string | null;
  /** Present only on "completed" — a queued sale has no stamp yet, and the
   *  receipt states that instead of inventing one. */
  zatcaQrDataUrl?: string | null;
  error?: string;
}

const SYNCABLE: ReadonlySet<QueueOpType> = new Set(["upsert", "hold", "resume", "reopen", "void", "complete"]);

/**
 * Customer quick-attach: the /submit endpoint builds the legacy /api/sales
 * payload SERVER-SIDE from the stored order, and buildLegacySalePayload sends
 * `customer` only when customerId is set — there is no pass-through for an
 * ad-hoc {name, phone}. Therefore customer name/phone ride in the order NOTE
 * ("عميل: <name> <phone>") so they land on the ticket + audit trail.
 */
export function composeNote(doc: Pick<LocalOrder, "note" | "customerName" | "customerPhone">): string | null {
  const parts: string[] = [];
  const cust = [doc.customerName, doc.customerPhone].filter(Boolean).join(" ").trim();
  if (cust) parts.push(`عميل: ${cust}`);
  if (doc.note) parts.push(doc.note);
  return parts.length ? parts.join(" | ").slice(0, 300) : null;
}

export function upsertPayloadFrom(doc: LocalOrder, expectedVersion?: number | null): Record<string, unknown> {
  return {
    id: doc.id,
    orderType: doc.orderType,
    tableNo: doc.tableNo || undefined,
    shiftId: doc.shiftId || undefined,
    deviceId: doc.deviceId || undefined,
    discountType: doc.discountType || undefined,
    discountValue: doc.discountType ? doc.discountValue : undefined,
    discountName: doc.discountName || undefined,
    // Real linked customer id → the server stores pos_orders.customer_id and
    // buildLegacySalePayload attaches it to the /api/sales write (Order-to-Cash).
    // Name/phone still ride in the note for the ticket/audit trail.
    customerId: doc.customerId || undefined,
    note: composeNote(doc) || undefined,
    // qty = entered qty in the chosen unit; unitFactor is FROZEN at add time so a
    // re-sync (even weeks later) computes the SAME baseQty on the server. The
    // server re-expands qty×factor→base and guards baseQty (UNIT_CONVERSION_CONFLICT).
    lines: doc.lines.map((l: CartLine) => ({
      menuId: l.menuId,
      qty: l.qty,
      unitPrice: l.unitPrice,
      lineDiscount: l.lineDiscount || 0,
      notes: l.notes || undefined,
      ...(l.enteredUnitCode ? { enteredUnitCode: l.enteredUnitCode } : {}),
      ...(l.enteredUnitId ? { enteredUnitId: l.enteredUnitId } : {}),
      ...(l.conversionFactorSnapshot != null && l.conversionFactorSnapshot !== 1
        ? { unitFactor: l.conversionFactorSnapshot }
        : {}),
      ...(l.baseQty != null ? { baseQty: l.baseQty } : {}),
    })),
    ...(expectedVersion != null ? { expectedVersion } : {}),
  };
}

function isNetworkError(e: unknown): boolean {
  // ApiError means the server answered (domain failure). Anything else —
  // fetch TypeError, abort, DNS — is transient: keep the op and retry later.
  return !(e instanceof ApiError);
}

export class OfflineEngine {
  private deps: EngineDeps;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: EngineEvent) => void>();
  private debouncers = new Map<string, ReturnType<typeof setTimeout>>();
  private seqCounter = 0;
  private seqReady: Promise<void>;
  private syncing = false;
  private pendingFlush = false;
  private queueCount = 0;
  private lastReport: SyncReport | null = null;
  private statusSnapshot: EngineStatus;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.statusSnapshot = { online: deps.isOnline(), syncing: false, queueCount: 0, lastReport: null };
    this.seqReady = this.initSeq();
    if (deps.autoStart) this.start();
  }

  private async initSeq(): Promise<void> {
    try {
      const ops = await this.deps.queue.getAll();
      this.seqCounter = ops.reduce((m, o) => Math.max(m, o.seq), 0);
      this.queueCount = ops.length;
      this.emitStatus();
    } catch {
      /* fresh db */
    }
  }

  start(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.emitStatus();
        void this.flush();
      });
      window.addEventListener("offline", () => this.emitStatus());
    }
    this.intervalId = setInterval(() => void this.flush(), 30_000);
    void this.flush();
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }

  // ── Status / events (useSyncExternalStore-friendly) ────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getStatus(): EngineStatus {
    return this.statusSnapshot;
  }
  onEvent(fn: (e: EngineEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  private emitStatus(): void {
    this.statusSnapshot = {
      online: this.deps.isOnline(),
      syncing: this.syncing,
      queueCount: this.queueCount,
      lastReport: this.lastReport,
    };
    this.listeners.forEach((fn) => fn());
  }
  private emitEvent(e: EngineEvent): void {
    this.eventListeners.forEach((fn) => fn(e));
  }

  // ── Local docs ──────────────────────────────────────────────────────────────
  getOrder(id: string): Promise<LocalOrder | undefined> {
    return this.deps.orders.get(id);
  }
  /** Direct doc write WITHOUT scheduling an upsert (server-adopted docs). */
  putOrder(doc: LocalOrder): Promise<void> {
    return this.deps.orders.put(doc.id, doc);
  }

  /**
   * serverVersion is ENGINE-OWNED: React state snapshots never carry it, so a
   * raw put of a UI doc would clobber the acknowledged version and the next
   * flush would send an upsert WITHOUT expectedVersion (server 422s updates of
   * existing orders). Merge the stored value back before every UI-doc write.
   */
  private async mergeServerVersion(doc: LocalOrder): Promise<LocalOrder> {
    if (doc.serverVersion != null) return doc;
    const stored = await this.deps.orders.get(doc.id);
    return stored?.serverVersion != null ? { ...doc, serverVersion: stored.serverVersion } : doc;
  }
  async allOrders(): Promise<LocalOrder[]> {
    return this.deps.orders.getAll();
  }
  async localHeldOrders(): Promise<LocalOrder[]> {
    return (await this.deps.orders.getAll()).filter((o) => o.status === "held");
  }
  /** Most recently updated open local doc — cart restore after refresh. */
  async latestOpenOrder(): Promise<LocalOrder | undefined> {
    const all = (await this.deps.orders.getAll()).filter((o) => o.status === "open");
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all[0];
  }

  /**
   * Save the cart doc NOW (instant, local-first) and schedule the debounced
   * 'upsert' op. Orders with no lines are never sent to the server (the
   * backend rejects empty carts) — they stay local until they gain a line.
   */
  async saveCart(doc: LocalOrder): Promise<void> {
    doc = await this.mergeServerVersion(doc);
    await this.deps.orders.put(doc.id, doc);
    const old = this.debouncers.get(doc.id);
    if (old) clearTimeout(old);
    if (!doc.lines.length || doc.status !== "open") return;
    this.debouncers.set(
      doc.id,
      setTimeout(() => {
        this.debouncers.delete(doc.id);
        void this.enqueueUpsertFor(doc.id).then(() => {
          if (this.deps.isOnline()) void this.flush();
        });
      }, this.deps.debounceMs),
    );
  }

  /** Cancel the pending debounce and enqueue the upsert immediately. */
  async flushCartNow(orderId: string): Promise<void> {
    const t = this.debouncers.get(orderId);
    if (t) {
      clearTimeout(t);
      this.debouncers.delete(orderId);
    }
    await this.enqueueUpsertFor(orderId);
  }

  private async enqueueUpsertFor(orderId: string): Promise<void> {
    const doc = await this.deps.orders.get(orderId);
    if (!doc || !doc.lines.length) return;
    await this.enqueue("upsert", orderId, upsertPayloadFrom(doc), { replaceTrailingUpsert: true });
  }

  /**
   * Append an op. When replaceTrailingUpsert is set and the LAST queued op for
   * this order is an 'upsert', it is replaced (deleted + re-appended under a
   * NEW opId — the payload changed, so reusing the opId would trip the
   * server's idempotency-content check). Ops for other orders are unaffected.
   */
  async enqueue(
    type: QueueOpType,
    orderId: string,
    payload: Record<string, unknown>,
    opts: { replaceTrailingUpsert?: boolean } = {},
  ): Promise<QueueOp> {
    await this.seqReady;
    if (opts.replaceTrailingUpsert) {
      const ops = (await this.deps.queue.getAll()).sort((a, b) => a.seq - b.seq);
      const mine = ops.filter((o) => o.orderId === orderId);
      const last = mine[mine.length - 1];
      if (last && last.type === "upsert") await this.deps.queue.delete(last.opId);
    }
    const op: QueueOp = {
      opId: this.deps.newId(),
      type,
      orderId,
      payload,
      ts: this.deps.now(),
      seq: ++this.seqCounter,
    };
    await this.deps.queue.put(op.opId, op);
    this.queueCount = (await this.deps.queue.getAll()).length;
    this.emitStatus();
    return op;
  }

  async queuedOps(): Promise<QueueOp[]> {
    return (await this.deps.queue.getAll()).sort((a, b) => a.seq - b.seq);
  }

  /** True when the order exists server-side or has ops in flight — an offline
   *  void of such an order is forbidden (server copy would survive). */
  async isOrderSyncedOrQueued(orderId: string): Promise<boolean> {
    const doc = await this.deps.orders.get(orderId);
    if (doc?.serverVersion != null) return true;
    return (await this.deps.queue.getAll()).some((o) => o.orderId === orderId);
  }

  // ── High-level order actions (local-first, queue-backed) ──────────────────
  async holdOrder(doc: LocalOrder): Promise<void> {
    const held: LocalOrder = { ...doc, status: "held", updatedAt: this.deps.now() };
    // Ensure the latest lines precede the hold in the queue (the doc in the
    // store must be the OPEN version for the upsert payload snapshot).
    await this.deps.orders.put(doc.id, { ...held, status: "open" });
    await this.flushCartNow(doc.id);
    await this.deps.orders.put(doc.id, held);
    await this.enqueue("hold", doc.id, {});
    if (this.deps.isOnline()) void this.flush();
  }

  async resumeLocalOrder(doc: LocalOrder): Promise<LocalOrder> {
    const open: LocalOrder = { ...doc, status: "open", updatedAt: this.deps.now() };
    await this.deps.orders.put(open.id, open);
    if (open.serverVersion != null || (await this.isOrderSyncedOrQueued(open.id))) {
      await this.enqueue("resume", open.id, {});
      if (this.deps.isOnline()) void this.flush();
    }
    return open;
  }

  /** Void — purely-local drafts evaporate; anything synced/queued gets a
   *  queued 'void' op (UI forbids this offline for already-synced orders). */
  async voidOrder(doc: LocalOrder, reason: string): Promise<void> {
    const trackedRemotely = await this.isOrderSyncedOrQueued(doc.id);
    const t = this.debouncers.get(doc.id);
    if (t) {
      clearTimeout(t);
      this.debouncers.delete(doc.id);
    }
    if (!trackedRemotely) {
      await this.deps.orders.delete(doc.id);
      return;
    }
    await this.deps.orders.put(doc.id, { ...(await this.mergeServerVersion(doc)), status: "voided", updatedAt: this.deps.now() });
    await this.enqueue("void", doc.id, { reason });
    if (this.deps.isOnline()) void this.flush();
  }

  /**
   * Checkout — ONE code path for online and offline:
   * enqueue the final upsert + a 'submit-and-sale' op, then flush. Online the
   * flush completes inline (progress events fire per stage); offline the op
   * waits in the queue (CASH only — enforced by the PaymentDialog).
   */
  async checkout(
    doc: LocalOrder,
    payments: Payment[],
    opts: { cashTendered?: number; changeDue?: number; paymentNotes?: string },
  ): Promise<CheckoutOutcome> {
    const submitted: LocalOrder = { ...(await this.mergeServerVersion(doc)), status: "submitted", updatedAt: this.deps.now() };
    await this.deps.orders.put(submitted.id, submitted);
    // The doc was open moments ago; enqueue its final lines before the submit.
    const t = this.debouncers.get(doc.id);
    if (t) {
      clearTimeout(t);
      this.debouncers.delete(doc.id);
    }
    if (submitted.lines.length) {
      await this.enqueue("upsert", submitted.id, upsertPayloadFrom(submitted), { replaceTrailingUpsert: true });
    }
    await this.enqueue("submit-and-sale", doc.id, {
      payments,
      cashTendered: opts.cashTendered ?? 0,
      changeDue: opts.changeDue ?? 0,
      paymentNotes: opts.paymentNotes ?? undefined,
    });

    if (!this.deps.isOnline()) {
      this.emitEvent({ type: "checkout-done", orderId: doc.id, ok: true, queued: true, invoiceNumber: null, saleId: null });
      return { state: "queued", invoiceNumber: null, saleId: null };
    }

    await this.flush();
    const after = await this.deps.orders.get(doc.id);
    if (after?.status === "completed") {
      return { state: "completed", invoiceNumber: after.invoiceNumber, saleId: after.saleId, zatcaQrDataUrl: after.zatcaQrDataUrl ?? null };
    }
    const failed = this.lastReport?.results.find((r) => r.orderId === doc.id && !r.ok);
    if (failed) return { state: "failed", invoiceNumber: null, saleId: null, error: failed.error || failed.code };
    // Network died mid-flush — the op is safely queued and will replay.
    return { state: "queued", invoiceNumber: null, saleId: null };
  }

  // ── Conflict parking ────────────────────────────────────────────────────────
  private async parkConflictDraft(orderId: string): Promise<void> {
    const doc = await this.deps.orders.get(orderId);
    if (!doc) return;
    const draftId = this.deps.newId();
    const draft: LocalOrder = {
      ...doc,
      id: draftId,
      status: "open",
      serverVersion: null,
      saleId: null,
      invoiceNumber: null,
      note: doc.note && doc.note.includes("نسخة محلية متعارضة") ? doc.note : ["نسخة محلية متعارضة", doc.note].filter(Boolean).join(" | "),
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
      lines: doc.lines.map((l) => ({ ...l })),
    };
    await this.deps.orders.put(draftId, draft);
    await this.deps.orders.delete(orderId); // server copy wins for the original
    this.emitEvent({ type: "conflict", originalId: orderId, draftId });
    this.emitEvent({
      type: "toast",
      kind: "error",
      message: "تعارض نسخ — اعتُمدت نسخة الخادم وحُفظت تعديلاتك كمسودة جديدة (نسخة محلية متعارضة)",
    });
  }

  // ── Flush engine ────────────────────────────────────────────────────────────
  async flush(): Promise<void> {
    if (this.syncing) {
      this.pendingFlush = true;
      return;
    }
    if (!this.deps.isOnline()) {
      this.emitStatus();
      return;
    }
    this.syncing = true;
    this.emitStatus();
    const reports: SyncOpReport[] = [];
    try {
      await this.seqReady;
      const ops = (await this.deps.queue.getAll()).sort((a, b) => a.seq - b.seq);
      if (ops.length) {
        // Per-order expectedVersion cursor (see file header).
        const cursor = new Map<string, number | null>();
        for (const op of ops) {
          if (!cursor.has(op.orderId)) {
            const doc = await this.deps.orders.get(op.orderId);
            cursor.set(op.orderId, doc?.serverVersion ?? null);
          }
        }
        let i = 0;
        let stopped = false;
        while (i < ops.length && !stopped) {
          if (op_isCheckout(ops[i])) {
            stopped = await this.runCheckoutOp(ops[i], cursor, reports);
            i++;
          } else {
            const batch: QueueOp[] = [];
            while (i < ops.length && !op_isCheckout(ops[i])) {
              batch.push(ops[i]);
              i++;
            }
            stopped = await this.runSyncBatch(batch, cursor, reports);
          }
        }
      }
    } finally {
      if (reports.length) this.lastReport = { at: this.deps.now(), results: reports };
      this.queueCount = (await this.deps.queue.getAll().catch(() => [] as QueueOp[])).length;
      this.syncing = false;
      this.emitStatus();
      if (reports.length) this.emitEvent({ type: "toast", kind: "info", message: syncSummaryText(reports) });
      if (this.pendingFlush) {
        this.pendingFlush = false;
        void this.flush();
      }
    }
  }

  /** Returns true when the flush must STOP (transient failure — order preserved). */
  private async runSyncBatch(
    batch: QueueOp[],
    cursor: Map<string, number | null>,
    reports: SyncOpReport[],
  ): Promise<boolean> {
    if (!batch.length) return false;
    // Rewrite expectedVersion per the cursor walk.
    const wire = batch.map((op) => {
      const v = cursor.get(op.orderId) ?? null;
      let payload = op.payload;
      if (op.type === "upsert") {
        payload = { ...op.payload };
        if (v != null) (payload as Record<string, unknown>).expectedVersion = v;
        else delete (payload as Record<string, unknown>).expectedVersion;
        cursor.set(op.orderId, (v ?? 0) + 1);
      } else if (op.type === "hold" || op.type === "resume" || op.type === "reopen" || op.type === "void") {
        payload = { ...op.payload };
        if (v != null) (payload as Record<string, unknown>).expectedVersion = v;
        cursor.set(op.orderId, v != null ? v + 1 : null);
      }
      return { opId: op.opId, type: op.type, orderId: op.orderId, payload };
    });

    let resp: Awaited<ReturnType<EngineApi["postSync"]>>;
    try {
      resp = await this.deps.api.postSync(wire);
    } catch (e) {
      if (isNetworkError(e)) return true; // transient — keep everything, stop
      // Envelope-level rejection (auth, validation of the batch itself): stop
      // without dropping ops; surface once.
      this.emitEvent({ type: "toast", kind: "error", message: (e as Error).message });
      return true;
    }

    const byOp = new Map(resp.results.map((r) => [r.opId, r]));
    for (const op of batch) {
      const r = byOp.get(op.opId);
      if (!r) continue; // server didn't answer for this op — keep it queued
      const report: SyncOpReport = {
        opId: op.opId,
        type: op.type,
        orderId: op.orderId,
        ok: r.ok,
        replay: r.replay,
        code: r.code,
        error: r.error,
      };
      reports.push(report);
      if (r.ok) {
        await this.deps.queue.delete(op.opId);
        const version = extractVersion(r.result);
        if (version != null) {
          const doc = await this.deps.orders.get(op.orderId);
          if (doc) {
            doc.serverVersion = version;
            await this.deps.orders.put(doc.id, doc);
          }
          cursor.set(op.orderId, version); // trust the server over our walk
        }
      } else if (r.code === "VERSION_CONFLICT") {
        await this.deps.queue.delete(op.opId);
        await this.dropOpsFor(op.orderId, batch, reports);
        if (op.type === "upsert") await this.parkConflictDraft(op.orderId);
        else this.emitEvent({ type: "toast", kind: "error", message: `تعارض نسخ في الطلب ${op.orderId.slice(-6)} — اعتُمدت نسخة الخادم` });
      } else {
        // Permanent domain failure (VALIDATION_ERROR / PERMISSION_DENIED /
        // IDEMPOTENCY_CONFLICT…) — drop so the queue never jams.
        await this.deps.queue.delete(op.opId);
        this.emitEvent({ type: "toast", kind: "error", message: r.error || r.code || "فشلت المزامنة" });
      }
    }
    return false;
  }

  /** After a conflict every later queued op for that order is doomed — drop them. */
  private async dropOpsFor(orderId: string, exceptBatch: QueueOp[], reports: SyncOpReport[]): Promise<void> {
    const remaining = (await this.deps.queue.getAll()).filter((o) => o.orderId === orderId);
    for (const o of remaining) {
      if (exceptBatch.some((b) => b.opId === o.opId)) continue;
      await this.deps.queue.delete(o.opId);
      reports.push({ opId: o.opId, type: o.type, orderId, ok: false, code: "VERSION_CONFLICT", error: "أُسقطت بعد تعارض النسخ" });
    }
  }

  /** The offline checkout replay: submit → legacy sale → complete. */
  private async runCheckoutOp(
    op: QueueOp,
    cursor: Map<string, number | null>,
    reports: SyncOpReport[],
  ): Promise<boolean> {
    const orderId = op.orderId;
    const p = op.payload as {
      payments: Payment[];
      cashTendered?: number;
      changeDue?: number;
      paymentNotes?: string;
    };
    const fail = async (error: string, code?: string): Promise<void> => {
      reports.push({ opId: op.opId, type: op.type, orderId, ok: false, code, error });
      await this.deps.queue.delete(op.opId);
      const doc = await this.deps.orders.get(orderId);
      if (doc) {
        doc.status = "open";
        doc.updatedAt = this.deps.now();
        await this.deps.orders.put(doc.id, doc);
      }
      this.emitEvent({ type: "checkout-done", orderId, ok: false, queued: false, invoiceNumber: null, saleId: null, error });
      this.emitEvent({ type: "toast", kind: "error", message: error });
    };

    // 1) submit — Idempotency-Key = opId (stable across retries).
    this.emitEvent({ type: "checkout-progress", orderId, stage: "submit" });
    let sub: SubmitResult;
    try {
      sub = await this.deps.api.submitOrder(
        orderId,
        {
          payments: p.payments,
          cashTendered: p.cashTendered || 0,
          changeDue: p.changeDue || 0,
          paymentNotes: p.paymentNotes || undefined,
          // expectedVersion intentionally omitted: queue order guarantees the
          // final upsert already landed; the server still guards state.
        },
        op.opId,
      );
      cursor.set(orderId, sub.version ?? null);
    } catch (e) {
      if (isNetworkError(e)) return true; // retry whole op later
      await fail((e as ApiError).message, (e as ApiError).code);
      return false;
    }

    // 2) legacy financial write — the payload goes EXACTLY as returned.
    this.emitEvent({ type: "checkout-progress", orderId, stage: "sale" });
    let saleId: string;
    let invoiceNumber: string | null;
    let zatcaQrDataUrl: string | null;
    try {
      const sale = await this.deps.api.postLegacySale(sub.data.legacyPayload);
      saleId = sale.orderId;
      invoiceNumber = sale.invoiceNumber ?? null;
      // The stamp the customer's receipt must carry. It was always in the
      // response; nothing kept it.
      zatcaQrDataUrl = sale.zatca?.qrDataUrl ?? null;
    } catch (e) {
      if (isNetworkError(e)) return true; // clientOrderId dedupe makes replay safe
      // Domain failure → reopen the order server-side and surface the error.
      try {
        await this.deps.api.transition(orderId, "reopen", {});
      } catch {
        /* best-effort; server state machine will still allow manual reopen */
      }
      await fail((e as ApiError).message, (e as ApiError).code);
      return false;
    }

    // 3) complete — idempotent by (id, saleId).
    this.emitEvent({ type: "checkout-progress", orderId, stage: "complete" });
    try {
      const done = await this.deps.api.completeOrder(orderId, { saleId, invoiceNumber });
      cursor.set(orderId, done.version ?? null);
    } catch (e) {
      if (isNetworkError(e)) return true; // replaying re-runs complete only (submit+sale replay idempotently)
      // Even if complete failed with a domain error the SALE EXISTS — never
      // "fail" the checkout financially. Record and move on.
      reports.push({ opId: op.opId, type: op.type, orderId, ok: false, code: (e as ApiError).code, error: (e as ApiError).message });
      await this.deps.queue.delete(op.opId);
      this.emitEvent({ type: "toast", kind: "error", message: "تم تسجيل البيع لكن تعذّر إكمال الطلب: " + (e as ApiError).message });
      return false;
    }

    const doc = await this.deps.orders.get(orderId);
    if (doc) {
      doc.status = "completed";
      doc.saleId = saleId;
      doc.invoiceNumber = invoiceNumber;
      // Persisted with the doc so a reprint after the dialog closed — or after a
      // reload — still carries the stamp instead of silently dropping it.
      doc.zatcaQrDataUrl = zatcaQrDataUrl;
      doc.updatedAt = this.deps.now();
      await this.deps.orders.put(doc.id, doc);
    }
    await this.deps.queue.delete(op.opId);
    reports.push({ opId: op.opId, type: op.type, orderId, ok: true });
    this.emitEvent({ type: "checkout-done", orderId, ok: true, queued: false, invoiceNumber, saleId });
    return false;
  }

  /** Housekeeping — cap terminal docs so IndexedDB doesn't grow unbounded. */
  async pruneTerminalDocs(keep = 100): Promise<void> {
    const all = await this.deps.orders.getAll();
    const terminal = all
      .filter((o) => o.status === "completed" || o.status === "voided")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const doc of terminal.slice(keep)) await this.deps.orders.delete(doc.id);
  }
}

function op_isCheckout(op: QueueOp): boolean {
  return op.type === "submit-and-sale";
}

function extractVersion(result: unknown): number | null {
  if (result && typeof result === "object" && "version" in result) {
    const v = Number((result as { version: unknown }).version);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function syncSummaryText(reports: SyncOpReport[]): string {
  const ok = reports.filter((r) => r.ok).length;
  const bad = reports.length - ok;
  return bad === 0 ? `تمت مزامنة ${ok} عملية بنجاح` : `المزامنة: ${ok} نجحت، ${bad} فشلت`;
}

// ── Production singleton ─────────────────────────────────────────────────────
let engineSingleton: OfflineEngine | null = null;

export function getEngine(): OfflineEngine {
  if (!engineSingleton) {
    engineSingleton = new OfflineEngine({
      orders: idbStore<LocalOrder>("orders"),
      queue: idbStore<QueueOp>("queue"),
      api: {
        upsertOrder: realApi.upsertOrder,
        transition: realApi.transition,
        submitOrder: realApi.submitOrder,
        postLegacySale: realApi.postLegacySale,
        completeOrder: realApi.completeOrder,
        postSync: realApi.postSync,
      },
      isOnline: () => (typeof navigator !== "undefined" ? navigator.onLine : true),
      now: () => Date.now(),
      newId: ulid,
      debounceMs: 600,
      autoStart: true,
    });
    void engineSingleton.pruneTerminalDocs();
  }
  return engineSingleton;
}

const CHECKOUT_TYPE: QueueOpType = "submit-and-sale";
export { CHECKOUT_TYPE, SYNCABLE };
