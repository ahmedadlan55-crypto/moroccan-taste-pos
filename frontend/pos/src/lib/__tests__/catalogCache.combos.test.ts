/**
 * offline-combos-cache / boot-combos-cache-restore — combo definitions ride the
 * cached catalog payload UNCHANGED. catalogCache persists the server's Catalog
 * object wholesale (no field picking), so a catalog carrying `combos` must
 * round-trip IndexedDB byte-identical: the chooser then works offline for free
 * (legacy parity: pos_combos_cache restore in public/pos/app.js boot).
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

import { loadCatalog } from "../catalogCache";

/** A catalog exactly as the combos-enabled server ships it. */
const COMBO_CATALOG = {
  items: [
    { id: "M-COMBO", name: "وجبة شاورما", price: 35, category: "عروض", active: true, taxCategory: "S", isCombo: true },
  ],
  categories: ["عروض"],
  combos: [
    {
      id: "C-1",
      menuId: "M-COMBO",
      name: "وجبة شاورما",
      price: 35,
      fixedComponents: [{ menuId: "M-SHAWARMA", name: "شاورما دجاج", qty: 1 }],
      groups: [
        {
          id: "G-DRINK",
          name: "اختر مشروبًا",
          min: 1,
          max: 1,
          options: [
            { menuId: "M-PEPSI", name: "بيبسي", priceDelta: 0 },
            { menuId: "M-JUICE", name: "عصير برتقال", priceDelta: 3 },
          ],
        },
      ],
    },
  ],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  serverTime: "2026-07-18T00:00:00Z",
} as unknown as Catalog;

function setOnline(online: boolean) {
  Object.defineProperty(globalThis, "navigator", { value: { onLine: online }, configurable: true });
}

beforeEach(() => {
  idb.store.clear();
  fetchCatalog.mockReset();
  setOnline(true);
});

describe("combos ride the cached catalog unchanged", () => {
  it("a 200 fetch persists the FULL payload — combos and isCombo survive the write", async () => {
    fetchCatalog.mockResolvedValue({ status: 200, data: COMBO_CATALOG, etag: 'W/"v1"' });
    const r = await loadCatalog();
    expect(r.catalog.combos).toEqual(COMBO_CATALOG.combos);
    const stored = idb.store.get("catalog") as { data: Catalog };
    // Wholesale persistence — deep-equal to the server payload, no field stripping.
    expect(stored.data).toEqual(COMBO_CATALOG);
    expect(stored.data.combos?.[0].groups[0].options[1]).toEqual({ menuId: "M-JUICE", name: "عصير برتقال", priceDelta: 3 });
  });

  it("OFFLINE boot restores the cached copy with combos intact — offline combo sales work for free", async () => {
    idb.store.set("catalog", { data: COMBO_CATALOG, etag: 'W/"v1"', savedAt: Date.now() });
    setOnline(false);
    const r = await loadCatalog();
    expect(r.fromCache).toBe(true);
    expect(r.catalog).toBe(COMBO_CATALOG); // the very object — nothing rebuilt or filtered
    expect(r.catalog.combos).toHaveLength(1);
    expect(r.catalog.items[0].isCombo).toBe(true);
  });

  it("a 304 keeps serving the cached combos", async () => {
    idb.store.set("catalog", { data: COMBO_CATALOG, etag: 'W/"v1"', savedAt: Date.now() });
    fetchCatalog.mockResolvedValue({ status: 304 });
    const r = await loadCatalog();
    expect(r.catalog.combos).toEqual(COMBO_CATALOG.combos);
  });

  it("a pre-combos catalog (no combos field) still loads — the field is optional end-to-end", async () => {
    const legacy = { items: [], categories: [], vatRate: 15, maxCashierDiscountPct: 10, serverTime: "" } as unknown as Catalog;
    idb.store.set("catalog", { data: legacy, etag: null, savedAt: Date.now() });
    setOnline(false);
    const r = await loadCatalog();
    expect(r.catalog.combos).toBeUndefined();
  });
});
