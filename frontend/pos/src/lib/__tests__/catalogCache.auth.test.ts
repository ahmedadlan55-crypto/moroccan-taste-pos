/**
 * Regression — DEFECT 4: an expired session was reported as "stale catalog".
 *
 * `loadCatalog`'s catch swallowed EVERY fetch failure whenever any cached copy
 * existed — 401 included. The cashier kept ringing up items off the cached menu
 * while every single write 401'd behind them, and the only thing the UI ever
 * said was "قائمة قديمة". A 401 is not an outage: there is nothing to sell
 * through, and the one fix is signing in again.
 *
 * Second half: the two throws smuggled a dotted i18n path through
 * `Error.message` (`new Error("catalogCache.noConnection")`). That only rendered
 * because exactly one call site remembered to run it back through t().
 * translateApiError resolves `errors.<code>`, so the CODE is what makes an
 * error translatable anywhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "../types";

const idb = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock("../idb", () => ({
  idbGet: vi.fn(async (_s: string, k: string) => idb.store.get(k)),
  idbPut: vi.fn(async (_s: string, k: string, v: unknown) => { idb.store.set(k, v); }),
}));

const fetchCatalog = vi.hoisted(() => vi.fn());
// The REAL ApiError — isAuthFailure does an `instanceof` against it.
vi.mock("../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api")>();
  return { ...mod, fetchCatalog };
});

import { ApiError } from "../api";
import { CatalogError, isAuthFailure, loadCatalog } from "../catalogCache";
import { translateApiError } from "@/i18n/errorCodes";
import { ar } from "@/i18n/dictionaries/ar";

const CATALOG = { items: [], categories: [] } as unknown as Catalog;

function setOnline(online: boolean) {
  Object.defineProperty(globalThis, "navigator", { value: { onLine: online }, configurable: true });
}

function seedCache(ageMs = 60_000) {
  idb.store.set("catalog", { data: CATALOG, etag: 'W/"v1"', savedAt: Date.now() - ageMs });
}

beforeEach(() => {
  idb.store.clear();
  fetchCatalog.mockReset();
  setOnline(true);
});

describe("a 401 is an expired session, not a stale cache", () => {
  it("THE DEFECT: a 401 with a perfectly good cache now THROWS instead of selling on", async () => {
    seedCache();
    fetchCatalog.mockRejectedValue(new ApiError(401, "SERVER_ERROR", "Unauthorized"));
    // Before: resolved to `{fromCache:true, stale:false}` and the till carried
    // on taking orders that could never be written.
    await expect(loadCatalog()).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("a 401 with NO cache is the same error — the cache was never the distinction", async () => {
    fetchCatalog.mockRejectedValue(new ApiError(401, "SERVER_ERROR", "Unauthorized"));
    await expect(loadCatalog()).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("a genuine NETWORK failure still degrades to the cache — selling through an outage is required", async () => {
    seedCache();
    fetchCatalog.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await loadCatalog();
    expect(r.fromCache).toBe(true);
    expect(r.catalog).toBe(CATALOG);
  });

  it("a 500 also degrades to the cache — only auth is special-cased", async () => {
    seedCache();
    fetchCatalog.mockRejectedValue(new ApiError(500, "SERVER_ERROR", "boom"));
    const r = await loadCatalog();
    expect(r.fromCache).toBe(true);
  });
});

describe("isAuthFailure", () => {
  it("keys on the STATUS, because fetchCatalog labels every non-2xx 'SERVER_ERROR'", () => {
    expect(isAuthFailure(new ApiError(401, "SERVER_ERROR", "no"))).toBe(true);
    expect(isAuthFailure(new ApiError(500, "SERVER_ERROR", "no"))).toBe(false);
    expect(isAuthFailure({ status: 401 })).toBe(true);
    expect(isAuthFailure({ code: "UNAUTHORIZED" })).toBe(true);
    expect(isAuthFailure(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});

describe("errors carry a CODE, not an i18n key hidden in .message", () => {
  it("offline with no cache → CATALOG_OFFLINE", async () => {
    setOnline(false);
    await expect(loadCatalog()).rejects.toBeInstanceOf(CatalogError);
    setOnline(false);
    await expect(loadCatalog()).rejects.toMatchObject({ code: "CATALOG_OFFLINE" });
  });

  it("an unusable response with no cache → CATALOG_LOAD_FAILED", async () => {
    fetchCatalog.mockResolvedValue({ status: 200, data: undefined });
    await expect(loadCatalog()).rejects.toMatchObject({ code: "CATALOG_LOAD_FAILED" });
  });

  it("the message is a human sentence, NOT the dotted path it used to be", async () => {
    setOnline(false);
    let thrown: unknown;
    try {
      await loadCatalog();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CatalogError);
    const { message } = thrown as CatalogError;
    expect(message).not.toBe("catalogCache.noConnection");
    expect(message).not.toMatch(/^catalogCache\./);
    expect(message.length).toBeGreaterThan(10);
  });

  it("every code resolves through translateApiError — the point of carrying a code", async () => {
    const t = ((path: string) => {
      const hit = path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], { ar }.ar);
      return typeof hit === "string" ? hit : path;
    }) as Parameters<typeof translateApiError>[1];

    for (const code of ["CATALOG_OFFLINE", "CATALOG_LOAD_FAILED", "SESSION_EXPIRED"] as const) {
      const msg = translateApiError(new CatalogError(code, "raw internal sentence"), t);
      expect(msg).not.toBe(`errors.${code}`); // resolved, not a path miss
      expect(msg).not.toBe("raw internal sentence"); // the dictionary won, not .message
      expect(msg.length).toBeGreaterThan(10);
    }
  });
});
