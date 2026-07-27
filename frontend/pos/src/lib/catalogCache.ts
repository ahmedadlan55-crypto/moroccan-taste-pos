/**
 * Catalog loader — ETag-aware with IndexedDB persistence for offline boot.
 *   online  : GET /api/pos/v2/catalog with If-None-Match; 304 → cached copy.
 *   offline : cached copy straight from IndexedDB.
 *
 * Staleness: `savedAt` was previously written and never read, so a terminal that
 * had been offline for weeks sold from that old price list with no signal at all.
 * We do NOT refuse to sell on a stale cache — selling through a network outage is
 * a hard requirement — but the age is surfaced so the UI can say so out loud.
 *
 * AN EXPIRED SESSION IS NOT A STALE CACHE.
 *   The catch below used to swallow EVERY fetch failure whenever any cached copy
 *   existed — including a 401. The cashier then kept ringing up items off the
 *   cached menu while every single write 401'd, and the only thing the UI said
 *   was "قائمة قديمة". A 401 is not a network outage: there is nothing to sell
 *   through, and the only fix is signing in again. It now surfaces as its own
 *   SESSION_EXPIRED code, ahead of (and regardless of) the cache.
 *
 * ERRORS CARRY A CODE, NOT AN i18n KEY IN `.message`.
 *   These used to `throw new Error("catalogCache.noConnection")` — a dotted i18n
 *   path smuggled through Error.message, which only worked because exactly one
 *   call site remembered to run it back through t(). translateApiError(e, t)
 *   resolves `errors.<code>`, so the code is what makes an error translatable
 *   anywhere; `.message` stays a plain human sentence for last-resort display.
 */
import { fetchCatalog } from "./api";
import { idbGet, idbPut } from "./idb";
import type { Catalog } from "./types";

/**
 * Why the catalog could not be served.
 *   CATALOG_OFFLINE     — no network AND no cached copy on this device.
 *   CATALOG_LOAD_FAILED — the server was reachable-ish but gave us nothing usable.
 *   SESSION_EXPIRED     — the token was rejected (401). Distinct on purpose: the
 *                         cache is irrelevant, every write will fail too.
 * Each has a matching `errors.<code>` entry in BOTH dictionaries.
 */
export type CatalogErrorCode = "CATALOG_OFFLINE" | "CATALOG_LOAD_FAILED" | "SESSION_EXPIRED";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

/** A rejected token — the ONE failure a cached catalog must not paper over.
 *
 *  Structural, NOT `instanceof ApiError`: fetchCatalog throws
 *  ApiError(res.status, 'SERVER_ERROR', …) for every non-2xx, so the STATUS is
 *  what identifies auth (the code is 'SERVER_ERROR' even for a 401). Duck-typing
 *  also keeps this module from depending on the ApiError CLASS identity, which
 *  a test module-mock — or two copies of api.ts in one bundle — would break. */
export function isAuthFailure(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const r = e as { status?: unknown; code?: unknown };
  if (r.status === 401) return true;
  return r.code === "UNAUTHORIZED" || r.code === "SESSION_EXPIRED";
}

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

/**
 * Repair a cache entry that holds the RESPONSE ENVELOPE instead of the catalog.
 *
 * The channel-catalog path used to store `{ success, data }` verbatim in this
 * very slot (state/store.tsx wrote whatever `res.json()` returned). A device
 * that ever selected a sales channel therefore has a poisoned entry with no
 * `items`, and served it back on every reload and every offline boot — an empty
 * product grid that no amount of restarting fixed.
 *
 * Fixing the writer stops NEW poison; this repairs the tablets that already
 * have it, without asking anyone to clear browser storage on a shop floor. It
 * keys off `items` being an array rather than off `success`, so it recognises
 * the damage by shape and cannot be fooled by a catalog that happens to carry
 * a `data` field.
 */
function unpoison(cached: CachedCatalog | undefined): CachedCatalog | undefined {
  if (!cached || !cached.data || typeof cached.data !== "object") return cached;
  const d = cached.data as unknown as { items?: unknown; data?: unknown };
  if (Array.isArray(d.items)) return cached; // healthy
  const inner = d.data as { items?: unknown } | undefined;
  if (inner && typeof inner === "object" && Array.isArray(inner.items)) {
    // Drop the etag with it: it was never this payload's etag, and keeping it
    // would let a 304 re-bless the repaired copy against the wrong validator.
    return { ...cached, data: inner as unknown as Catalog, etag: null };
  }
  return cached;
}

export async function loadCatalog(): Promise<LoadedCatalog> {
  const cached = unpoison(await idbGet<CachedCatalog>("catalog", KEY).catch(() => undefined));
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (cached) return fromCached(cached);
    throw new CatalogError(
      "CATALOG_OFFLINE",
      "No network connection and no saved menu on this device — connect once, then reopen the register.",
    );
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
    throw new CatalogError("CATALOG_LOAD_FAILED", "The menu could not be loaded from the server.");
  } catch (e) {
    // AUTH FIRST, ahead of the cache. Falling back here is what let a cashier
    // ring up a whole queue of customers on an expired session while every
    // write 401'd behind them — reported to their face as "stale menu".
    if (isAuthFailure(e)) {
      throw new CatalogError("SESSION_EXPIRED", "Your session has expired — sign in again to keep selling.");
    }
    // Everything else IS a network/server outage: keep the till alive on the
    // cached copy, flagged with its true age by fromCached().
    if (cached) return fromCached(cached);
    if (e instanceof CatalogError) throw e;
    throw new CatalogError("CATALOG_LOAD_FAILED", e instanceof Error && e.message ? e.message : "The menu could not be loaded.");
  }
}
