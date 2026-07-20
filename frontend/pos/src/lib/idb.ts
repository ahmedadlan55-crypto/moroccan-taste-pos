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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
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
