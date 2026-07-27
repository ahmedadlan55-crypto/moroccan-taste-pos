/**
 * Durable failure log — "which sale failed, and why", surviving a reload.
 *
 * THE PROBLEM. When a queued sale fails PERMANENTLY the engine deletes its op
 * (so the queue never jams), fires one toast, and records the outcome in
 * `EngineStatus.lastReport` — an in-memory field on the singleton. A reload,
 * a kiosk auto-update, or simply the next flush overwriting `lastReport` wipes
 * it. A shift manager arriving an hour later has NO way to find out that a sale
 * was lost, let alone which one or why.
 *
 * WHY localStorage AND NOT IndexedDB. `lib/idb.ts` has a fixed schema and a
 * fixed version; adding a store means bumping `DB_VERSION`, which triggers an
 * `onupgradeneeded` on a LIVE PWA that may be holding queued sales mid-flight.
 * That is a real risk to real money, and a diagnostics log is nowhere near
 * worth it. localStorage is synchronous, needs no migration, and a log that is
 * lost in private-browsing mode is exactly as bad as the log we have today.
 *
 * CONTRACT. Every entry point is total and never throws: storage disabled,
 * quota exceeded, corrupt JSON, a hand-edited array of nulls — all degrade to
 * "no log", never to a crash on the sell path. Corrupt JSON reads as an EMPTY
 * log rather than being partially salvaged: half a failure record is a lie a
 * manager would act on.
 *
 * Bounded at MAX_ENTRIES (a ring buffer by recency) so a till that has been
 * failing for a week cannot fill the origin's storage quota and take the
 * catalog cache down with it.
 */

/** localStorage key. Namespaced `pos_v2_` like every other key this app owns. */
const STORAGE_KEY = "pos_v2_failure_log";

/** Ring-buffer capacity. Oldest entries fall off the end. */
export const MAX_ENTRIES = 50;

/** Hard cap on any single stored string, so one pathological server message
 *  cannot consume the whole budget. */
const MAX_TEXT = 300;

/** What kind of operation died. Kept as a small closed set so the UI can group
 *  and translate; anything unrecognised normalises to "other". */
export type FailureKind = "checkout" | "sync" | "legacy-drain" | "other";

const KINDS: ReadonlySet<string> = new Set<FailureKind>(["checkout", "sync", "legacy-drain", "other"]);

export interface FailureEntry {
  /** Stable identity. Pass the queue `opId` wherever one exists: recording the
   *  same failure twice (App's `checkout-done` listener AND an engine-side
   *  call) then UPDATES one row instead of duplicating it. */
  id: string;
  /** Epoch ms the failure was recorded. */
  at: number;
  kind: FailureKind;
  /** POS order id (ULID) — null when the failure isn't tied to one. */
  orderId: string | null;
  /** Whatever names this sale to a HUMAN: invoice number, legacy
   *  clientOrderId, table… Shown verbatim, never parsed. */
  reference: string | null;
  /** Server/domain error code (`VALIDATION_ERROR`, `SHIFT_CLOSED`, …). */
  code: string | null;
  /** Already-translated, human-readable reason. */
  message: string;
  /** Who was on the till. */
  cashier: string | null;
  /** Order total in SAR, when known — a manager needs the size of the hole. */
  total: number | null;
}

/** Everything except `at`/`id` is optional; both are filled in when absent. */
export interface FailureInput {
  id?: string | null;
  at?: number | null;
  kind?: string | null;
  orderId?: string | null;
  reference?: string | null;
  code?: string | null;
  message?: string | null;
  cashier?: string | null;
  total?: number | null;
}

// ── Internals ───────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

/**
 * Parsed snapshot. useSyncExternalStore requires getSnapshot to return a
 * REFERENTIALLY STABLE value between changes — re-parsing localStorage on
 * every render would hand React a brand-new array each time and spin forever.
 * Invalidated by every write and by another tab's `storage` event.
 */
let cache: FailureEntry[] | null = null;

/** Monotonic tiebreaker so two failures recorded in the same millisecond with
 *  no caller-supplied id still get distinct keys. */
let seq = 0;

function clampText(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeKind(v: unknown): FailureKind {
  return typeof v === "string" && KINDS.has(v) ? (v as FailureKind) : "other";
}

/**
 * Shape validation for a value read back from storage. Returns null for
 * anything that isn't a usable record — an entry missing its timestamp or its
 * message would render as a blank row that tells a manager nothing.
 */
function validate(raw: unknown): FailureEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = clampText(o.id, 64);
  const at = typeof o.at === "number" && Number.isFinite(o.at) && o.at > 0 ? o.at : null;
  const message = clampText(o.message);
  if (!id || at == null || !message) return null;
  const total = typeof o.total === "number" && Number.isFinite(o.total) ? o.total : null;
  return {
    id,
    at,
    kind: normalizeKind(o.kind),
    orderId: clampText(o.orderId, 64),
    reference: clampText(o.reference, 64),
    code: clampText(o.code, 64),
    message,
    cashier: clampText(o.cashier, 64),
    total,
  };
}

/** Read + validate straight from storage. Never throws; corrupt → []. */
function readRaw(): FailureEntry[] {
  try {
    const txt = localStorage.getItem(STORAGE_KEY);
    if (!txt) return [];
    const parsed: unknown = JSON.parse(txt);
    if (!Array.isArray(parsed)) return [];
    const out: FailureEntry[] = [];
    for (const item of parsed) {
      const entry = validate(item);
      if (entry) out.push(entry);
    }
    // Newest first is the only order the UI ever wants, and sorting HERE means
    // a hand-edited or legacy file can't render out of order.
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, MAX_ENTRIES);
  } catch {
    // Corrupt JSON, storage disabled, SecurityError in a sandboxed frame —
    // all mean "no log", never a crash.
    return [];
  }
}

function persist(entries: FailureEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded / private mode. The in-memory cache below still serves
    // this session, so the failure is at least visible until the tab closes.
  }
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Snapshot of the log, NEWEST FIRST. Safe to call from render and from
 * useSyncExternalStore: the same array identity comes back until something
 * actually changes.
 */
export function readFailures(): FailureEntry[] {
  if (cache === null) cache = readRaw();
  return cache;
}

/**
 * Append (or, when `id` matches an existing row, UPDATE) one failure.
 *
 * Upsert rather than push because the same permanent failure is legitimately
 * observable from two places — App.tsx's `checkout-done` listener and any
 * engine-side call the merge owner wires into `lib/offline.ts`. Keying both on
 * the queue `opId` makes the second one idempotent instead of a duplicate row
 * that inflates the count a manager reads.
 *
 * @returns the stored entry, or null when the input carried no usable message.
 */
export function recordFailure(input: FailureInput): FailureEntry | null {
  const at = typeof input.at === "number" && Number.isFinite(input.at) && input.at > 0 ? input.at : Date.now();
  const id = clampText(input.id, 64) ?? `f${at.toString(36)}-${(seq++).toString(36)}`;
  const candidate = validate({ ...input, id, at, message: clampText(input.message) });
  if (!candidate) return null; // nothing meaningful to say — don't store a blank row

  const current = readFailures();
  const without = current.filter((e) => e.id !== candidate.id);
  const next = [candidate, ...without].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
  cache = next;
  persist(next);
  notify();
  return candidate;
}

/** Wipe the log. Supervisor-gated at the call site (SyncReportDialog). */
export function clearFailures(): void {
  cache = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — the cleared cache still hides it for this session */
  }
  notify();
}

/**
 * Subscribe to changes. useSyncExternalStore-shaped: returns an unsubscribe.
 *
 * The FIRST subscriber also attaches a `storage` listener, so a failure logged
 * in another tab of the same till shows up here without a reload — two tabs on
 * one terminal is a normal way this POS is used, and both drain the queue.
 */
export function subscribeFailures(fn: () => void): () => void {
  listeners.add(fn);
  attachStorageListener();
  return () => {
    listeners.delete(fn);
  };
}

let storageListenerAttached = false;
function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === "undefined" || !window.addEventListener) return;
  storageListenerAttached = true;
  window.addEventListener("storage", (e: StorageEvent) => {
    // e.key === null is a whole-storage clear(); either way our snapshot is stale.
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    cache = null;
    notify();
  });
}

/** Test-only reset of the module-level snapshot cache. Production code never
 *  needs this — every mutation invalidates the cache itself. */
export function __resetFailureLogCacheForTests(): void {
  cache = null;
  seq = 0;
}
