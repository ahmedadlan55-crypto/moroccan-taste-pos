/**
 * Catalog cache staleness tests.
 *
 * Regression guard for a real defect: `savedAt` was written to IndexedDB and
 * then never read by anything, so a terminal that had been offline for weeks
 * happily sold from that months-old price list and said nothing. The cache must
 * keep serving (an outage must never stop the till) but it must report its age.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "../types";

const idb = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock("../idb", () => ({
  idbGet: vi.fn(async (_s: string, k: string) => idb.store.get(k)),
  idbPut: vi.fn(async (_s: string, k: string, v: unknown) => { idb.store.set(k, v); }),
}));

const fetchCatalog = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ fetchCatalog }));

import { CATALOG_STALE_AFTER_MS, loadCatalog } from "../catalogCache";

const CATALOG = { items: [], categories: [] } as unknown as Catalog;

function setOnline(online: boolean) {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: online },
    configurable: true,
  });
}

/** Seed a cached copy that was saved `ageMs` ago. */
function seedCache(ageMs: number, etag: string | null = "W/\"v1\"") {
  idb.store.set("catalog", { data: CATALOG, etag, savedAt: Date.now() - ageMs });
}

beforeEach(() => {
  idb.store.clear();
  fetchCatalog.mockReset();
  setOnline(true);
});

describe("loadCatalog staleness", () => {
  it("a fresh server fetch is never stale", async () => {
    fetchCatalog.mockResolvedValue({ status: 200, data: CATALOG, etag: "W/\"v1\"" });
    const r = await loadCatalog();
    expect(r.fromCache).toBe(false);
    expect(r.stale).toBe(false);
    expect(r.ageMs).toBe(0);
  });

  it("offline + recent cache → serves it, not stale", async () => {
    seedCache(60_000); // 1 minute old
    setOnline(false);
    const r = await loadCatalog();
    expect(r.fromCache).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.ageMs).toBeGreaterThanOrEqual(60_000);
  });

  it("offline + old cache → STILL SELLS but reports stale", async () => {
    seedCache(CATALOG_STALE_AFTER_MS + 60_000);
    setOnline(false);
    const r = await loadCatalog();
    // The critical half: the till keeps working.
    expect(r.catalog).toBe(CATALOG);
    // The half that was missing entirely before.
    expect(r.stale).toBe(true);
  });

  it("a cache entry with no savedAt is treated as stale, not as fresh", async () => {
    // Entries written before this fix have no usable timestamp. Defaulting an
    // undateable cache to "fresh" is exactly the silent-wrong-price bug.
    idb.store.set("catalog", { data: CATALOG, etag: null });
    setOnline(false);
    const r = await loadCatalog();
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBeNull();
  });

  it("304 refreshes savedAt so a long run of 304s never looks stale", async () => {
    seedCache(CATALOG_STALE_AFTER_MS + 60_000);
    fetchCatalog.mockResolvedValue({ status: 304 });
    const r = await loadCatalog();
    // The server confirmed the copy is current — that is the opposite of stale.
    expect(r.stale).toBe(false);
    expect(r.ageMs).toBe(0);
    expect((idb.store.get("catalog") as { savedAt: number }).savedAt).toBeGreaterThan(
      Date.now() - 5_000,
    );
  });

  it("network failure falls back to cache and reports its true age", async () => {
    seedCache(CATALOG_STALE_AFTER_MS + 3_600_000);
    fetchCatalog.mockRejectedValue(new Error("network down"));
    const r = await loadCatalog();
    expect(r.fromCache).toBe(true);
    expect(r.stale).toBe(true);
  });

  it("no cache and no network → throws rather than inventing an empty menu", async () => {
    setOnline(false);
    await expect(loadCatalog()).rejects.toThrow();
  });
});
