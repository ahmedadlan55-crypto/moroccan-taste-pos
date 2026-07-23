/**
 * Tiny promise-based IndexedDB wrapper — no external dependency.
 * Stores: 'catalog' (single doc + etag), 'orders' (LocalOrder by ULID),
 * 'queue' (FIFO ops by opId), 'imageManifest' (offline item-image cache
 * bookkeeping — see src/lib/offlineImages.ts).
 */

const DB_NAME = "pos-v2";
// v2 (Owner I — offline image cache): adds the 'imageManifest' store, with
// 'branchId' + 'lastAccess' indices so offlineImages.ts can bulk-clear a
// branch's rows and LRU-evict the oldest ones without a full table scan.
//
// CO-1 deliberately did NOT bump this. The checkout-ordering fix first carried
// a 'meta' store for a durable sequence counter, which would have required
// v3 — and a version bump here is far more dangerous than it looks: openDb()
// memoizes dbPromise and never clears it on rejection, onblocked rejects, and
// (before the handler added below) nothing closed an old connection on
// versionchange. A cashier with a v2 tab still open would have blocked the
// upgrade indefinitely, permanently poisoning the new tab's dbPromise and
// leaving a POS with no storage at all.
//
// It turned out the counter was unnecessary: seq is allocated as
// max(live queue) + 1 INSIDE the serialized transaction, so two allocators can
// never collide, and a queue that drains to empty has no surviving op left to
// misorder. Zero schema change, zero migration, invariant 5 satisfied trivially.
const DB_VERSION = 2;
export const STORES = ["catalog", "orders", "queue"] as const;
export type StoreName = (typeof STORES)[number];

/** Object store name for image-cache bookkeeping (out-of-line key — see
 *  imageManifestKey below — same shape as the other stores). Kept OUT of
 *  StoreName/STORES: the generic idbGet/idbPut helpers below call
 *  `store.get(key)` / `store.put(value, key)`, and this store is queried by
 *  index (branchId, lastAccess) instead, via the dedicated functions further
 *  down — mixing the two access styles on one store name would be confusing. */
const IMAGE_MANIFEST_STORE = "imageManifest";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (!db.objectStoreNames.contains(IMAGE_MANIFEST_STORE)) {
        const store = db.createObjectStore(IMAGE_MANIFEST_STORE);
        store.createIndex("branchId", "branchId", { unique: false });
        store.createIndex("lastAccess", "lastAccess", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Without this, an OLDER tab holding this connection blocks any future
      // version upgrade forever (the newer tab's open() fires onblocked and its
      // memoized dbPromise stays permanently rejected — a cashier tab with no
      // storage at all). Closing on request lets the upgrade proceed; the next
      // call to openDb() in this tab simply reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      // Never memoize a REJECTED promise: a single transient failure (quota
      // prompt, private-mode quirk) would otherwise make every later call fail
      // for the lifetime of the tab.
      dbPromise = null;
      reject(req.error ?? new Error("indexedDB open failed"));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("indexedDB open blocked"));
    };
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("idb request failed"));
      }),
  );
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbPut<T>(store: StoreName, key: string, value: T): Promise<void> {
  return tx(store, "readwrite", (s) => s.put(value, key)).then(() => undefined);
}

export function idbDelete(store: StoreName, key: string): Promise<void> {
  return tx(store, "readwrite", (s) => s.delete(key)).then(() => undefined);
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbClear(store: StoreName): Promise<void> {
  return tx(store, "readwrite", (s) => s.clear()).then(() => undefined);
}

/**
 * KV abstraction used by the offline engine so tests can swap in an
 * in-memory Map (see src/lib/__tests__/offline.test.ts).
 */
export interface KVStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  getAll(): Promise<T[]>;
}

export function idbStore<T>(name: StoreName): KVStore<T> {
  return {
    get: (k) => idbGet<T>(name, k),
    put: (k, v) => idbPut(name, k, v),
    delete: (k) => idbDelete(name, k),
    getAll: () => idbGetAll<T>(name),
  };
}

export function memoryStore<T>(seed?: Map<string, T>): KVStore<T> {
  const map = seed ?? new Map<string, T>();
  return {
    get: async (k) => map.get(k),
    put: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
    getAll: async () => [...map.values()],
  };
}

// ─── CO-1 — the atomic critical section ─────────────────────────────────────
//
// The offline engine used to build queue ops with a plain
// `getAll() -> decide -> ++inMemoryCounter -> put()` sequence. Every one of
// those steps is an await, so two callers (a 600ms debounce firing while
// checkout runs) interleave freely, and the engine reached the state
//
//     submit-and-sale(seq = n)   BEFORE   upsert(seq = n + 1)
//
// which makes the drain POST /submit for an order the server has never seen →
// 404 «الطلب غير موجود» → the payment fails. An in-memory mutex cannot fix
// this: the counter is per-instance, so two TABS still collide, and it does not
// survive a reload.
//
// IndexedDB already provides exactly the primitive needed — a readwrite
// transaction is serialized against every other readwrite transaction on the
// same stores, in the same browser, across tabs. So the critical section
// becomes one transaction spanning 'orders' + 'queue' + 'meta'.
//
// HARD CONTRACT: `decide` is SYNCHRONOUS. An IndexedDB transaction
// auto-commits as soon as control returns to the event loop with no pending
// request against it, so awaiting anything inside `decide` would silently
// close the transaction and the writes would throw TransactionInactiveError.
// Everything `decide` needs is therefore PREFETCHED before it is called.

export interface AtomicTxn {
  /** Snapshot of every row in a prefetched store, taken inside this txn. */
  getAll<T>(store: StoreName): T[];
  /** A prefetched single row. */
  get<T>(store: StoreName, key: string): T | undefined;
  put<T>(store: StoreName, key: string, value: T): void;
  delete(store: StoreName, key: string): void;
}

export interface AtomicPrefetch {
  /** Stores to snapshot in full. */
  all?: StoreName[];
  /** Individual [store, key] rows to snapshot. */
  keys?: Array<[StoreName, string]>;
}

/** Runs `decide` inside ONE readwrite IndexedDB transaction. See the contract above. */
export interface AtomicRunner {
  transact<R>(stores: StoreName[], prefetch: AtomicPrefetch, decide: (txn: AtomicTxn) => R): Promise<R>;
}

export function idbAtomicRunner(): AtomicRunner {
  return {
    transact<R>(stores: StoreName[], prefetch: AtomicPrefetch, decide: (txn: AtomicTxn) => R): Promise<R> {
      return openDb().then(
        (db) =>
          new Promise<R>((resolve, reject) => {
            const t = db.transaction(stores, "readwrite");
            const allSnap = new Map<StoreName, unknown[]>();
            const keySnap = new Map<string, unknown>();
            const wanted = (prefetch.all?.length ?? 0) + (prefetch.keys?.length ?? 0);
            let got = 0;
            let outcome: R;
            let decided = false;

            const maybeDecide = (): void => {
              if (decided || got < wanted) return;
              decided = true;
              // Synchronous by contract — see above.
              outcome = decide({
                getAll: <T,>(s: StoreName) => (allSnap.get(s) ?? []) as T[],
                get: <T,>(s: StoreName, k: string) => keySnap.get(`${s} ${k}`) as T | undefined,
                put: <T,>(s: StoreName, k: string, v: T) => {
                  t.objectStore(s).put(v, k);
                },
                delete: (s: StoreName, k: string) => {
                  t.objectStore(s).delete(k);
                },
              });
              // The contract is easy to break silently: one `await` inside
              // `decide` — or a helper that quietly becomes async — tears the
              // critical section (writes before the await commit, writes after
              // throw) and every guarantee evaporates with no error. Fail loudly.
              if (outcome && typeof (outcome as { then?: unknown }).then === "function") {
                throw new Error("idbAtomicRunner: decide() must be synchronous — it returned a thenable, which tears the transaction");
              }
            };

            for (const s of prefetch.all ?? []) {
              const r = t.objectStore(s).getAll();
              r.onsuccess = () => {
                allSnap.set(s, r.result as unknown[]);
                got++;
                maybeDecide();
              };
            }
            for (const [s, k] of prefetch.keys ?? []) {
              const r = t.objectStore(s).get(k);
              r.onsuccess = () => {
                keySnap.set(`${s} ${k}`, r.result);
                got++;
                maybeDecide();
              };
            }
            if (wanted === 0) maybeDecide();

            t.oncomplete = () => resolve(outcome);
            t.onerror = () => reject(t.error ?? new Error("idb transaction failed"));
            t.onabort = () => reject(t.error ?? new Error("idb transaction aborted"));
          }),
      );
    },
  };
}

/**
 * In-memory AtomicRunner for tests.
 *
 * Serialized through a single promise chain, which is what makes the
 * interleaving tests meaningful: `gate` is awaited between the prefetch and
 * `decide`, so a test can hold one critical section open at a precise point and
 * drive a second caller into it. Real IndexedDB gives the same mutual exclusion
 * for free; this reproduces it — including the ordering — without a browser.
 */
export function memoryAtomicRunner(
  stores: Partial<Record<StoreName, KVStore<never>>>,
  gate?: (phase: "before-decide" | "after-decide") => Promise<void> | void,
): AtomicRunner {
  let chain: Promise<unknown> = Promise.resolve();
  const extra = new Map<StoreName, KVStore<unknown>>();
  const storeFor = (s: StoreName): KVStore<unknown> => {
    const injected = stores[s] as KVStore<unknown> | undefined;
    if (injected) return injected;
    let made = extra.get(s);
    if (!made) {
      made = memoryStore<unknown>();
      extra.set(s, made);
    }
    return made;
  };

  return {
    transact<R>(_stores: StoreName[], prefetch: AtomicPrefetch, decide: (txn: AtomicTxn) => R): Promise<R> {
      const run = chain.then(async () => {
        const allSnap = new Map<StoreName, unknown[]>();
        const keySnap = new Map<string, unknown>();
        for (const s of prefetch.all ?? []) allSnap.set(s, await storeFor(s).getAll());
        for (const [s, k] of prefetch.keys ?? []) keySnap.set(s + " " + k, await storeFor(s).get(k));

        if (gate) await gate("before-decide");

        // `decide` is synchronous in BOTH runners (the real one has no choice —
        // an IndexedDB transaction auto-commits the moment it yields), so its
        // writes are COLLECTED here and applied immediately after. Still atomic:
        // the whole block runs inside this serialized chain, so no other
        // transact() can observe the midpoint.
        const writes: Array<() => Promise<void>> = [];
        const out = decide({
          getAll: (s: StoreName) => (allSnap.get(s) ?? []) as never[],
          get: (s: StoreName, k: string) => keySnap.get(s + " " + k) as never,
          put: (s: StoreName, k: string, v: unknown) => {
            writes.push(() => storeFor(s).put(k, v));
          },
          delete: (s: StoreName, k: string) => {
            writes.push(() => storeFor(s).delete(k));
          },
        } as AtomicTxn);
        for (const w of writes) await w();

        if (gate) await gate("after-decide");
        return out;
      });
      // Keep the chain alive even when a caller rejects, or one failed critical
      // section would deadlock every later one.
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Offline image cache manifest (Owner I). One row per (branchId, itemId):
 * the cached image's version, byte size, and last-access time. `bytes` +
 * `lastAccess` drive enforceQuota's oldest-first LRU eviction; `branchId`
 * drives clearImageCache's bulk delete. The Cache Storage bytes themselves
 * live in a `mt-posv2-images-${branchId}` bucket — this table is bookkeeping
 * only, never the source of truth for what's actually cached.
 */
export interface ImageManifestEntry {
  branchId: string;
  itemId: string;
  imageVersion: string;
  bytes: number;
  lastAccess: number; // Date.now() ms
}

/** Out-of-line composite key — mirrors how the other stores key by an
 *  explicit string (see idbPut) rather than a keyPath. */
export function imageManifestKey(branchId: string, itemId: string): string {
  return `${branchId}::${itemId}`;
}

export function idbPutImageManifestEntry(entry: ImageManifestEntry): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(IMAGE_MANIFEST_STORE, "readwrite");
        const req = t.objectStore(IMAGE_MANIFEST_STORE).put(entry, imageManifestKey(entry.branchId, entry.itemId));
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error("idb put (imageManifest) failed"));
      }),
  );
}

export function idbDeleteImageManifestEntry(branchId: string, itemId: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(IMAGE_MANIFEST_STORE, "readwrite");
        const req = t.objectStore(IMAGE_MANIFEST_STORE).delete(imageManifestKey(branchId, itemId));
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error("idb delete (imageManifest) failed"));
      }),
  );
}

/** Every manifest row, unsorted — callers sort as needed (enforceQuota sorts
 *  ascending by lastAccess for LRU eviction). */
export function idbGetAllImageManifest(): Promise<ImageManifestEntry[]> {
  return openDb().then(
    (db) =>
      new Promise<ImageManifestEntry[]>((resolve, reject) => {
        const t = db.transaction(IMAGE_MANIFEST_STORE, "readonly");
        const req = t.objectStore(IMAGE_MANIFEST_STORE).getAll();
        req.onsuccess = () => resolve((req.result as ImageManifestEntry[] | undefined) ?? []);
        req.onerror = () => reject(req.error ?? new Error("idb getAll (imageManifest) failed"));
      }),
  );
}

/** Rows for one branch, via the 'branchId' index — used by clearImageCache
 *  to know exactly which manifest rows a bucket delete must also drop. */
export function idbGetImageManifestByBranch(branchId: string): Promise<ImageManifestEntry[]> {
  return openDb().then(
    (db) =>
      new Promise<ImageManifestEntry[]>((resolve, reject) => {
        const t = db.transaction(IMAGE_MANIFEST_STORE, "readonly");
        const idx = t.objectStore(IMAGE_MANIFEST_STORE).index("branchId");
        const req = idx.getAll(IDBKeyRange.only(branchId));
        req.onsuccess = () => resolve((req.result as ImageManifestEntry[] | undefined) ?? []);
        req.onerror = () => reject(req.error ?? new Error("idb getAll-by-branch (imageManifest) failed"));
      }),
  );
}

/** Deletes every manifest row for one branch via a cursor over the
 *  'branchId' index — the matching Cache Storage bucket is deleted
 *  separately (whole-bucket caches.delete is O(1); this only clears the
 *  bookkeeping rows). */
export function idbClearImageManifestByBranch(branchId: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(IMAGE_MANIFEST_STORE, "readwrite");
        const store = t.objectStore(IMAGE_MANIFEST_STORE);
        const idx = store.index("branchId");
        const req = idx.openKeyCursor(IDBKeyRange.only(branchId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
        req.onerror = () => reject(req.error ?? new Error("idb clear-by-branch (imageManifest) failed"));
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error ?? new Error("idb clear-by-branch (imageManifest) tx failed"));
      }),
  );
}

/** Drops every manifest row (all branches) — paired with deleting every
 *  mt-posv2-images-* Cache Storage bucket when clearImageCache() is called
 *  with no branchId. */
export function idbClearImageManifest(): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(IMAGE_MANIFEST_STORE, "readwrite");
        const req = t.objectStore(IMAGE_MANIFEST_STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error("idb clear (imageManifest) failed"));
      }),
  );
}
