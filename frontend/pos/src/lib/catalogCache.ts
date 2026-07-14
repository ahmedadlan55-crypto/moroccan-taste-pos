/**
 * Catalog loader — ETag-aware with IndexedDB persistence for offline boot.
 *   online  : GET /api/pos/v2/catalog with If-None-Match; 304 → cached copy.
 *   offline : cached copy straight from IndexedDB.
 *
 * Staleness: `savedAt` was previously written and never read, so a terminal that
 * had been offline for weeks sold from that old price list with no signal at all.
 * We do NOT refuse to sell on a stale cache — selling through a network outage is
 * a hard requirement — but the age is surfaced so the UI can say so out loud.
 */
import { fetchCatalog } from "./api";
import { idbGet, idbPut } from "./idb";
import type { Catalog } from "./types";

interface CachedCatalog {
  data: Catalog;
  etag: string | null;
  savedAt: number;
}

const KEY = "catalog";

/** A cached catalog older than this is called out to the cashier. */
export const CATALOG_STALE_AFTER_MS = 12 * 60 * 60_000; // 12h

export interface LoadedCatalog {
  catalog: Catalog;
  /** Served from IndexedDB without confirming freshness against the server. */
  fromCache: boolean;
  /** When this copy was last fetched from the server (null = unknown/legacy entry). */
  savedAt: number | null;
  /** Age of the served copy in ms (null when freshly fetched or unknown). */
  ageMs: number | null;
  /** fromCache AND older than CATALOG_STALE_AFTER_MS — prices may be wrong. */
  stale: boolean;
}

function fromCached(cached: CachedCatalog): LoadedCatalog {
  const savedAt = typeof cached.savedAt === "number" ? cached.savedAt : null;
  const ageMs = savedAt == null ? null : Math.max(0, Date.now() - savedAt);
  return {
    catalog: cached.data,
    fromCache: true,
    savedAt,
    ageMs,
    // Unknown age is treated as stale: a cache entry we cannot date is exactly
    // the one we should not quietly vouch for.
    stale: ageMs == null || ageMs > CATALOG_STALE_AFTER_MS,
  };
}

const fresh = (catalog: Catalog): LoadedCatalog => ({
  catalog,
  fromCache: false,
  savedAt: Date.now(),
  ageMs: 0,
  stale: false,
});

export async function loadCatalog(): Promise<LoadedCatalog> {
  const cached = await idbGet<CachedCatalog>("catalog", KEY).catch(() => undefined);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (cached) return fromCached(cached);
    throw new Error("لا يوجد اتصال ولا نسخة محفوظة من القائمة — اتصل بالشبكة مرة واحدة أولًا");
  }
  try {
    const res = await fetchCatalog(cached?.etag ?? null);
    if (res.status === 304 && cached) {
      // The server confirmed our copy is current — refresh savedAt so a long
      // string of 304s can never make a live catalog look stale.
      const savedAt = Date.now();
      await idbPut<CachedCatalog>("catalog", KEY, { ...cached, savedAt }).catch(() => undefined);
      return { catalog: cached.data, fromCache: false, savedAt, ageMs: 0, stale: false };
    }
    if (res.status === 200 && res.data) {
      await idbPut<CachedCatalog>("catalog", KEY, { data: res.data, etag: res.etag ?? null, savedAt: Date.now() }).catch(
        () => undefined,
      );
      return fresh(res.data);
    }
    if (cached) return fromCached(cached);
    throw new Error("تعذّر تحميل القائمة");
  } catch (e) {
    if (cached) return fromCached(cached);
    throw e;
  }
}
