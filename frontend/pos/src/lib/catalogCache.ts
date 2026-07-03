/**
 * Catalog loader — ETag-aware with IndexedDB persistence for offline boot.
 *   online  : GET /api/pos/v2/catalog with If-None-Match; 304 → cached copy.
 *   offline : cached copy straight from IndexedDB.
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

export async function loadCatalog(): Promise<{ catalog: Catalog; fromCache: boolean }> {
  const cached = await idbGet<CachedCatalog>("catalog", KEY).catch(() => undefined);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (cached) return { catalog: cached.data, fromCache: true };
    throw new Error("لا يوجد اتصال ولا نسخة محفوظة من القائمة — اتصل بالشبكة مرة واحدة أولًا");
  }
  try {
    const res = await fetchCatalog(cached?.etag ?? null);
    if (res.status === 304 && cached) return { catalog: cached.data, fromCache: false };
    if (res.status === 200 && res.data) {
      await idbPut<CachedCatalog>("catalog", KEY, { data: res.data, etag: res.etag ?? null, savedAt: Date.now() }).catch(
        () => undefined,
      );
      return { catalog: res.data, fromCache: false };
    }
    if (cached) return { catalog: cached.data, fromCache: true };
    throw new Error("تعذّر تحميل القائمة");
  } catch (e) {
    if (cached) return { catalog: cached.data, fromCache: true };
    throw e;
  }
}
