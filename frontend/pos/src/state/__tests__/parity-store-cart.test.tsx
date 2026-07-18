/**
 * Parity — السلة (cart): the REAL PosProvider cart reducer logic, pinned
 * against the legacy matrix rows:
 *   cart-add-item (merge same item), cart-line-identity (unit / notes /
 *   discount separate lines), cart-qty-stepper semantics (qty ≤ 0 removes),
 *   cart-line-discount-reindex (discounts live ON the line — removal cannot
 *   desynchronise), cart-math-effective-invoice-discount (totals recompute),
 *   order-type switching (dine_in table cleared on switch).
 * Auth / catalog / api / offline modules are mocked; the provider itself runs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogItem } from "@/lib/types";
import { makeFakeEngine } from "../../components/__tests__/parityTestkit";

const engine = makeFakeEngine();

vi.mock("@/lib/auth", () => ({
  currentUser: () => ({ username: "cashier1", role: "cashier" }),
  isSupervisor: () => false,
  getToken: () => "tok-test",
}));
vi.mock("@/lib/idb", () => ({
  idbGet: vi.fn(async () => undefined),
  idbPut: vi.fn(async () => {}),
}));
vi.mock("@/lib/offline", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/offline")>();
  return { ...mod, getEngine: () => engine };
});
vi.mock("@/lib/catalogCache", () => ({
  loadCatalog: vi.fn(async () => ({
    catalog: { items: [], categories: [], vatRate: 15, maxCashierDiscountPct: 10, serverTime: "" },
    fromCache: false,
    savedAt: Date.now(),
    ageMs: 0,
    stale: false,
  })),
}));
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  openShift: vi.fn(),
  findOpenShift: vi.fn(async () => "SH-77"),
  getServerFlags: vi.fn(async () => ({ orderToCash: false })),
}));

import { PosProvider, usePos, type PosContextValue } from "../store";

const TEA: CatalogItem = { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S" };
const TAGINE: CatalogItem = { id: "M2", name: "طاجين لحم", price: 86, category: "أطباق", active: true, taxCategory: "S" };
const BOXED: CatalogItem = {
  id: "M9",
  name: "مياه",
  price: 2,
  category: "مشروبات",
  active: true,
  taxCategory: "S",
  baseUnitName: "حبة",
  units: [
    { unitId: "U1", unitCode: "PC", unitName: "حبة", isBase: true, factor: 1, barcode: null },
    { unitId: "U2", unitCode: "CTN", unitName: "كرتون", isBase: false, factor: 24, barcode: "629CTN" },
  ],
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

beforeEach(() => cleanup());

describe("cart-add-item + cart-line-identity — merge rules", () => {
  it("adding the same item twice merges into ONE line with qty 2", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TEA));
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]).toMatchObject({ menuId: "M1", qty: 2, unitPrice: 23 });
  });

  it("different items get separate lines", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TAGINE));
    expect(ctx.cart.lines).toHaveLength(2);
  });

  it("the same product in a DIFFERENT unit stays a separate line (carton ≠ piece)", () => {
    renderStore();
    act(() => ctx.addItem(BOXED)); // base (حبة)
    act(() => ctx.addItem(BOXED, "CTN")); // carton
    expect(ctx.cart.lines).toHaveLength(2);
    expect(ctx.cart.lines[0]).toMatchObject({ enteredUnitCode: "PC", baseQty: 1 });
    expect(ctx.cart.lines[1]).toMatchObject({ enteredUnitCode: "CTN", conversionFactorSnapshot: 24, baseQty: 24 });
    // and re-adding the carton merges into the CARTON line only
    act(() => ctx.addItem(BOXED, "CTN"));
    expect(ctx.cart.lines).toHaveLength(2);
    expect(ctx.cart.lines[1].qty).toBe(2);
    expect(ctx.cart.lines[1].baseQty).toBe(48);
  });

  it("a line with kitchen notes is NOT merged into (identity includes notes)", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.setLineNotes(0, "بدون سكر"));
    act(() => ctx.addItem(TEA));
    expect(ctx.cart.lines).toHaveLength(2);
    expect(ctx.cart.lines[0].notes).toBe("بدون سكر");
    expect(ctx.cart.lines[1].notes).toBeNull();
  });

  it("a line with a line-discount is NOT merged into (identity includes discount)", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.setLineDiscount(0, 3));
    act(() => ctx.addItem(TEA));
    expect(ctx.cart.lines).toHaveLength(2);
  });
});

describe("cart-qty-stepper semantics — qty ≤ 0 removes the line", () => {
  it("setQty(index, 0) drops the line entirely", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.setQty(0, 0));
    expect(ctx.cart.lines).toHaveLength(0);
  });

  it("setQty recomputes baseQty through the frozen factor", () => {
    renderStore();
    act(() => ctx.addItem(BOXED, "CTN"));
    act(() => ctx.setQty(0, 3));
    expect(ctx.cart.lines[0].baseQty).toBe(72); // 3 × 24
  });
});

describe("cart-line-discount-reindex — obsolete by construction in React", () => {
  it("removing line 0 keeps line 1's discount attached (discount lives ON the line)", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TAGINE));
    act(() => ctx.setLineDiscount(1, 5));
    act(() => ctx.removeLine(0));
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]).toMatchObject({ menuId: "M2", lineDiscount: 5 });
  });
});

describe("cart-math-effective-invoice-discount — totals recompute on every change", () => {
  it("PERCENT 10 on a 46.00 cart → discount 4.60, total 41.40; clearing restores", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.setQty(0, 2)); // 2 × 23 = 46
    act(() => ctx.setDiscount("PERCENT", 10, "عرض"));
    expect(ctx.totals.discountAmount).toBe(4.6);
    expect(ctx.totals.total).toBe(41.4);
    act(() => ctx.setDiscount(null, 0, null));
    expect(ctx.totals.discountAmount).toBe(0);
    expect(ctx.totals.total).toBe(46);
  });
});

describe("order type — dine_in table number is cleared when leaving dine_in", () => {
  it("switching away from dine_in nulls tableNo", () => {
    renderStore();
    act(() => ctx.setOrderType("dine_in"));
    act(() => ctx.setTableNo("12"));
    expect(ctx.cart.tableNo).toBe("12");
    act(() => ctx.setOrderType("takeaway"));
    expect(ctx.cart.tableNo).toBeNull();
  });
});

describe("startNewOrder — a fresh doc, old lines gone", () => {
  it("resets the cart to an empty open order with a NEW id", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    const oldId = ctx.cart.id;
    act(() => ctx.startNewOrder());
    expect(ctx.cart.lines).toHaveLength(0);
    expect(ctx.cart.id).not.toBe(oldId);
    expect(ctx.cart.status).toBe("open");
  });
});
