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
import type { AtomicRunner, AtomicTxn, KVStore } from "./idb";
import { idbAtomicRunner, idbStore } from "./idb";
import * as realApi from "./api";
import { recordFailure } from "./failureLog";
import { ApiError } from "./api";
import { ulid } from "./ulid";
import { translateApiError } from "../i18n/errorCodes";
import type { TFunction } from "../i18n/types";
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

// This module lives OUTSIDE the React tree (a singleton constructed lazily by
// getEngine(), independent of any component's lifecycle) so it cannot call
// useT() itself. IDENTITY_T mirrors I18nProvider's own documented "miss"
// contract (a lookup miss returns the dotted path unchanged) — passing it to
// translateApiError() makes every `errors.<code>` lookup miss on purpose, so
// translateApiError() falls through to the real per-error `message` exactly
// as it did before any translator was wired in. Whichever component mounts
// first inside an <I18nProvider> (PosProvider, via useOptionalT()) calls
// setTranslator() with the live t() so toasts become properly localized;
// until then — and in any test harness that never calls setTranslator() —
// this safe default keeps every message meaningful (never a blank string).
const IDENTITY_T: TFunction = (path) => path;

// CO-1 — the stores the ordering critical section spans. 'orders' is in here
// because checkout must mark the order submitted in the SAME transaction that
// queues its submit; being able to observe one without the other IS the bug.
const ORDER_TX: Array<"orders" | "queue"> = ["orders", "queue"];

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
  /**
   * CO-1 — the serialized critical section for everything that decides QUEUE
   * ORDER. `orders`/`queue` above stay for plain reads and for the drain, but
   * any read-modify-write that allocates a seq, replaces a trailing upsert, or
   * moves an order into checkout MUST go through here. See idb.ts for why an
   * in-memory mutex is not sufficient (two tabs, and reloads).
   */
  atomic: AtomicRunner;
  api: EngineApi;
  isOnline: () => boolean;
  now: () => number;
  newId: () => string;
  debounceMs: number;
  /** start timers + window listeners (false in tests) */
  autoStart: boolean;
  /** Optional — the live i18n t() (see setTranslator()/IDENTITY_T above for
   *  why this can't be required at construction time). Omit in tests that
   *  don't care about toast text; the engine falls back to IDENTITY_T. */
  t?: TFunction;
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
      // Combo picks MUST ride the upsert: the server validates comboChoices at
      // line-write time (routes/pos-v2.js _normalizeLines → _validateComboChoices)
      // and rejects a combo whose required choice group has zero picks. Omitting
      // the field — as this builder did before — made EVERY combo fail sync with
      // "أكمل اختيارات … المطلوب N على الأقل". Sent only when non-empty so a plain
      // line never smuggles choices (the server throws on that too).
      ...(l.comboChoices && Object.keys(l.comboChoices).length ? { comboChoices: l.comboChoices } : {}),
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
  /** CO-1 — see cancelDebounce(): invalidates a timer that has ALREADY fired. */
  private debounceGen = new Map<string, number>();
  /** Resolves once the persisted queue has been repaired (see repairQueue). */
  private seqReady: Promise<void>;
  private syncing = false;
  /**
   * CO-1 — flushes are serialized through this chain so `await flush()` really
   * means "a drain covering my ops has finished". See flush().
   */
  private flushChain: Promise<void> = Promise.resolve();
  private queueCount = 0;
  private lastReport: SyncReport | null = null;
  private statusSnapshot: EngineStatus;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private t: TFunction;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.t = deps.t ?? IDENTITY_T;
    this.statusSnapshot = { online: deps.isOnline(), syncing: false, queueCount: 0, lastReport: null };
    this.seqReady = this.initSeq();
    if (deps.autoStart) this.start();
  }

  /** Wire in the live i18n t() after construction — PosProvider calls this
   *  from a useEffect (via useOptionalT()) on mount and on every language
   *  change, since the engine singleton is created once outside React and
   *  can't call useT() itself. Safe to never call (see IDENTITY_T above). */
  setTranslator(t: TFunction): void {
    this.t = t;
  }

  /** Turn a caught error / a per-op {code,error} result into user-facing
   *  toast text — routes through translateApiError() so a known code (e.g.
   *  VERSION_CONFLICT, O2C_MODULE_ACTIVE) gets a friendly localized message,
   *  and everything else falls back to the real server-provided message
   *  rather than a raw HTTP-status string. */
  private toastMessage(e: unknown): string {
    return translateApiError(e, this.t);
  }

  /**
   * CO-1 — repair queues persisted by the PRE-FIX build, then seed the durable
   * counter. Runs once at construction, inside the same barrier every enqueue
   * uses, so it cannot race a checkout started immediately after boot.
   *
   * The bug shipped ops to IndexedDB in the shape
   *
   *     submit-and-sale(seq = n)   BEFORE   upsert(seq = n + 1)
   *
   * and those rows are still on real devices, mid-flight, right now. Draining
   * them as-is reproduces the 404 forever, because the drain sorts by seq.
   *
   * The repair REORDERS rather than deletes: for each order, every upsert that
   * sorts after that order's checkout is moved just before it, preserving the
   * relative order of the rest. opIds are NEVER changed — they are the server's
   * idempotency keys, so rewriting one would turn a replay into a SECOND sale.
   * Renumbering seq only changes the order we send them in, which is precisely
   * the thing that was wrong.
   *
   * Idempotent: a queue already in the right order renumbers to itself.
   */
  private async initSeq(): Promise<void> {
    try {
      await this.deps.atomic.transact(
        ORDER_TX,
        { all: ["queue"] },
        (txn: AtomicTxn) => {
          const all = txn.getAll<QueueOp>("queue").sort((a, b) => a.seq - b.seq);
          this.queueCount = all.length;
          if (!all.length) return;

          const byOrder = new Map<string, QueueOp[]>();
          for (const o of all) {
            const list = byOrder.get(o.orderId) ?? [];
            list.push(o);
            byOrder.set(o.orderId, list);
          }

          const moved = new Set<string>();
          for (const [, ops] of byOrder) {
            // findIndex would only ever see the FIRST checkout. Legacy rows
            // written before rejectIfCheckedOut existed can carry two for one
            // order; the earliest keeps its opId (it may already own a /submit
            // idempotency reservation server-side) and the rest are dropped, or
            // the device replays a duplicate sale.
            const checkouts = ops.filter((o) => o.type === "submit-and-sale");
            if (!checkouts.length) continue;
            for (const dup of checkouts.slice(1)) {
              txn.delete("queue", dup.opId);
              this.repairedDuplicateCheckouts++;
            }
            const firstIdx = ops.indexOf(checkouts[0]);
            for (const stray of ops.slice(firstIdx + 1)) {
              if (stray.type === "upsert") moved.add(stray.opId);
            }
          }
          if (!moved.size) return; // already well-ordered — nothing to rewrite

          // Rebuild the global order: each stray upsert hops to just before its
          // own order's checkout. Other orders' ops keep their relative places.
          const ordered: QueueOp[] = [];
          for (const op of all) {
            if (moved.has(op.opId)) continue;
            if (op.type === "submit-and-sale") {
              for (const s of all) {
                if (moved.has(s.opId) && s.orderId === op.orderId) ordered.push(s);
              }
            }
            ordered.push(op);
          }

          let seq = 0;
          for (const op of ordered) txn.put("queue", op.opId, { ...op, seq: ++seq });
          this.repairedOnBoot = moved.size;
        },
      );
      this.emitStatus();
    } catch (e) {
      // NEVER swallow this. seqReady resolving after a failed repair lets
      // flush() drain an UNREPAIRED queue — reproducing the 404 forever on
      // exactly the devices the repair exists to rescue. Record it and make it
      // visible; flush() refuses to drain while it is set.
      this.repairFailed = e instanceof Error ? e : new Error(String(e));
      this.emitEvent({ type: "toast", kind: "error", message: this.toastMessage(e) });
      this.emitStatus();
    }
  }

  /** Set when the boot repair failed — the queue cannot be trusted to drain. */
  repairFailed: Error | null = null;
  /** Duplicate legacy checkouts the boot repair had to drop (diagnostics). */
  repairedDuplicateCheckouts = 0;

  /** How many mis-sequenced upserts the boot repair had to move (diagnostics). */
  repairedOnBoot = 0;

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

    // CO-1, the other half of invariant 2. The barrier stops a stale UPSERT
    // being queued after checkout — but this write bypasses the barrier, and
    // the React tree can still be holding a doc snapshot whose status is
    // 'open' from before Pay was tapped. Writing it back would DOWNGRADE the
    // stored 'submitted' order to 'open', which re-arms the debounce below and
    // re-opens the very window the barrier exists to close.
    //
    // An order only ever moves forward out of 'open'. A save carrying 'open'
    // for an order the store has already advanced is by definition stale, so
    // it is dropped rather than merged: the cart it describes no longer exists.
    if (doc.status === "open") {
      const stored = await this.deps.orders.get(doc.id);
      if (stored && stored.status !== "open") return;
    }

    await this.deps.orders.put(doc.id, doc);
    this.cancelDebounce(doc.id);
    if (!doc.lines.length || doc.status !== "open") return;
    // Capture the generation this timer belongs to. If anything cancels the
    // debounce after the timer has fired but before its async body reaches the
    // barrier, the generation moves and the body drops out — clearTimeout alone
    // cannot do that, and that gap is exactly how an upsert used to land AFTER
    // a submit.
    const gen = this.debounceGen.get(doc.id) ?? 0;
    this.debouncers.set(
      doc.id,
      setTimeout(() => {
        this.debouncers.delete(doc.id);
        void this.enqueueUpsertFor(doc.id, gen).then((appended) => {
          if (appended && this.deps.isOnline()) void this.flush();
        });
      }, this.deps.debounceMs),
    );
  }

  /**
   * Cancel any pending debounce for an order AND invalidate one that has
   * already fired. Bumping the generation is the half clearTimeout cannot do.
   */
  private cancelDebounce(orderId: string): void {
    const t = this.debouncers.get(orderId);
    if (t) {
      clearTimeout(t);
      this.debouncers.delete(orderId);
    }
    this.debounceGen.set(orderId, (this.debounceGen.get(orderId) ?? 0) + 1);
  }

  /** Cancel the pending debounce and enqueue the upsert immediately. */
  async flushCartNow(orderId: string): Promise<void> {
    this.cancelDebounce(orderId);
    // Deliberately ungated: this is a direct, synchronous-intent request from a
    // caller that is not racing itself (holdOrder), not a stale timer.
    await this.enqueueUpsertFor(orderId);
  }

  /**
   * @param gen when given, the debounce generation this call belongs to; the
   *        call is abandoned if the generation has moved on since.
   * @returns whether an op was actually appended.
   */
  private async enqueueUpsertFor(orderId: string, gen?: number): Promise<boolean> {
    if (gen !== undefined && (this.debounceGen.get(orderId) ?? 0) !== gen) return false;
    const doc = await this.deps.orders.get(orderId);
    if (!doc || !doc.lines.length || doc.status !== "open") return false;
    // Re-check the generation after the await, then let the barrier itself do
    // the authoritative check: requireOpenOrder re-reads the order INSIDE the
    // transaction, so even a generation check that passes here cannot append an
    // upsert to an order that entered checkout in the meantime.
    if (gen !== undefined && (this.debounceGen.get(orderId) ?? 0) !== gen) return false;
    const res = await this.atomicAppend({
      orderId,
      append: [{ type: "upsert", payload: upsertPayloadFrom(doc) }],
      replaceTrailingUpsert: true,
      requireOpenOrder: true,
    });
    return res.rejected === null;
  }

  /**
   * Append an op. When replaceTrailingUpsert is set and the LAST queued op for
   * this order is an 'upsert', it is replaced (deleted + re-appended under a
   * NEW opId — the payload changed, so reusing the opId would trip the
   * server's idempotency-content check). Ops for other orders are unaffected.
   *
   * CO-1: the whole read-modify-write now runs inside ONE atomic transaction
   * (see atomicAppend). It used to be four separate awaits, which is what let a
   * debounced upsert and a checkout interleave into
   * `submit-and-sale(seq=n)` BEFORE `upsert(seq=n+1)`.
   */
  async enqueue(
    type: QueueOpType,
    orderId: string,
    payload: Record<string, unknown>,
    opts: { replaceTrailingUpsert?: boolean } = {},
  ): Promise<QueueOp> {
    const res = await this.atomicAppend({
      orderId,
      append: [{ type, payload }],
      replaceTrailingUpsert: opts.replaceTrailingUpsert,
    });
    // Callers of the generic enqueue() (hold/resume/void) are never gated, so
    // an op always comes back; the non-null assertion is the type system
    // catching up with that, not an assumption about the guarded paths.
    return res.appended[0];
  }

  /**
   * THE critical section. Everything that decides queue ORDER goes through
   * here, and nothing else may allocate a seq.
   *
   * Runs as a single transaction over orders+queue+meta, so between the read of
   * the queue and the write of the new ops no other caller — in this tab or
   * another one — can interleave. `decide` below is synchronous by IndexedDB's
   * transaction contract; every input it needs is prefetched.
   *
   * Guards, all evaluated against state read INSIDE the transaction rather than
   * against a snapshot that may already be stale by the time we write:
   *
   *   requireOpenOrder  — refuse to append an upsert once the order has left
   *                       'open'. This is invariant 2, and it is what makes a
   *                       debounce that fired just before checkout HARMLESS:
   *                       it loses the race and is dropped, instead of
   *                       appending an upsert after the submit.
   *   rejectIfCheckedOut— refuse a second checkout for an order that already
   *                       has one queued (invariant 3 — a double-tap on Pay).
   *   setOrder          — write the order doc in the SAME transaction, so
   *                       "mark submitted" and "queue the submit" cannot be
   *                       observed apart.
   */
  private async atomicAppend(spec: {
    orderId: string;
    append: Array<{ type: QueueOpType; payload: Record<string, unknown> }>;
    replaceTrailingUpsert?: boolean;
    requireOpenOrder?: boolean;
    rejectIfCheckedOut?: boolean;
    setOrder?: LocalOrder;
  }): Promise<{ appended: QueueOp[]; rejected: null | "not-open" | "already-checked-out" }> {
    // Ordering must not depend on an accident. Without this the repair happened
    // to run first only because openDb() memoizes one promise, .then callbacks
    // fire FIFO, and IndexedDB serializes by transaction-creation order — three
    // implementation details, none of them a barrier. Wait for it explicitly.
    await this.seqReady;
    const out = await this.deps.atomic.transact(
      ORDER_TX,
      { all: ["queue"], keys: [["orders", spec.orderId]] },
      (txn: AtomicTxn) => {
        const all = txn.getAll<QueueOp>("queue");
        const mine = all.filter((o) => o.orderId === spec.orderId).sort((a, b) => a.seq - b.seq);

        if (spec.rejectIfCheckedOut) {
          // Two independent ways an order is already checked out, and the queue
          // only knows the first: once the drain has CONSUMED the checkout op
          // the queue is clean again, so a second tap on Pay would sail past
          // every guard and start a whole second sale. The stored doc is the
          // durable half of the answer.
          const doc = txn.get<LocalOrder>("orders", spec.orderId);
          const sealed = doc && doc.status !== "open" && doc.status !== "held";
          if (sealed || mine.some((o) => o.type === "submit-and-sale")) {
            return { appended: [] as QueueOp[], rejected: "already-checked-out" as const, count: all.length };
          }
        }
        if (spec.requireOpenOrder) {
          const doc = txn.get<LocalOrder>("orders", spec.orderId);
          if (!doc || doc.status !== "open") {
            return { appended: [] as QueueOp[], rejected: "not-open" as const, count: all.length };
          }
          // Belt and braces: even while still nominally 'open', an order that
          // already has a checkout queued must never gain another upsert.
          if (mine.some((o) => o.type === "submit-and-sale")) {
            return { appended: [] as QueueOp[], rejected: "not-open" as const, count: all.length };
          }
        }

        let removed = 0;
        if (spec.replaceTrailingUpsert) {
          const last = mine[mine.length - 1];
          if (last && last.type === "upsert") {
            txn.delete("queue", last.opId);
            removed = 1;
          }
        }

        // Sequence allocation, INSIDE the critical section. Reading the live
        // maximum here — rather than from a counter held in this instance's
        // memory — is what makes two TABS safe: whichever transaction runs
        // second sees the first one's op and allocates above it. A queue that
        // has fully drained restarts at 1, which is harmless precisely because
        // there is then no surviving op left to sort against.
        let seq = all.reduce((m, o) => Math.max(m, o.seq), 0);

        if (spec.setOrder) txn.put("orders", spec.orderId, spec.setOrder);

        const appended: QueueOp[] = spec.append.map((a) => {
          const op: QueueOp = {
            opId: this.deps.newId(),
            type: a.type,
            orderId: spec.orderId,
            payload: a.payload,
            ts: this.deps.now(),
            seq: ++seq,
          };
          txn.put("queue", op.opId, op);
          return op;
        });

        return { appended, rejected: null, count: all.length - removed + appended.length };
      },
    );

    this.queueCount = out.count;
    this.emitStatus();
    return { appended: out.appended, rejected: out.rejected };
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
    // cancelDebounce, not a raw clearTimeout: the generation bump is what stops
    // a timer that has ALREADY fired. requireOpenOrder catches the consequence
    // anyway, but leaving one path on the weaker mechanism is how the next
    // refactor reintroduces this.
    this.cancelDebounce(doc.id);
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

    // Cancel the debounce BEFORE the barrier, and bump the generation so a
    // callback that has ALREADY fired (clearTimeout cannot un-fire it — this is
    // the window the 404 came through) finds itself stale and refuses to write.
    this.cancelDebounce(doc.id);

    // ONE transaction: mark the order submitted, append its FINAL upsert, and
    // append the submit-and-sale — in that order, with sequence numbers issued
    // inside the same critical section. Nothing can interleave between them, so
    // the submit can never precede the upsert that creates the order server-side.
    //
    // rejectIfCheckedOut makes a double-tap on Pay a no-op rather than a second
    // sale: the second call sees the first call's queued checkout and returns.
    const append: Array<{ type: QueueOpType; payload: Record<string, unknown> }> = [];
    if (submitted.lines.length) append.push({ type: "upsert", payload: upsertPayloadFrom(submitted) });
    append.push({
      type: "submit-and-sale",
      payload: {
        payments,
        cashTendered: opts.cashTendered ?? 0,
        changeDue: opts.changeDue ?? 0,
        paymentNotes: opts.paymentNotes ?? undefined,
      },
    });

    const res = await this.atomicAppend({
      orderId: doc.id,
      append,
      replaceTrailingUpsert: true,
      rejectIfCheckedOut: true,
      setOrder: submitted,
    });

    if (res.rejected === "already-checked-out") {
      // Not an error: the first tap owns this checkout. Report its outcome
      // rather than starting a second one.
      const existing = await this.deps.orders.get(doc.id);
      if (existing?.status === "completed") {
        return { state: "completed", invoiceNumber: existing.invoiceNumber, saleId: existing.saleId, zatcaQrDataUrl: existing.zatcaQrDataUrl ?? null };
      }
      if (this.deps.isOnline()) await this.flush();
      const settled = await this.deps.orders.get(doc.id);
      if (settled?.status === "completed") {
        return { state: "completed", invoiceNumber: settled.invoiceNumber, saleId: settled.saleId, zatcaQrDataUrl: settled.zatcaQrDataUrl ?? null };
      }
      return { state: "queued", invoiceNumber: null, saleId: null };
    }

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
  /**
   * Drain the queue, and — this is the part that matters — RESOLVE ONLY WHEN A
   * DRAIN THAT STARTED AFTER THIS CALLER'S OPS WERE ENQUEUED HAS FINISHED.
   *
   * This used to return immediately whenever another drain was in flight:
   *
   *     if (this.syncing) { this.pendingFlush = true; return; }
   *
   * so `await flush()` was a lie. checkout() awaits flush() and then reads the
   * order to decide what to tell the cashier; when a debounced upsert's own
   * `void flush()` happened to be mid-drain, checkout's await returned at once,
   * the doc was still 'submitted', and checkout reported
   *
   *     "Order saved — will sync when the connection returns"
   *
   * for a sale that submitted, posted and completed successfully milliseconds
   * later. The cashier is told a completed payment is pending.
   *
   * It was always latent. The CO-1 barrier made it frequent — checkout now
   * queues behind the debounce's critical section, so it lands squarely inside
   * the window where that debounce's flush is still running. Found by the same
   * regression run that proved the 404 fixed, which is exactly what the run is
   * for.
   *
   * Flushes are now serialized through a promise chain, so a caller's await
   * covers its own ops by construction.
   */
  async flush(): Promise<void> {
    const run = this.flushChain.then(() => this.drainQueue());
    // Keep the chain alive on failure, or one rejected drain would wedge every
    // later flush for the lifetime of the tab.
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async drainQueue(): Promise<void> {
    await this.seqReady;
    if (this.repairFailed) {
      // Fail closed: draining a queue whose ordering was never repaired is how
      // the 404 becomes permanent on a legacy device.
      this.emitStatus();
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
        // Orders whose earlier op failed PERMANENTLY in this drain. The
        // ordering barrier guarantees the upsert is queued BEFORE the checkout,
        // but it cannot make the upsert succeed: when one fails permanently the
        // batch branch deletes it so the queue never jams, and the drain then
        // walked straight on to that order's submit-and-sale — POSTing /submit
        // for an order the server had just refused to create. That is the SAME
        // 404, reachable with no concurrency whatsoever, and it is why fixing
        // ordering alone was not enough.
        const failedOrders = new Set<string>();
        while (i < ops.length && !stopped) {
          if (op_isCheckout(ops[i])) {
            if (failedOrders.has(ops[i].orderId)) {
              await this.failCheckoutAfterPrerequisite(ops[i], reports);
              i++;
              continue;
            }
            stopped = await this.runCheckoutOp(ops[i], cursor, reports);
            i++;
          } else {
            const batch: QueueOp[] = [];
            while (i < ops.length && !op_isCheckout(ops[i])) {
              batch.push(ops[i]);
              i++;
            }
            stopped = await this.runSyncBatch(batch, cursor, reports, failedOrders);
          }
        }
      }
    } finally {
      if (reports.length) this.lastReport = { at: this.deps.now(), results: reports };
      this.queueCount = (await this.deps.queue.getAll().catch(() => [] as QueueOp[])).length;
      this.syncing = false;
      this.emitStatus();
      if (reports.length) this.emitEvent({ type: "toast", kind: "info", message: syncSummaryText(reports) });
    }
  }

  /** Returns true when the flush must STOP (transient failure — order preserved). */
  private async runSyncBatch(
    batch: QueueOp[],
    cursor: Map<string, number | null>,
    reports: SyncOpReport[],
    failedOrdersOut?: Set<string>,
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
      // Envelope-level rejection (auth, or a rejection of the BATCH itself —
      // e.g. too many ops / malformed ops array — which DOES carry a real
      // code+message from the server, unlike a per-op partial failure, which
      // postSync() no longer throws for at all; see api.ts's
      // allowPartialSuccess). Stop without dropping ops; surface once.
      this.emitEvent({ type: "toast", kind: "error", message: this.toastMessage(e) });
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
        // IDEMPOTENCY_CONFLICT…) — drop so the queue never jams. Build an
        // ApiError-shaped object from THIS op's own code/error (this is the
        // per-op detail that used to be unreachable: postSync() previously
        // threw for the whole batch — with the literal message `HTTP 200` —
        // the instant ANY op in it failed, so this branch never ran on a
        // partial failure). Default the code to SERVER_ERROR (never blank)
        // so translateApiError always resolves to a real, meaningful string.
        await this.deps.queue.delete(op.opId);
        // This order's prerequisite is gone for good. Tell the drain, so it
        // does not go on to submit a sale for an order the server refused.
        if (failedOrdersOut) failedOrdersOut.add(op.orderId);
        const opError = new ApiError(200, r.code || "SERVER_ERROR", r.error || "");
        this.emitEvent({ type: "toast", kind: "error", message: this.toastMessage(opError) });
        // …and durably, because the toast is gone before the shift manager
        // ever hears about it and a reload wipes lastReport. Namespaced
        // `sync:` so it cannot collide with the `checkout:` / `legacy:` rows
        // App records from checkout-done; a checkout op is NOT recorded here
        // (it emits checkout-done, which App already logs) so nothing is
        // counted twice.
        recordFailure({
          id: `sync:${op.opId}`,
          kind: "sync",
          orderId: op.orderId,
          code: r.code || "SERVER_ERROR",
          message: this.toastMessage(opError),
        });
      }
    }
    return false;
  }

  /**
   * A checkout whose own upsert failed permanently in this same drain.
   *
   * Submitting anyway is what produced the 404 with no concurrency involved.
   * Nor may it be left queued: the upsert it depends on has been deleted, so it
   * would 404 on every future flush forever. Fail it explicitly, reopen the
   * order, and tell the cashier the truth — the sale did not go through.
   */
  private async failCheckoutAfterPrerequisite(op: QueueOp, reports: SyncOpReport[]): Promise<void> {
    const error = this.t("errors.CHECKOUT_PREREQUISITE_FAILED");
    const message = error === "errors.CHECKOUT_PREREQUISITE_FAILED"
      ? "تعذّر حفظ الطلب على الخادم، فلم تُنفَّذ عملية الدفع — أعد المحاولة"
      : error;
    reports.push({ opId: op.opId, type: op.type, orderId: op.orderId, ok: false, code: "CHECKOUT_PREREQUISITE_FAILED", error: message });
    await this.deps.queue.delete(op.opId);
    const doc = await this.deps.orders.get(op.orderId);
    if (doc) {
      doc.status = "open";
      doc.updatedAt = this.deps.now();
      await this.deps.orders.put(doc.id, doc);
    }
    this.emitEvent({ type: "checkout-done", orderId: op.orderId, ok: false, queued: false, invoiceNumber: null, saleId: null, error: message });
    this.emitEvent({ type: "toast", kind: "error", message });
  }

  /** After a conflict every later queued op for that order is doomed — drop them. */
  private async dropOpsFor(orderId: string, exceptBatch: QueueOp[], reports: SyncOpReport[]): Promise<void> {
    const remaining = (await this.deps.queue.getAll()).filter((o) => o.orderId === orderId);
    for (const o of remaining) {
      if (exceptBatch.some((b) => b.opId === o.opId)) continue;
      // A version conflict on an UPSERT must never destroy the cashier's queued
      // offline SALE. Dropping it reported «أُسقطت بعد تعارض النسخ» and the
      // money simply vanished — a far worse outcome than replaying a submit,
      // which is idempotent by opId anyway.
      if (o.type === "submit-and-sale") continue;
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
    const fail = async (e: unknown): Promise<void> => {
      const code = e instanceof ApiError ? e.code : undefined;
      const error = this.toastMessage(e);
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
      // CO-1 follow-on. The atomic barrier serializes ENQUEUE, but no
      // transaction can span three network calls, so the DRAIN is still
      // per-instance: flush()'s `syncing` guard belongs to one tab, while the
      // 'online' event and the 30s interval fire in EVERY tab at once.
      //
      // When two tabs drain the same checkout op, both POST /submit with the
      // same Idempotency-Key. The server answers the loser with
      // IDEMPOTENCY_CONFLICT (routes/pos-v2.js — «طلب إرسال مكرر»), an ApiError,
      // so isNetworkError is false and this used to fall straight into fail():
      // the op was deleted and the order reverted to 'open' WHILE THE OTHER TAB
      // WAS COMPLETING THE SALE. The cashier saw a failed checkout for a payment
      // that actually went through — the same class of lie as the 404 this
      // release fixes, in the same money path.
      //
      // It is not a domain failure; it means "this exact op is already in
      // flight". Retrying is safe precisely BECAUSE it is idempotent — the
      // server's replay branch returns the original response. Guarded on saleId
      // so a conflict arriving after this device already recorded the sale still
      // falls through to fail() instead of looping forever.
      if (e instanceof ApiError && e.code === "IDEMPOTENCY_CONFLICT") {
        const local = await this.deps.orders.get(orderId);
        if (!local?.saleId) return true; // transient — replay on the next flush
      }
      await fail(e);
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
      await fail(e);
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
      const code = e instanceof ApiError ? e.code : undefined;
      const message = this.toastMessage(e);
      reports.push({ opId: op.opId, type: op.type, orderId, ok: false, code, error: message });
      await this.deps.queue.delete(op.opId);
      this.emitEvent({ type: "toast", kind: "error", message: "تم تسجيل البيع لكن تعذّر إكمال الطلب: " + message });
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
      atomic: idbAtomicRunner(),
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
