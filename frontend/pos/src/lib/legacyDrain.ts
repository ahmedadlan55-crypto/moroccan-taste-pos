/**
 * Legacy offline-queue drain — one-way migration of sales the OLD cashier
 * (/pos, public/pos/app.js v7.3) queued while offline.
 *
 * Verified legacy contract (public/pos/app.js ~line 1110 + /shared/api-bridge.js):
 *   • localStorage key `pos_offline_queue` holds ONE JSON array.
 *   • Each entry: { order, user, shiftId, ts } — `order` is already the exact
 *     legacy /api/sales body (items, totals, paymentMethod, …) and carries the
 *     idempotency key `order.clientOrderId`; `user` is the username string.
 *   • Replay = POST /api/sales with { ...order, username: user, shiftId }
 *     (api-bridge `saveOrder` mapping). The backend's UNIQUE
 *     sales.client_order_id makes replay safe — a sale that already reached
 *     the server dedupes (res.idempotent / existing orderId), never doubles.
 *   • Success signal (mirrors legacy _posOQSync): res.success === true ||
 *     res.idempotent || res.orderId.
 *
 * Drain policy (STRICTER than legacy): only successfully-synced entries are
 * removed. Domain rejections (success:false), transport failures AND malformed
 * entries all STAY in localStorage and are surfaced in the report — never
 * silently dropped (legacy dropped rejects; a migration must not).
 * A transport failure stops the run (the rest would fail the same way).
 *
 * Dependencies are injected so vitest can run the drain against a fake
 * storage + scripted fetch (src/lib/__tests__/legacyDrain.test.ts).
 */

export const LEGACY_QUEUE_KEY = "pos_offline_queue";

export interface LegacyQueueEntry {
  order: { clientOrderId: string } & Record<string, unknown>;
  user?: unknown;
  shiftId?: unknown;
  ts?: number;
}

interface ParsedEntry {
  /** The raw entry exactly as stored (written back verbatim when retained). */
  raw: unknown;
  /** Validated entry, or null when the record is malformed. */
  entry: LegacyQueueEntry | null;
}

export interface DrainOutcome {
  /** Entries found in the legacy queue when the drain started. */
  attempted: number;
  succeeded: Array<{ clientOrderId: string; orderId: string | null }>;
  failed: Array<{ clientOrderId: string | null; error: string }>;
  /** Entries still in localStorage after the drain (failures + untried). */
  remaining: number;
}

export interface DrainDeps {
  storage: Pick<Storage, "getItem" | "setItem">;
  fetchFn: typeof fetch;
  getToken: () => string | null;
  isOnline: () => boolean;
}

/** Parse the raw localStorage value; malformed JSON → empty (nothing to drain,
 *  nothing destroyed — the raw value is left untouched in storage). */
export function parseLegacyQueue(raw: string | null): ParsedEntry[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => ({ raw: item, entry: validateEntry(item) }));
}

function validateEntry(item: unknown): LegacyQueueEntry | null {
  if (!item || typeof item !== "object") return null;
  const e = item as Record<string, unknown>;
  const order = e.order;
  if (!order || typeof order !== "object") return null;
  const clientOrderId = (order as Record<string, unknown>).clientOrderId;
  if (typeof clientOrderId !== "string" || !clientOrderId.trim()) return null;
  return e as unknown as LegacyQueueEntry;
}

/** True when the legacy /api/sales response means "this sale is on the server"
 *  (fresh insert OR clientOrderId-deduped replay) — mirrors legacy _posOQSync. */
function isSaleAccepted(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.success === true || b.idempotent === true || !!b.orderId;
}

/** Count of entries currently sitting in the legacy queue (0 on any error). */
export function legacyQueueCount(storage: Pick<Storage, "getItem"> | null = defaultStorage()): number {
  try {
    if (!storage) return 0;
    return parseLegacyQueue(storage.getItem(LEGACY_QUEUE_KEY)).length;
  } catch {
    return 0;
  }
}

export async function drainLegacyQueue(deps: DrainDeps): Promise<DrainOutcome> {
  const outcome: DrainOutcome = { attempted: 0, succeeded: [], failed: [], remaining: 0 };

  let rawValue: string | null = null;
  try {
    rawValue = deps.storage.getItem(LEGACY_QUEUE_KEY);
  } catch {
    return outcome; // storage unreadable — nothing safe to do
  }
  const parsed = parseLegacyQueue(rawValue);
  outcome.attempted = parsed.length;
  if (!parsed.length) return outcome;

  if (!deps.isOnline()) {
    // Boot while offline — touch nothing; the queue drains on a later boot.
    outcome.remaining = parsed.length;
    return outcome;
  }

  const retained: unknown[] = [];
  let transportDown = false;

  for (const { raw, entry } of parsed) {
    if (transportDown) {
      retained.push(raw); // untried — a dead network fails them all the same way
      continue;
    }
    if (!entry) {
      retained.push(raw);
      outcome.failed.push({ clientOrderId: null, error: "سجل غير صالح — يتعذّر إرساله" });
      continue;
    }

    const body = {
      ...entry.order,
      username: typeof entry.user === "string" ? entry.user : undefined,
      shiftId: entry.shiftId ?? undefined,
    };

    try {
      const token = deps.getToken();
      const res = await deps.fetchFn("/api/sales", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      let resBody: unknown = null;
      try {
        resBody = await res.json();
      } catch {
        resBody = null;
      }
      if (isSaleAccepted(resBody)) {
        const b = resBody as Record<string, unknown>;
        outcome.succeeded.push({
          clientOrderId: entry.order.clientOrderId,
          orderId: typeof b.orderId === "string" || typeof b.orderId === "number" ? String(b.orderId) : null,
        });
      } else {
        // Domain rejection (closed shift, validation, 4xx/5xx…) — keep + surface.
        const err =
          (resBody && typeof resBody === "object" && typeof (resBody as Record<string, unknown>).error === "string"
            ? String((resBody as Record<string, unknown>).error)
            : "") || `رفض الخادم (HTTP ${res.status})`;
        retained.push(raw);
        outcome.failed.push({ clientOrderId: entry.order.clientOrderId, error: err });
      }
    } catch (e) {
      // Transport failure — connection died mid-drain. Keep this and the rest.
      transportDown = true;
      retained.push(raw);
      outcome.failed.push({
        clientOrderId: entry.order.clientOrderId,
        error: "انقطع الاتصال أثناء المزامنة — سيُعاد لاحقًا",
      });
    }
  }

  // Persist ONLY the non-synced entries (verbatim), exactly like legacy writes.
  try {
    deps.storage.setItem(LEGACY_QUEUE_KEY, JSON.stringify(retained));
  } catch {
    /* quota — entries already synced stay deduped by clientOrderId anyway */
  }
  outcome.remaining = retained.length;
  return outcome;
}

// ── Boot wrapper + status store (Header chip / report dialog) ────────────────

export interface DrainStatus {
  state: "idle" | "running" | "done";
  outcome: DrainOutcome | null;
  /** Live count of legacy entries still queued locally. */
  pending: number;
}

let drainStatus: DrainStatus = { state: "idle", outcome: null, pending: 0 };
const drainListeners = new Set<() => void>();
let started = false;

function setDrainStatus(patch: Partial<DrainStatus>): void {
  drainStatus = { ...drainStatus, ...patch };
  drainListeners.forEach((fn) => fn());
}

export function subscribeDrain(fn: () => void): () => void {
  drainListeners.add(fn);
  return () => drainListeners.delete(fn);
}

export function getDrainStatus(): DrainStatus {
  return drainStatus;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Run the drain once per app boot (StrictMode-safe). Online only; when the
 * app boots offline a one-shot 'online' listener retries. Returns null when
 * there was nothing to do (no queue / offline with empty queue / already ran).
 */
export async function runLegacyDrainOnce(): Promise<DrainOutcome | null> {
  if (started || typeof window === "undefined") return null;
  started = true;

  const storage = defaultStorage();
  if (!storage) return null;
  setDrainStatus({ pending: legacyQueueCount(storage) });
  if (drainStatus.pending === 0) return null;

  if (!navigator.onLine) {
    // Try again the moment connectivity returns (once).
    window.addEventListener(
      "online",
      () => {
        started = false;
        void runLegacyDrainOnce();
      },
      { once: true },
    );
    return null;
  }

  setDrainStatus({ state: "running" });
  const { getToken } = await import("./auth"); // lazy — keeps this module storage-only for tests
  const outcome = await drainLegacyQueue({
    storage,
    fetchFn: (...args) => fetch(...args),
    getToken,
    isOnline: () => navigator.onLine,
  });
  setDrainStatus({ state: "done", outcome, pending: outcome.remaining });
  return outcome;
}
