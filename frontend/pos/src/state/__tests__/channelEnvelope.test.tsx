/**
 * THE actual «مشكلة لا تنحل»: selecting a sales channel emptied the register.
 *
 * routes/pos-v2.js:1027 answers `{ success: true, data: <catalog> }`. The base
 * catalog path has always unwrapped that (lib/api.ts:110 `body.data`). The
 * CHANNEL path did not — `const data = (await res.json()) as Catalog` took the
 * envelope itself, and the `as Catalog` cast silenced the exact type error that
 * would have caught it.
 *
 * So every SUCCESSFUL channel selection produced a catalog with:
 *   items        → undefined  ⇒ an empty product grid
 *   channels     → undefined  ⇒ the channel picker disappears entirely
 *                              (App.tsx: showChannelPicker = channels.length >= 1)
 *   paymentMethods → undefined ⇒ the payment dialog falls back to built-ins
 *
 * And it would not resolve, because the write-through then stored the envelope
 * in the SHARED IndexedDB catalog slot: every reload and every offline boot
 * served the poison back, and re-poisoned it on the next fetch. The one control
 * that could have undone the choice — the picker — was gone.
 *
 * Every existing channel test missed this because their harnesses stub the
 * UNWRAPPED shape, which is not what the server sends. These stub the real one.
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

import { PosProvider, usePos, unwrapCatalog, type PosContextValue } from "../store";

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

/** EXACTLY what routes/pos-v2.js:1027 puts on the wire. */
function stubServerResponse(catalog: Catalog) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: catalog }),
  }));
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

describe("selecting a channel against the REAL server envelope", () => {
  it("serves the channel's items instead of an empty grid", async () => {
    stubServerResponse(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());

    act(() => ctx.setChannel("CH1"));

    await waitFor(() => expect(ctx.catalog?.items?.[0]?.price).toBe(30));
    expect(ctx.catalog?.items).toHaveLength(1);
  });

  it("keeps the channel picker on screen — the only control that can undo the choice", async () => {
    stubServerResponse(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());

    act(() => ctx.setChannel("CH1"));

    await waitFor(() => expect(ctx.catalog?.items?.[0]?.price).toBe(30));
    // App renders the picker only when channels.length >= 1. Undefined here is
    // what made the wedge unrecoverable from the screen.
    expect(ctx.channels).toEqual([{ id: "CH1", name: "هنقرستيشن" }]);
  });

  it("writes the CATALOG to the shared cache slot, never the envelope", async () => {
    stubServerResponse(CH1_CATALOG);
    renderStore();
    await waitFor(() => expect(ctx.catalog).not.toBeNull());

    act(() => ctx.setChannel("CH1"));
    await waitFor(() => expect(h.idbPut).toHaveBeenCalled());

    const written = h.idbPut.mock.calls.at(-1) as unknown as [string, string, { data: Catalog }];
    // The poison that survived every reload and every offline boot.
    expect(Array.isArray(written[2].data.items)).toBe(true);
    expect((written[2].data as unknown as { success?: boolean }).success).toBeUndefined();
  });
});

describe("unwrapCatalog accepts both shapes and rejects neither-shape", () => {
  it("unwraps the server envelope", () => {
    expect(unwrapCatalog({ success: true, data: CH1_CATALOG })).toEqual(CH1_CATALOG);
  });

  it("passes a bare catalog through — what every test harness and older server sends", () => {
    expect(unwrapCatalog(CH1_CATALOG)).toEqual(CH1_CATALOG);
  });

  it("returns null for something that is neither, rather than a catalog with no items", () => {
    expect(unwrapCatalog({ success: false, error: "boom" })).toBeNull();
    expect(unwrapCatalog(null)).toBeNull();
    expect(unwrapCatalog("nope")).toBeNull();
  });
});
