/**
 * Parity — قنوات البيع (close/w25-sell-ui): channel state in the REAL
 * PosProvider, pinned against the legacy flows in public/pos/app.js:
 *   channel-switch          V5.7.11 «Switching channels NEVER clears the cart»
 *                           (app.js:5025-5035) + _doSetChannel persists
 *                           pos_active_channel_id (app.js:5077)
 *   channel-price-resolution the SERVER resolves override → price list → base
 *                           and the client just serves the returned catalog
 *   offline-channel-menu-cache legacy cached channel menus in localStorage
 *                           (app.js:4972); v2 writes the channel catalog through
 *                           to the single IndexedDB slot → offline serves the
 *                           LAST-FETCHED channel (documented in the parity map)
 * Auth / catalogCache / idb / api / offline are mocked; the provider itself runs.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Catalog, CatalogItem } from "@/lib/types";
import { makeFakeEngine } from "../../components/__tests__/parityTestkit";

const engine = makeFakeEngine();

const h = vi.hoisted(() => ({
  loadCatalog: vi.fn<() => Promise<unknown>>(),
  idbPut: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: () => ({ username: "cashier1", role: "cashier" }),
  isSupervisor: () => false,
  getToken: () => "tok-test",
}));
vi.mock("@/lib/offline", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/offline")>();
  return { ...mod, getEngine: () => engine };
});
// Partial mock: only loadCatalog is stubbed. The store also imports the REAL
// CatalogError class (it rethrows SESSION_EXPIRED rather than degrading a 401
// to "channel prices unavailable"), and a wholesale mock would drop that export
// and blow up the provider on render.
vi.mock("@/lib/catalogCache", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/catalogCache")>();
  return { ...mod, loadCatalog: h.loadCatalog };
});
vi.mock("@/lib/idb", () => ({
  idbGet: vi.fn(async () => undefined),
  idbPut: h.idbPut,
}));
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  openShift: vi.fn(),
  findOpenShift: vi.fn(async () => "SH-77"),
  getServerFlags: vi.fn(async () => ({ orderToCash: false })),
}));

import { PosProvider, usePos, type PosContextValue } from "../store";

const TEA: CatalogItem = { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" };
const BASE_CATALOG: Catalog = {
  items: [TEA],
  categories: ["مشروبات"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  channels: [{ id: "CH1", name: "هنقرستيشن" }],
  serverTime: "",
};
const CH1_CATALOG: Catalog = {
  ...BASE_CATALOG,
  items: [{ ...TEA, price: 30, priceSource: "قائمة التطبيقات" }],
};

let ctx: PosContextValue;
function Probe() {
  ctx = usePos();
  return null;
}

function renderStore() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PosProvider>
        <Probe />
      </PosProvider>
    </QueryClientProvider>,
  );
}

function stubChannelFetch(catalog: Catalog | Error) {
  const fn = vi.fn(async () => {
    if (catalog instanceof Error) throw catalog;
    return { ok: true, status: 200, json: async () => catalog };
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  h.loadCatalog.mockReset();
  h.idbPut.mockClear();
  h.loadCatalog.mockImplementation(async () => ({
    catalog: BASE_CATALOG,
    fromCache: false,
    savedAt: Date.now(),
    ageMs: 0,
    stale: false,
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("channel state — channels ride in the catalog, base is the default", () => {
  it("exposes catalog.channels and starts on the implicit base (channelId null)", async () => {
    renderStore();
    await waitFor(() => expect(ctx.channels).toEqual([{ id: "CH1", name: "هنقرستيشن" }]));
    expect(ctx.channelId).toBeNull();
  });
});

describe("channel-switch — refetch with ?channelId= and NEVER clear the cart", () => {
  it("setChannel refetches /api/pos/v2/catalog?channelId=… with the POS token", async () => {
    const fetchFn = stubChannelFetch(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    act(() => ctx.setChannel("CH1"));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(String(url)).toBe("/api/pos/v2/catalog?channelId=CH1");
    expect(init.headers.Authorization).toBe("Bearer tok-test");
    await waitFor(() => expect(ctx.catalog?.items[0]?.priceSource).toBe("قائمة التطبيقات"));
  });

  it("the cart survives the switch untouched (same doc, same lines, frozen prices)", async () => {
    stubChannelFetch(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TEA));
    expect(ctx.cart.lines).toHaveLength(1);
    const cartId = ctx.cart.id;
    act(() => ctx.setChannel("CH1"));
    await waitFor(() => expect(ctx.catalog?.items[0]?.price).toBe(30));
    expect(ctx.cart.id).toBe(cartId);
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]).toMatchObject({ menuId: "M1", qty: 2, unitPrice: 23 });
    // …and a NEW add after the switch uses the channel price
    act(() => ctx.addItem(ctx.catalog!.items[0]!));
    expect(ctx.cart.lines[1]).toMatchObject({ menuId: "M1", unitPrice: 30 });
  });
});

describe("channel persistence — reload keeps the selected channel", () => {
  it("setChannel writes pos_v2_channel_id; the next boot restores it", async () => {
    stubChannelFetch(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    act(() => ctx.setChannel("CH1"));
    expect(localStorage.getItem("pos_v2_channel_id")).toBe("CH1");
    cleanup();
    renderStore(); // fresh mount = page reload
    await waitFor(() => expect(ctx.channelId).toBe("CH1"));
    await waitFor(() => expect(ctx.catalog?.items[0]?.price).toBe(30));
    // back to base clears the key
    act(() => ctx.setChannel(null));
    expect(localStorage.getItem("pos_v2_channel_id")).toBeNull();
  });
});

describe("offline-channel-menu-cache — write-through + honest degradation", () => {
  it("a fetched channel catalog is written through to the IDB slot (offline serves the last-fetched channel)", async () => {
    stubChannelFetch(CH1_CATALOG);
    renderStore();
    act(() => ctx.setChannel("CH1"));
    await waitFor(() => expect(h.idbPut).toHaveBeenCalled());
    const [store, key, value] = h.idbPut.mock.calls[0] as unknown as [string, string, { data: Catalog; etag: null }];
    expect(store).toBe("catalog");
    expect(key).toBe("catalog");
    expect(value.data).toEqual(CH1_CATALOG);
    expect(value.etag).toBeNull();
  });

  it("a failed channel fetch degrades to the cached loadCatalog copy — the grid never blanks", async () => {
    stubChannelFetch(new Error("network down"));
    localStorage.setItem("pos_v2_channel_id", "CH1");
    renderStore();
    await waitFor(() => expect(ctx.catalog?.items[0]?.price).toBe(23));
    expect(ctx.channelId).toBe("CH1");
    expect(h.loadCatalog).toHaveBeenCalled();
  });
});
