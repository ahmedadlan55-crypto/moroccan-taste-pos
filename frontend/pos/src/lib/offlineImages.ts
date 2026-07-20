/**
 * Offline item-image cache (Owner I).
 *
 * Item photos live behind the JWT-gated GET /api/pos/v2/item-image/:id (same
 * endpoint + `?v=<imageVersion>` cache-busting pattern as the in-memory object-URL
 * cache in components/ProductGrid.tsx — see that file's header comment). This
 * module adds a SECOND, durable layer on top: bytes are also written into a
 * per-branch Cache Storage bucket so a terminal that goes offline mid-shift still
 * has product photos, not just the (memory-only, tab-lifetime) object URLs.
 *
 * Cache Storage bucket naming: `mt-posv2-images-${branchId}` — one bucket per
 * branch so clearImageCache(branchId) can drop exactly one branch's photos
 * (bucket delete is O(1)) without touching any other branch's cache. The bucket
 * is looked up by the service worker's fetch handler (public/sw.js) too — see
 * that file's `/api/pos/v2/item-image/` carve-out, which serves any cached copy
 * (from ANY bucket — Cache Storage lookups span all caches, not one at a time)
 * before falling back to the network.
 *
 * A companion IndexedDB store ('imageManifest', see lib/idb.ts) tracks what was
 * downloaded — branchId, itemId, imageVersion, byte size, last-access time — so
 * enforceQuota() can evict the least-recently-used entries without walking the
 * Cache Storage API (which has no size/listing introspection beyond key lookup).
 */
import { getToken } from "./auth";
import {
  idbClearImageManifest,
  idbClearImageManifestByBranch,
  idbDeleteImageManifestEntry,
  idbGetAllImageManifest,
  idbGetImageManifestByBranch,
  idbPutImageManifestEntry,
  type ImageManifestEntry,
} from "./idb";
import type { CatalogItem } from "./types";

// Mirrors components/ProductGrid.tsx's ITEM_IMAGE_API — deliberately duplicated
// (not imported) because ProductGrid does not export it; keep the two in sync if
// the route ever moves. Absolute so it survives being served at /pos-v2/ or /pos/.
const ITEM_IMAGE_API = "/api/pos/v2/item-image/";

/** Cache Storage bucket namespace — see file header. */
const BUCKET_PREFIX = "mt-posv2-images-";
export function imageBucketName(branchId: string): string {
  return `${BUCKET_PREFIX}${branchId}`;
}

/** Same URL both the fetch and the Cache Storage put/match/delete key off of —
 *  keeping one builder means the download path and the SW's read path (and
 *  enforceQuota's evict path) can never drift out of sync with each other. */
function itemImageUrl(itemId: string, imageVersion: string): string {
  return `${ITEM_IMAGE_API}${encodeURIComponent(itemId)}?v=${encodeURIComponent(imageVersion)}`;
}

export const DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024; // 200 MB

// ── Download progress — tiny useSyncExternalStore-friendly external store ────
// Same shape as lib/pwa.ts's PwaStatus/subscribePwa/getPwaStatus: module-level
// state + a listener Set, so a Header chip can subscribe without prop-drilling
// the in-flight download through every component between App and the chip.
export interface ImageDownloadStatus {
  active: boolean;
  done: number;
  total: number;
}

let downloadStatus: ImageDownloadStatus = { active: false, done: 0, total: 0 };
const downloadListeners = new Set<() => void>();

function setDownloadStatus(patch: Partial<ImageDownloadStatus>): void {
  downloadStatus = { ...downloadStatus, ...patch };
  downloadListeners.forEach((fn) => fn());
}

export function subscribeImageDownload(fn: () => void): () => void {
  downloadListeners.add(fn);
  return () => downloadListeners.delete(fn);
}

export function getImageDownloadStatus(): ImageDownloadStatus {
  return downloadStatus;
}

export interface DownloadBranchImagesOptions {
  branchId: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  total: number;
  /** Newly fetched + cached this run (a byte-identical re-download of an
   *  unchanged imageVersion still counts — see the "always re-fetch" note below). */
  downloaded: number;
  /** Items with no imageVersion (no photo) — nothing to do for them. */
  skipped: number;
  /** Fetch failed (offline mid-run, 404/401, etc.) — non-fatal, next item continues. */
  failed: number;
  /** True if `signal` fired before every item was processed. */
  cancelled: boolean;
}

/**
 * Downloads every catalog item's photo into the branch's Cache Storage bucket
 * + records a manifest row for each. Best-effort per item: a single failed
 * fetch (offline, 404 for a corrupt/cleared image, 401 for an expired token)
 * is swallowed and counted in `failed` — it must never abort the whole run.
 *
 * Re-fetches unconditionally rather than skipping items whose imageVersion is
 * already in the manifest: the caller (a periodic/background sync) already
 * knows what changed via the catalog diff, so this stays simple and correct
 * even if the manifest and the actual bucket ever drift.
 */
export async function downloadBranchImages(
  items: CatalogItem[],
  { branchId, onProgress, signal }: DownloadBranchImagesOptions,
): Promise<DownloadResult> {
  const withImages = items.filter((it): it is CatalogItem & { imageVersion: string } => Boolean(it.imageVersion));
  const total = withImages.length;
  const result: DownloadResult = { total, downloaded: 0, skipped: items.length - total, failed: 0, cancelled: false };

  if (total === 0) return result;
  if (typeof caches === "undefined") return result; // no Cache Storage (SSR/unsupported) — nothing to do

  setDownloadStatus({ active: true, done: 0, total });
  try {
    const cache = await caches.open(imageBucketName(branchId));
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    let done = 0;
    for (const item of withImages) {
      if (signal?.aborted) {
        result.cancelled = true;
        break;
      }

      const url = itemImageUrl(item.id, item.imageVersion);
      try {
        const res = await fetch(url, { headers, signal });
        if (res.ok) {
          const bytesRes = res.clone();
          await cache.put(url, res);
          const blob = await bytesRes.blob();
          await idbPutImageManifestEntry({
            branchId,
            itemId: item.id,
            imageVersion: item.imageVersion,
            bytes: blob.size,
            lastAccess: Date.now(),
          });
          result.downloaded += 1;
        } else {
          result.failed += 1;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          result.cancelled = true;
          break;
        }
        result.failed += 1; // offline / network error — next item still tries
      }

      done += 1;
      setDownloadStatus({ done });
      onProgress?.(done, total);
    }
  } finally {
    setDownloadStatus({ active: false });
  }

  return result;
}

/**
 * Clears the offline image cache: a single branch's bucket + manifest rows
 * when `branchId` is given, or EVERY `mt-posv2-images-*` bucket + the whole
 * manifest store when omitted (used on logout — see App.tsx performLogout).
 */
export async function clearImageCache(branchId?: string): Promise<void> {
  if (typeof caches === "undefined") return;

  if (branchId) {
    await caches.delete(imageBucketName(branchId)).catch(() => false);
    await idbClearImageManifestByBranch(branchId).catch(() => undefined);
    return;
  }

  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(BUCKET_PREFIX)).map((k) => caches.delete(k).catch(() => false)));
  await idbClearImageManifest().catch(() => undefined);
}

export interface EnforceQuotaResult {
  evicted: number;
  totalBytes: number;
}

/**
 * LRU-evicts the oldest-accessed cached images (across ALL branches — the
 * quota is a single device-wide ceiling, not per-branch) until the manifest's
 * total bytes fits under `maxBytes`. Deletes both the Cache Storage entry and
 * the manifest row for each evicted image; skips gracefully past anything that
 * fails to delete (a benign double-evict is harmless, leaving it forever is not).
 */
export async function enforceQuota(maxBytes: number = DEFAULT_QUOTA_BYTES): Promise<EnforceQuotaResult> {
  const all = await idbGetAllImageManifest();
  let totalBytes = all.reduce((sum, e) => sum + e.bytes, 0);
  if (totalBytes <= maxBytes) return { evicted: 0, totalBytes };

  // Oldest-accessed first.
  const sorted = [...all].sort((a, b) => a.lastAccess - b.lastAccess);
  let evicted = 0;
  const openBuckets = new Map<string, Cache>();

  for (const entry of sorted) {
    if (totalBytes <= maxBytes) break;
    await evictEntry(entry, openBuckets);
    totalBytes -= entry.bytes;
    evicted += 1;
  }

  return { evicted, totalBytes };
}

async function evictEntry(entry: ImageManifestEntry, openBuckets: Map<string, Cache>): Promise<void> {
  try {
    let cache = openBuckets.get(entry.branchId);
    if (!cache) {
      cache = await caches.open(imageBucketName(entry.branchId));
      openBuckets.set(entry.branchId, cache);
    }
    await cache.delete(itemImageUrl(entry.itemId, entry.imageVersion));
  } catch {
    // Cache Storage delete failing is non-fatal — still drop the manifest row
    // below so accounting doesn't keep counting bytes that eviction attempted.
  }
  await idbDeleteImageManifestEntry(entry.branchId, entry.itemId).catch(() => undefined);
}

export interface ImageCacheStats {
  totalBytes: number;
  itemCount: number;
}

/** Device-wide totals (all branches) for a settings/status UI chip. */
export async function getImageCacheStats(): Promise<ImageCacheStats> {
  const all = await idbGetAllImageManifest();
  return { totalBytes: all.reduce((sum, e) => sum + e.bytes, 0), itemCount: all.length };
}

/** Per-branch totals, if a caller ever needs to show "this branch: N MB". */
export async function getImageCacheStatsForBranch(branchId: string): Promise<ImageCacheStats> {
  const rows = await idbGetImageManifestByBranch(branchId);
  return { totalBytes: rows.reduce((sum, e) => sum + e.bytes, 0), itemCount: rows.length };
}
