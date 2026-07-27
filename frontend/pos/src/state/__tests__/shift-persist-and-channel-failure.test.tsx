/**
 * Regression — three PosProvider defects, exercised against the REAL provider.
 *
 * DEFECT 3 — the shift is lost after an OFFLINE COLD BOOT, and payment dies
 *   from the SECOND order on.
 *   The open-shift query is gated on `engineStatus.online`, so offline it never
 *   runs and `shiftId` stays null forever. `startNewOrder()` then stamps every
 *   new cart with null. Order #1 of such a boot survived only by accident — it
 *   is restored from IndexedDB carrying its own stored shiftId — so the failure
 *   first shows up on order #2, which is exactly when it is hardest to explain.
 *   The last server-confirmed open shift is now mirrored to localStorage and
 *   used to seed the offline id. It stays a CACHE: routes/sales.js:486-511
 *   re-validates the shift on every sale/replay, so a stale id fails loudly at
 *   sync (shift_not_found / shift_closed / shift_owner_mismatch), never silently.
 *
 * DEFECT 5 — a failed channel fetch sold at BASE prices while the channel still
 *   looked selected. `loadCatalogForChannel` caught everything and returned
 *   `loadCatalog()` flagged `fromCache:false, stale:false` — a clean bill of
 *   health for a catalog that is NOT the channel's price list.
 *
 * DEFECT 1/4 (exposure half) — `vatRatePct` and the coded catalog error are now
 *   on the context, which is what lets CartPanel and DiscountDialog charge the
 *   server's real rate and what turns "stale catalog" into "session expired".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Catalog, CatalogItem, LocalOrder } from "@/lib/types";
import { makeFakeEngine, makeOrder } from "../../components/__tests__/parityTestkit";

const h = vi.hoisted(() => ({
  loadCatalog: vi.fn<() => Promise<unknown>>(),
  idbPut: vi.fn(async () => {}),
  findOpenShift: vi.fn<() => Promise<string | null>>(),
  latestOpenOrder: vi.fn<() => Promise<LocalOrder | undefined>>(async () => undefined),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: () => ({ username: "cashier1", role: "cashier" }),
  isSupervisor: () => false,
  getToken: () => "tok-test",
}));
vi.mock("@/lib/capabilities", () => ({
  fetchEffectiveCaps: vi.fn(async () => null),
  posCan: () => false,
}));
// Keep the REAL CatalogError class — the provider does `instanceof` on it to
// derive the error code, so a stubbed module would silently defeat the test.
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
  findOpenShift: h.findOpenShift,
  getServerFlags: vi.fn(async () => ({ orderToCash: false })),
}));

let engine = makeFakeEngine();
vi.mock("@/lib/offline", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/offline")>();
  return { ...mod, getEngine: () => engine };
});

import { CatalogError } from "@/lib/catalogCache";
import { PosProvider, usePos, type PosContextValue } from "../store";

const SHIFT_KEY = "pos_v2_last_open_shift_id";

const TEA: CatalogItem = { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" };
const BASE_CATALOG: Catalog = {
  items: [TEA],
  categories: ["مشروبات"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  channels: [{ id: "CH1", name: "هنقرستيشن" }],
  serverTime: "",
};
const CH1_CATALOG: Catalog = { ...BASE_CATALOG, items: [{ ...TEA, price: 30, priceSource: "قائمة التطبيقات" }] };

let ctx: PosContextValue;
function Probe() {
  ctx = usePos();
  return null;
}

/** `online` drives engineStatus, which is what gates the open-shift query. */
function renderStore(opts: { online?: boolean } = {}) {
  engine = makeFakeEngine({ status: { online: opts.online ?? true } });
  engine.latestOpenOrder = h.latestOpenOrder as unknown as typeof engine.latestOpenOrder;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PosProvider>
        <Probe />
      </PosProvider>
    </QueryClientProvider>,
  );
}

function stubChannelFetch(catalog: Catalog | Error | { status: number }) {
  const fn = vi.fn(async () => {
    if (catalog instanceof Error) throw catalog;
    if ("status" in catalog && typeof catalog.status === "number") {
      return { ok: false, status: catalog.status, json: async () => ({}) };
    }
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
  h.findOpenShift.mockReset();
  h.latestOpenOrder.mockReset();
  h.latestOpenOrder.mockResolvedValue(undefined);
  h.findOpenShift.mockResolvedValue("SH-77");
  h.loadCatalog.mockImplementation(async () => ({
    catalog: BASE_CATALOG,
    fromCache: false,
    savedAt: Date.now(),
    ageMs: 0,
    stale: false,
  }));
});

afterEach(() => vi.unstubAllGlobals());

// ───────────────────────────────────────────────────────────────────────────
describe("defect 3 — the shift survives an offline cold boot", () => {
  it("a successful findOpenShift is mirrored to localStorage", async () => {
    h.findOpenShift.mockResolvedValue("SH-99");
    renderStore({ online: true });
    await waitFor(() => expect(ctx.shiftId).toBe("SH-99"));
    expect(localStorage.getItem(SHIFT_KEY)).toBe("SH-99");
  });

  it("OFFLINE COLD BOOT: TWO consecutive startNewOrder() calls both carry the shift", async () => {
    // The exact production sequence: a terminal that was online (so the id was
    // remembered) reboots with no network. The shift query never runs at all.
    localStorage.setItem(SHIFT_KEY, "SH-77");
    renderStore({ online: false });
    await waitFor(() => expect(ctx.catalog).not.toBeNull());

    // The provider seeds shiftId from the remembered value while offline.
    expect(ctx.shiftId).toBe("SH-77");

    act(() => ctx.startNewOrder());
    expect(ctx.cart.shiftId).toBe("SH-77"); // order #1

    // THE REGRESSION: this one used to be null, and its payment 400'd with
    // shift_required while order #1 had gone through fine.
    act(() => ctx.startNewOrder());
    expect(ctx.cart.shiftId).toBe("SH-77"); // order #2
  });

  it("with no remembered id, a new order inherits the RESTORED doc's shift", async () => {
    // The last-resort arm of `shiftId ?? persisted ?? cart.shiftId` — the only
    // reason order #1 ever worked before this fix, now made explicit.
    h.latestOpenOrder.mockResolvedValue(makeOrder({ shiftId: "SH-55" }));
    renderStore({ online: false });
    await waitFor(() => expect(ctx.cart.shiftId).toBe("SH-55"));

    act(() => ctx.startNewOrder());
    expect(ctx.cart.shiftId).toBe("SH-55");
    act(() => ctx.startNewOrder());
    expect(ctx.cart.shiftId).toBe("SH-55");
  });

  it("the SERVER still wins: a resolved null closes the shift despite a remembered id", async () => {
    // A shift closed on another terminal must not be resurrected from cache.
    localStorage.setItem(SHIFT_KEY, "SH-77");
    h.findOpenShift.mockResolvedValue(null);
    renderStore({ online: true });
    await waitFor(() => expect(localStorage.getItem(SHIFT_KEY)).toBeNull());
    expect(ctx.shiftId).toBeNull();
  });

  it("a corrupted/oversized stored value is ignored rather than sent to the server", async () => {
    localStorage.setItem(SHIFT_KEY, "x".repeat(500));
    renderStore({ online: false });
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    expect(ctx.shiftId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("defect 5 — a failed channel fetch stops claiming the channel is active", () => {
  it("a SUCCESSFUL channel load reports the channel as the one actually pricing the grid", async () => {
    stubChannelFetch(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    act(() => ctx.setChannel("CH1"));
    await waitFor(() => expect(ctx.catalog?.items[0]?.price).toBe(30));
    expect(ctx.activeChannelId).toBe("CH1");
    expect(ctx.channelPricesUnavailable).toBe(false);
  });

  it("a FAILED channel fetch keeps selling but flags that these are NOT the channel's prices", async () => {
    stubChannelFetch(new Error("network down"));
    localStorage.setItem("pos_v2_channel_id", "CH1");
    renderStore();

    // Still sells — base/cached prices, never a blank grid (unchanged).
    await waitFor(() => expect(ctx.catalog?.items[0]?.price).toBe(23));
    // The cashier's persisted PREFERENCE is deliberately untouched…
    expect(ctx.channelId).toBe("CH1");
    // …but the channel is NOT active, and the UI can now say so.
    expect(ctx.activeChannelId).toBeNull();
    expect(ctx.channelPricesUnavailable).toBe(true);
  });

  it("a non-OK channel response is a failure too, not a silent base-price sale", async () => {
    stubChannelFetch({ status: 500 });
    localStorage.setItem("pos_v2_channel_id", "CH1");
    renderStore();
    await waitFor(() => expect(ctx.channelPricesUnavailable).toBe(true));
    expect(ctx.activeChannelId).toBeNull();
  });

  it("the base channel is never 'unavailable' — there is nothing to fail", async () => {
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    expect(ctx.channelId).toBeNull();
    expect(ctx.activeChannelId).toBeNull();
    expect(ctx.channelPricesUnavailable).toBe(false);
  });

  it("a 401 during a channel fetch surfaces as an expired session, NOT as a pricing footnote", async () => {
    stubChannelFetch({ status: 401 });
    localStorage.setItem("pos_v2_channel_id", "CH1");
    renderStore();
    await waitFor(() => expect(ctx.catalogError).toBe("errors.SESSION_EXPIRED"));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("defects 1 + 4 — the exposed API the other surfaces consume", () => {
  it("vatRatePct is the SERVER's rate, so line/preview math can stop defaulting to 15", async () => {
    h.loadCatalog.mockImplementation(async () => ({
      catalog: { ...BASE_CATALOG, vatRate: 5 },
      fromCache: false,
      savedAt: Date.now(),
      ageMs: 0,
      stale: false,
    }));
    renderStore();
    await waitFor(() => expect(ctx.vatRatePct).toBe(5));
  });

  it("vatRatePct falls back to 15 only until the catalog resolves", () => {
    h.loadCatalog.mockImplementation(() => new Promise(() => {})); // never settles
    renderStore();
    expect(ctx.vatRatePct).toBe(15);
  });

  it("catalogError is a t()-able i18n PATH and catalogErrorObject carries the code", async () => {
    h.loadCatalog.mockRejectedValue(new CatalogError("SESSION_EXPIRED", "raw internal sentence"));
    renderStore();
    await waitFor(() => expect(ctx.catalogError).toBe("errors.SESSION_EXPIRED"));
    // NOT `.message` — that was the old behaviour and it is why an expired
    // session could never be told apart from a stale catalog.
    expect(ctx.catalogError).not.toBe("raw internal sentence");
    expect((ctx.catalogErrorObject as CatalogError).code).toBe("SESSION_EXPIRED");
  });

  it("an uncoded throw still resolves to a real key, never a raw path miss", async () => {
    h.loadCatalog.mockRejectedValue(new TypeError("Failed to fetch"));
    renderStore();
    await waitFor(() => expect(ctx.catalogError).toBe("errors.CATALOG_LOAD_FAILED"));
  });
});
