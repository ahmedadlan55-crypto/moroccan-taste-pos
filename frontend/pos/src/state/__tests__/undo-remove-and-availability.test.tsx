/**
 * Two store behaviours that only the REAL PosProvider can prove:
 *
 *   1. UNDO A REMOVED LINE. Removing a line was instant, silent and
 *      irreversible — while voiding a whole order demands a typed reason. Every
 *      removal path (trash, stepper → 0, the card's inline −, the QtyPad's
 *      "set 0") must now raise a toast carrying a one-tap restore that puts the
 *      line back AT ITS ORIGINAL INDEX with its notes, lineDiscount and
 *      comboChoices intact.
 *
 *   2. THE 86 BOARD DEGRADES SILENTLY. A 404/403/offline availability call must
 *      leave the till exactly as it was — no error toast, no retry storm, and
 *      every card falling back to CatalogItem.warehouseQty.
 *
 * Auth / catalog / api / offline are mocked; the provider itself runs.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CatalogItem, MenuAvailabilityMap } from "@/lib/types";
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

const fetchMenuAvailabilityBulk = vi.fn(async (): Promise<MenuAvailabilityMap> => ({}));
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  openShift: vi.fn(),
  findOpenShift: vi.fn(async () => "SH-77"),
  getServerFlags: vi.fn(async () => ({ orderToCash: false })),
  fetchMenuAvailabilityBulk: (...a: unknown[]) => fetchMenuAvailabilityBulk(...(a as [])),
}));

import { PosProvider, restoreLineAt, usePos, type PosContextValue } from "../store";
import { clearQuickPicks, getQuickPicks } from "@/lib/quickPicks";
import { publishAvailability } from "@/components/StockPip";

const TEA: CatalogItem = { id: "M1", name: "شاي مغربي", price: 23, category: "مشروبات", active: true, taxCategory: "S", taxInclusive: true };
const TAGINE: CatalogItem = { id: "M2", name: "طاجين لحم", price: 86, category: "أطباق", active: true, taxCategory: "S", taxInclusive: true };

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

/** The undo affordance lives in the provider's own bottom snackbar. */
const undoButton = () => screen.getByRole("button", { name: /تراجع/ });

beforeEach(() => {
  cleanup();
  localStorage.clear();
  clearQuickPicks();
  publishAvailability(null);
  fetchMenuAvailabilityBulk.mockReset();
  fetchMenuAvailabilityBulk.mockResolvedValue({});
});
afterEach(() => publishAvailability(null));

// ── 1. Undo a removed line ──────────────────────────────────────────────────
describe("restoreLineAt — pure re-insertion", () => {
  const L = (id: string) => ({ menuId: id, name: id, qty: 1, unitPrice: 1, lineDiscount: 0, vatCategory: "S" as const, notes: null });

  it("puts the line back at its original index, not at the end", () => {
    expect(restoreLineAt([L("A"), L("C")], L("B"), 1).map((l) => l.menuId)).toEqual(["A", "B", "C"]);
  });

  it("clamps when the cart shrank further before the undo was tapped", () => {
    expect(restoreLineAt([], L("B"), 7).map((l) => l.menuId)).toEqual(["B"]);
    expect(restoreLineAt([L("A")], L("B"), -3).map((l) => l.menuId)).toEqual(["B", "A"]);
  });
});

describe("undo — the trash button", () => {
  it("offers a restore that returns the line WITH its notes and line discount", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TAGINE));
    act(() => ctx.setLineNotes(0, "بدون سكر"));
    act(() => ctx.setLineDiscount(0, 3));

    act(() => ctx.removeLine(0));
    expect(ctx.cart.lines).toHaveLength(1);
    expect(ctx.cart.lines[0]!.menuId).toBe("M2");

    // The affordance the old flow simply did not have.
    expect(screen.getByText(/تم حذف/)).toBeInTheDocument();
    act(() => {
      fireEvent.click(undoButton());
    });

    expect(ctx.cart.lines).toHaveLength(2);
    expect(ctx.cart.lines[0]).toMatchObject({ menuId: "M1", notes: "بدون سكر", lineDiscount: 3 });
    expect(ctx.cart.lines[1]!.menuId).toBe("M2"); // restored AT ITS INDEX
  });

  it("keeps comboChoices — a rebuilt line would silently lose the picks", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.loadOrderDoc({
      ...ctx.cart,
      lines: [{ ...ctx.cart.lines[0]!, comboChoices: { G1: ["OPT-A"] }, notes: "مع عصير" }],
    }));
    act(() => ctx.removeLine(0));
    act(() => {
      fireEvent.click(undoButton());
    });
    expect(ctx.cart.lines[0]).toMatchObject({ comboChoices: { G1: ["OPT-A"] }, notes: "مع عصير" });
  });

  it("the toast disappears once undone — a spent action must not linger", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.removeLine(0));
    act(() => {
      fireEvent.click(undoButton());
    });
    expect(screen.queryByRole("button", { name: /تراجع/ })).not.toBeInTheDocument();
  });
});

describe("undo — the other removal paths", () => {
  it("stepper/QtyPad → setQty(index, 0) is undoable", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TAGINE));
    act(() => ctx.setQty(1, 0));
    expect(ctx.cart.lines).toHaveLength(1);
    act(() => {
      fireEvent.click(undoButton());
    });
    expect(ctx.cart.lines.map((l) => l.menuId)).toEqual(["M1", "M2"]);
  });

  it("the card's inline − removing the LAST unit is undoable", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.setLineNotes(0, "سخن"));
    act(() => ctx.decrementItem("M1"));
    expect(ctx.cart.lines).toHaveLength(0);
    act(() => {
      fireEvent.click(undoButton());
    });
    expect(ctx.cart.lines[0]).toMatchObject({ menuId: "M1", qty: 1, notes: "سخن" });
  });

  it("a decrement that does NOT remove offers no undo (nothing was lost)", () => {
    renderStore();
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TEA)); // qty 2
    act(() => ctx.decrementItem("M1"));
    expect(ctx.cart.lines[0]!.qty).toBe(1);
    expect(screen.queryByRole("button", { name: /تراجع/ })).not.toBeInTheDocument();
  });

  it("removing a non-existent index is a silent no-op, not a phantom toast", () => {
    renderStore();
    act(() => ctx.removeLine(4));
    expect(screen.queryByRole("button", { name: /تراجع/ })).not.toBeInTheDocument();
  });
});

describe("the toast action API (pushToast's third argument)", () => {
  it("an actionable toast is routed AWAY from `toasts`, so nothing paints twice", () => {
    renderStore();
    act(() => ctx.pushToast("info", "رسالة", { label: "تراجع", onClick: vi.fn() }));
    // <Toasts/> renders ctx.toasts; an actionable toast must not be in there or
    // the same message would appear in both stacks.
    expect(ctx.toasts).toHaveLength(0);
    expect(screen.getByText("رسالة")).toBeInTheDocument();
    expect(undoButton()).toBeInTheDocument();
  });

  it("every existing TWO-argument call site still lands in `toasts` unchanged", () => {
    renderStore();
    act(() => ctx.pushToast("error", "فشل"));
    expect(ctx.toasts).toHaveLength(1);
    expect(ctx.toasts[0]).toMatchObject({ kind: "error", message: "فشل" });
    expect(ctx.toasts[0]!.action).toBeUndefined();
  });

  it("dismissToast clears an actionable toast too", () => {
    renderStore();
    const onClick = vi.fn();
    act(() => ctx.pushToast("info", "رسالة", { label: "تراجع", onClick }));
    act(() => ctx.dismissToast(ctx.toasts.length + 1e9)); // unknown id → no crash
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "إغلاق التنبيه" }));
    });
    expect(screen.queryByText("رسالة")).not.toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });
});

// ── 2. Availability + the local tally ───────────────────────────────────────
/**
 * THE 86 BOARD IS OFF for this menu.
 *
 * What used to be pinned here — the map is fetched and published, and adding an
 * unavailable item warns once — described a feature that was WRONG about almost
 * every row on this owner's menu: the verdict comes from RAW STOCK and every
 * sellable item here is built from a recipe. It marked the grid unavailable
 * while all of it was sellable, so the owner asked for it to stop while he was
 * running the register.
 *
 * The query is disabled and the warn is a no-op (state/store.tsx). The engine,
 * the endpoint and resolveStockState all remain, tested in
 * components/__tests__/stockPip.test.tsx, for a menu that sells shelf goods.
 * What is pinned now is that the till neither calls it nor speaks about it.
 */
describe("the 86 board is not wired", () => {
  it("never calls the availability endpoint — no per-catalog recipe walk", async () => {
    fetchMenuAvailabilityBulk.mockResolvedValue({
      M1: { mode: "mto", makeable: 0, isOutOfStock: true, isLowStock: false, blockerCount: 1, hasRecipe: true },
    });
    renderStore();
    await waitFor(() => expect(ctx.cart).toBeTruthy());
    expect(fetchMenuAvailabilityBulk).not.toHaveBeenCalled();
  });

  it("adds an item the board would call unavailable, and says nothing", async () => {
    fetchMenuAvailabilityBulk.mockResolvedValue({
      M1: { mode: "mto", makeable: 0, isOutOfStock: true, isLowStock: false, blockerCount: 2, hasRecipe: true },
    });
    renderStore();
    await waitFor(() => expect(ctx.cart).toBeTruthy());

    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TEA));

    expect(ctx.cart.lines[0]!.qty).toBe(2);
    expect(ctx.toasts.filter((t) => t.message.includes("غير متاح"))).toHaveLength(0);
  });
});

describe("the top-sellers tally", () => {
  it("records a pick when a cart line is actually created", () => {
    renderStore();
    act(() => ctx.addItem(TAGINE));
    act(() => ctx.addItem(TEA));
    act(() => ctx.addItem(TEA));
    expect(getQuickPicks()).toEqual(["M1", "M2"]);
  });

  it("does NOT record when a combo only opens its chooser", () => {
    renderStore();
    // No combo definition in this (empty) catalog → addItem refuses and toasts.
    act(() => ctx.addItem({ ...TEA, id: "C1", isCombo: true }));
    expect(getQuickPicks()).toEqual([]);
  });
});
