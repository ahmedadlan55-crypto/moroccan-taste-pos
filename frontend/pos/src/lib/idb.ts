/**
 * Tiny promise-based IndexedDB wrapper — no external dependency.
 * Stores: 'catalog' (single doc + etag), 'orders' (LocalOrder by ULID),
 * 'queue' (FIFO ops by opId).
 */

const DB_NAME = "pos-v2";
const DB_VERSION = 1;
export const STORES = ["catalog", "orders", "queue"] as const;
export type StoreName = (typeof STORES)[number];

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
