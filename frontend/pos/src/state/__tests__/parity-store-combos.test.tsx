/**
 * Parity — العروض (combos) through the REAL PosProvider:
 *   combo-chooser-open   : addItem on an isCombo item opens the chooser, adds NOTHING;
 *   combo-defs-cache     : the definition comes from the catalog payload (Catalog.combos);
 *   combo-finalize       : confirm writes ONE line with frozen comboChoices, the
 *                          human notes summary, and the delta-adjusted price;
 *   stacking             : identical picks merge (qty+1); different picks split;
 *   missing definition   : stale pre-combos cache → toast, nothing added.
 * Auth / catalog / api / offline modules are mocked; the provider itself runs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogItem, ComboDef } from "@/lib/types";
import { makeFakeEngine } from "../../components/__tests__/parityTestkit";

const engine = makeFakeEngine();

const COMBO_ITEM: CatalogItem = {
  id: "M-COMBO",
  name: "وجبة شاورما",
  price: 35,
  category: "عروض",
  active: true,
  taxCategory: "S",
  isCombo: true,
};
const ORPHAN_COMBO: CatalogItem = { ...COMBO_ITEM, id: "M-ORPHAN", name: "عرض بلا تعريف" };
const COMBO_DEF: ComboDef = {
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
};

vi.mock("@/lib/auth", () => ({
  currentUser: () => ({ username: "cashier1", role: "cashier" }),
  isSupervisor: () => false,
}));
vi.mock("@/lib/offline", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/offline")>();
  return { ...mod, getEngine: () => engine };
});
vi.mock("@/lib/catalogCache", () => ({
  loadCatalog: vi.fn(async () => ({
    catalog: {
      items: [COMBO_ITEM, ORPHAN_COMBO],
      categories: ["عروض"],
      combos: [COMBO_DEF],
      vatRate: 15,
      maxCashierDiscountPct: 10,
      serverTime: "",
    },
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

let ctx: PosContextValue;
function Probe() {
  ctx = usePos();
  return null;
}

async function renderStore() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <PosProvider>
        <Probe />
      </PosProvider>
    </QueryClientProvider>,
  );
  // The intercept needs the combo defs — wait for the catalog query to land.
  await waitFor(() => expect(ctx.catalog).not.toBeNull());
  return utils;
}

beforeEach(() => cleanup());

describe("combo-chooser-open — tapping a combo opens the chooser, adds nothing", () => {
  it("addItem(isCombo) renders the ComboDialog and the cart stays EMPTY", async () => {
    await renderStore();
    act(() => ctx.addItem(COMBO_ITEM));
    expect(screen.getByRole("dialog", { name: "وجبة شاورما — 35.00 ر.س" })).toBeInTheDocument();
    expect(ctx.cart.lines).toHaveLength(0);
  });

  it("closing the chooser leaves the cart untouched", async () => {
    await renderStore();
    act(() => ctx.addItem(COMBO_ITEM));
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ctx.cart.lines).toHaveLength(0);
  });
});

describe("combo-finalize — frozen comboChoices + notes summary on the line", () => {
  it("confirm writes ONE line: comboChoices shape, notes, delta-adjusted price", async () => {
    await renderStore();
    act(() => ctx.addItem(COMBO_ITEM));
    fireEvent.click(screen.getByRole("button", { name: /عصير برتقال/ }));
    fireEvent.click(screen.getByTestId("combo-confirm"));
    expect(screen.queryByRole("dialog")).toBeNull(); // chooser closed
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]).toMatchObject({
      menuId: "M-COMBO",
      name: "وجبة شاورما",
      qty: 1,
      unitPrice: 38, // 35 + 3 (عصير)
      notes: "عصير برتقال",
      comboChoices: { "G-DRINK": ["M-JUICE"] },
      vatCategory: "S",
    });
  });

  it("identical picks STACK (qty+1, one line); different picks get their own line", async () => {
    await renderStore();
    // twice the same pick
    for (let i = 0; i < 2; i++) {
      act(() => ctx.addItem(COMBO_ITEM));
      fireEvent.click(screen.getByRole("button", { name: /بيبسي/ }));
      fireEvent.click(screen.getByTestId("combo-confirm"));
    }
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]).toMatchObject({ qty: 2, unitPrice: 35, comboChoices: { "G-DRINK": ["M-PEPSI"] } });
    // a different pick splits
    act(() => ctx.addItem(COMBO_ITEM));
    fireEvent.click(screen.getByRole("button", { name: /عصير برتقال/ }));
    fireEvent.click(screen.getByTestId("combo-confirm"));
    expect(ctx.cart.lines).toHaveLength(2);
    expect(ctx.cart.lines[1]).toMatchObject({ qty: 1, unitPrice: 38, comboChoices: { "G-DRINK": ["M-JUICE"] } });
  });
});

describe("combo-defs-cache — the definition must exist in the catalog payload", () => {
  it("an isCombo item with NO definition (stale pre-combos cache) → toast, nothing added", async () => {
    await renderStore();
    act(() => ctx.addItem(ORPHAN_COMBO));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ctx.cart.lines).toHaveLength(0);
    expect(ctx.toasts.some((t) => t.kind === "error" && t.message.includes("خيارات العرض غير متوفرة"))).toBe(true);
  });

  it("normal (non-combo) items still add directly — the intercept is combo-only", async () => {
    await renderStore();
    const plain: CatalogItem = { id: "M-TEA", name: "شاي", price: 5, category: "مشروبات", active: true, taxCategory: "S" };
    act(() => ctx.addItem(plain));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]).toMatchObject({ menuId: "M-TEA", qty: 1 });
    expect("comboChoices" in ctx.cart.lines[0]).toBe(false); // normal lines never carry the field
  });
});
