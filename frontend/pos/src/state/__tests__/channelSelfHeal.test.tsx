/**
 * A stored sales channel that the server no longer serves must NOT wedge the till.
 *
 * THE LIVE INCIDENT (the owner, on his own production till): «قمت باختيار قنوات
 * الدفع فحدث لي مشكلة لا تنحل» — picked a channel, hit a problem that would not
 * resolve, on every device, across every reload.
 *
 * The mechanism, exactly:
 *   • setChannel(X) persists X to localStorage (pos_v2_channel_id) and the store
 *     re-applies it on EVERY boot with no validation against the catalog's own
 *     channels[] list — state/store.tsx getStoredChannelId / the catalog query key.
 *   • If X is later deleted, deactivated, or simply unreachable, every boot
 *     refetches /api/pos/v2/catalog?channelId=X, fails, and falls back to the
 *     cached copy with channelPricesUnavailable:true — forever.
 *   • Meanwhile the PICKER hides the problem: App.tsx computes
 *     `activeChannelId = channels.some(c => c.id === channelId) ? channelId : null`
 *     so a dead id renders the select on «الأساسي» (Default). The one control
 *     that could clear the stored id already SHOWS it as cleared — and a <select>
 *     fires no change event when you re-pick the option it is already on.
 *
 * So the cashier is told they are on Default, is served the wrong prices, and
 * has no reachable action that changes anything. That is the "لا تنحل".
 *
 * These pin the self-heal: a stored channel the catalog does not list is DROPPED
 * — from state and from storage — so the next boot is genuinely default.
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

const CHANNEL_KEY = "pos_v2_channel_id";
const TEA: CatalogItem = { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" };
const BASE_CATALOG: Catalog = {
  items: [TEA],
  categories: ["مشروبات"],
  vatRate: 15,
  maxCashierDiscountPct: 10,
  channels: [{ id: "CH1", name: "هنقرستيشن" }],
  serverTime: "",
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

describe("a stored channel the server no longer lists heals itself", () => {
  it("drops it from state so the till is genuinely on the default", async () => {
    // The device as the owner left it: a channel id that no longer exists.
    localStorage.setItem(CHANNEL_KEY, "CH-DELETED");
    // Every attempt to serve that channel fails — the state that would not resolve.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    await waitFor(() => expect(ctx.channelId).toBeNull());
  });

  it("erases it from storage, so the NEXT boot is clean too", async () => {
    localStorage.setItem(CHANNEL_KEY, "CH-DELETED");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(localStorage.getItem(CHANNEL_KEY)).toBeNull());
  });

  it("stops claiming the channel's prices are merely 'unavailable' once healed", async () => {
    // The banner is honest while a REAL channel is unreachable, but for a channel
    // that no longer exists it is a permanent lie — there is nothing to come back.
    localStorage.setItem(CHANNEL_KEY, "CH-DELETED");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.channelId).toBeNull());
    await waitFor(() => expect(ctx.channelPricesUnavailable).toBe(false));
  });

  it("says so out loud — silently changing which price list rings up is not acceptable", async () => {
    localStorage.setItem(CHANNEL_KEY, "CH-DELETED");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.channelId).toBeNull());
    expect(ctx.toasts.some((t) => t.kind !== "success")).toBe(true);
  });

  it("leaves a LIVE channel alone — an outage is not a reason to change the price list", async () => {
    // CH1 exists in channels[]; the fetch is merely failing right now. Dropping it
    // would silently move the till from channel prices to base prices, which is
    // the opposite of safe.
    localStorage.setItem(CHANNEL_KEY, "CH1");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    await waitFor(() => expect(ctx.channelPricesUnavailable).toBe(true));
    expect(ctx.channelId).toBe("CH1");
    expect(localStorage.getItem(CHANNEL_KEY)).toBe("CH1");
  });
});

/**
 * The guard that matters more than the feature.
 *
 * The first cut of this fix tested "is the stored id in catalog.channels[]?" —
 * which reads as obviously right and is fleet-fatal. routes/pos-v2.js:964-972
 * ships `channels: []` on a plain 200 whenever the server's own channels query
 * throws ("Loud fallback: the catalog still serves the grid; the switcher is
 * empty"). One transient DB error would therefore have moved EVERY till with a
 * channel selected off channel pricing and onto base pricing, simultaneously —
 * manufacturing the exact pricing incident the fix exists to prevent.
 *
 * Only the server's explicit 422/404 verdict on THIS channel may drop it.
 */
describe("nothing but a server verdict may change which price list rings up", () => {
  it("an empty channels[] from a degraded catalog does NOT drop the channel", async () => {
    localStorage.setItem(CHANNEL_KEY, "CH1");
    // The fail-soft server response: 200, real items, switcher list empty.
    h.loadCatalog.mockImplementation(async () => ({
      catalog: { ...BASE_CATALOG, channels: [] },
      fromCache: false,
      savedAt: Date.now(),
      ageMs: 0,
      stale: false,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...BASE_CATALOG, channels: [] }),
    })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());
    expect(ctx.channelId).toBe("CH1");
    expect(localStorage.getItem(CHANNEL_KEY)).toBe("CH1");
  });

  it("a 500 is an outage, not a verdict — the channel is kept", async () => {
    localStorage.setItem(CHANNEL_KEY, "CH1");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.channelPricesUnavailable).toBe(true));
    expect(ctx.channelId).toBe("CH1");
    expect(localStorage.getItem(CHANNEL_KEY)).toBe("CH1");
  });

  it("a 422 clears storage even when the fallback load also fails", async () => {
    // The worst case: no cached catalog either, so the query REJECTS and the
    // picker never renders. Clearing inside the fetch — not in an effect — is
    // what stops the device booting into the same dead channel forever.
    localStorage.setItem(CHANNEL_KEY, "CH-DELETED");
    h.loadCatalog.mockImplementation(async () => {
      throw new Error("CATALOG_OFFLINE");
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(localStorage.getItem(CHANNEL_KEY)).toBeNull());
  });

  it("raises a notice that STAYS — a price list change is not a 5-second toast", async () => {
    localStorage.setItem(CHANNEL_KEY, "CH-DELETED");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) })) as unknown as typeof fetch);

    renderStore();
    await waitFor(() => expect(ctx.channelHealed).toBe(true));
    act(() => ctx.dismissChannelHealed());
    expect(ctx.channelHealed).toBe(false);
  });
});
