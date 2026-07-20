/**
 * Offline image cache tests (Owner I).
 *
 * Mocking style copied from catalogCache.test.ts: `../idb` is mocked wholesale
 * with an in-memory backing (no real IndexedDB in jsdom — see idb.ts's own
 * header for why this repo has no fake-indexeddb dependency), and Cache
 * Storage is a tiny hand-rolled fake installed on `globalThis.caches` per test
 * (jsdom has no real Cache Storage either).
 *
 * Covers the two behaviors the task calls out explicitly:
 *   - enforceQuota evicts oldest-`lastAccess`-first, stopping once under the cap.
 *   - clearImageCache(branchId) removes ONLY that branch's bucket + manifest rows.
 * Plus two adjacent cases (under-cap no-op, and clearImageCache() with no
 * branchId sweeping every mt-posv2-images-* bucket) for confidence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageManifestEntry } from "../idb";

const idb = vi.hoisted(() => ({
  manifest: [] as ImageManifestEntry[],
  clearedBranches: [] as string[],
  clearedAllCount: 0,
  deleted: [] as Array<{ branchId: string; itemId: string }>,
  put: [] as ImageManifestEntry[],
}));

vi.mock("../idb", () => ({
  idbGetAllImageManifest: vi.fn(async () => idb.manifest),
  idbGetImageManifestByBranch: vi.fn(async (branchId: string) =>
    idb.manifest.filter((e) => e.branchId === branchId),
  ),
  idbPutImageManifestEntry: vi.fn(async (entry: ImageManifestEntry) => {
    idb.put.push(entry);
  }),
  idbDeleteImageManifestEntry: vi.fn(async (branchId: string, itemId: string) => {
    idb.deleted.push({ branchId, itemId });
  }),
  idbClearImageManifestByBranch: vi.fn(async (branchId: string) => {
    idb.clearedBranches.push(branchId);
  }),
  idbClearImageManifest: vi.fn(async () => {
    idb.clearedAllCount += 1;
  }),
}));

vi.mock("../auth", () => ({ getToken: vi.fn(() => null) }));

import { clearImageCache, enforceQuota, imageBucketName } from "../offlineImages";

// ── Fake Cache Storage ────────────────────────────────────────────────────
interface FakeCache {
  store: Map<string, unknown>;
  put: (req: string, res: unknown) => Promise<void>;
  delete: (req: string) => Promise<boolean>;
  match: (req: string) => Promise<unknown>;
}

function makeFakeCache(): FakeCache {
  const store = new Map<string, unknown>();
  return {
    store,
    put: async (req, res) => {
      store.set(req, res);
    },
    delete: async (req) => store.delete(req),
    match: async (req) => store.get(req),
  };
}

function makeFakeCacheStorage() {
  const buckets = new Map<string, FakeCache>();
  return {
    buckets,
    open: vi.fn(async (name: string) => {
      if (!buckets.has(name)) buckets.set(name, makeFakeCache());
      return buckets.get(name)!;
    }),
    keys: vi.fn(async () => [...buckets.keys()]),
    delete: vi.fn(async (name: string) => buckets.delete(name)),
  };
}

function entry(overrides: Partial<ImageManifestEntry>): ImageManifestEntry {
  return { branchId: "B1", itemId: "I1", imageVersion: "v1", bytes: 100, lastAccess: 0, ...overrides };
}

beforeEach(() => {
  idb.manifest = [];
  idb.clearedBranches = [];
  idb.clearedAllCount = 0;
  idb.deleted = [];
  idb.put = [];
  vi.clearAllMocks();
});

describe("enforceQuota", () => {
  it("evicts oldest-accessed entries first, stopping once under the cap", async () => {
    const fakeCaches = makeFakeCacheStorage();
    (globalThis as unknown as { caches: unknown }).caches = fakeCaches;

    const entries: ImageManifestEntry[] = [
      entry({ itemId: "I1", lastAccess: 1000 }),
      entry({ itemId: "I2", lastAccess: 2000 }),
      entry({ itemId: "I3", lastAccess: 3000 }),
      entry({ itemId: "I4", lastAccess: 4000 }),
    ];
    idb.manifest = entries;

    // Pre-seed the bucket with the same URLs the download path would have used.
    const bucket = await fakeCaches.open(imageBucketName("B1"));
    for (const e of entries) {
      await bucket.put(`/api/pos/v2/item-image/${e.itemId}?v=${e.imageVersion}`, { fake: true });
    }

    const result = await enforceQuota(250); // 4×100 bytes = 400 > 250

    expect(result.evicted).toBe(2); // drops to 200, the smallest count ≤ 250
    expect(result.totalBytes).toBe(200);
    expect(idb.deleted).toEqual([
      { branchId: "B1", itemId: "I1" }, // oldest lastAccess
      { branchId: "B1", itemId: "I2" }, // second-oldest
    ]);
    expect(bucket.store.has("/api/pos/v2/item-image/I1?v=v1")).toBe(false);
    expect(bucket.store.has("/api/pos/v2/item-image/I2?v=v1")).toBe(false);
    // The two most-recently-accessed entries survive.
    expect(bucket.store.has("/api/pos/v2/item-image/I3?v=v1")).toBe(true);
    expect(bucket.store.has("/api/pos/v2/item-image/I4?v=v1")).toBe(true);
  });

  it("evicts across branches, oldest lastAccess first regardless of which bucket it's in", async () => {
    const fakeCaches = makeFakeCacheStorage();
    (globalThis as unknown as { caches: unknown }).caches = fakeCaches;

    idb.manifest = [
      entry({ branchId: "OLD_BRANCH", itemId: "I1", lastAccess: 100, bytes: 150 }),
      entry({ branchId: "NEW_BRANCH", itemId: "I2", lastAccess: 500, bytes: 150 }),
    ];

    const result = await enforceQuota(150); // total 300 > 150

    expect(result.evicted).toBe(1);
    expect(idb.deleted).toEqual([{ branchId: "OLD_BRANCH", itemId: "I1" }]);
  });

  it("is a no-op when already under the cap", async () => {
    const fakeCaches = makeFakeCacheStorage();
    (globalThis as unknown as { caches: unknown }).caches = fakeCaches;
    idb.manifest = [entry({ bytes: 50, lastAccess: 1 })];

    const result = await enforceQuota(1000);

    expect(result.evicted).toBe(0);
    expect(result.totalBytes).toBe(50);
    expect(idb.deleted).toEqual([]);
  });
});

describe("clearImageCache", () => {
  it("removes only the targeted branch's bucket + manifest rows when branchId is given", async () => {
    const fakeCaches = makeFakeCacheStorage();
    (globalThis as unknown as { caches: unknown }).caches = fakeCaches;
    await fakeCaches.open(imageBucketName("branchA"));
    await fakeCaches.open(imageBucketName("branchB"));

    await clearImageCache("branchA");

    expect(fakeCaches.buckets.has(imageBucketName("branchA"))).toBe(false);
    expect(fakeCaches.buckets.has(imageBucketName("branchB"))).toBe(true); // untouched
    expect(idb.clearedBranches).toEqual(["branchA"]);
    expect(idb.clearedAllCount).toBe(0); // the whole-store clear was never called
  });

  it("removes every mt-posv2-images-* bucket (and only those) when branchId is omitted", async () => {
    const fakeCaches = makeFakeCacheStorage();
    (globalThis as unknown as { caches: unknown }).caches = fakeCaches;
    await fakeCaches.open(imageBucketName("branchA"));
    await fakeCaches.open(imageBucketName("branchB"));
    await fakeCaches.open("some-unrelated-cache"); // must survive

    await clearImageCache();

    expect(fakeCaches.buckets.has(imageBucketName("branchA"))).toBe(false);
    expect(fakeCaches.buckets.has(imageBucketName("branchB"))).toBe(false);
    expect(fakeCaches.buckets.has("some-unrelated-cache")).toBe(true);
    expect(idb.clearedAllCount).toBe(1);
    expect(idb.clearedBranches).toEqual([]);
  });
});
