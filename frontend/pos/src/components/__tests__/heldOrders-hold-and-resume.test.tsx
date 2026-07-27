/**
 * dialogs/HeldOrdersDialog — resuming while the cart is NOT empty.
 *
 * The board used to refuse outright («علّق الطلب الحالي أو أفرغه قبل استعادة
 * طلب آخر»), leaving the cashier to do by hand the thing the software could
 * already do: close the board, tap تعليق, reopen the board, find the row, tap
 * استعادة. Five interactions with a queue at the till.
 *
 * It is now one action — and the ORDER of that action is the part that must
 * never regress: park the current cart FIRST, resume second, so a failure to
 * park cannot destroy an in-progress order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LocalOrder } from "@/lib/types";
import { makeCtx, makeFakeEngine, makeLine, makeOrder } from "./parityTestkit";
import type { PosContextValue } from "@/state/store";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

const api = vi.hoisted(() => ({
  listOrders: vi.fn(async () => ({ success: true, data: [] as unknown[] })),
  transition: vi.fn(async () => ({ version: 3 })),
}));
vi.mock("@/lib/api", () => api);

import { HeldOrdersDialog } from "../dialogs/HeldOrdersDialog";
import { I18nProvider } from "@/i18n/I18nProvider";

const HELD: LocalOrder = makeOrder({
  id: "01HELDORDER000000000000000",
  status: "held",
  lines: [makeLine({ menuId: "M2", name: "طاجين لحم", qty: 1, unitPrice: 86 })],
  updatedAt: 5_000,
});

function renderBoard(ctx: PosContextValue) {
  currentCtx = ctx;
  return render(
    <I18nProvider>
      <HeldOrdersDialog open onClose={onClose} onCountChange={onCountChange} />
    </I18nProvider>,
  );
}

const onClose = vi.fn();
const onCountChange = vi.fn();

beforeEach(() => {
  onClose.mockClear();
  onCountChange.mockClear();
  api.listOrders.mockClear();
  api.transition.mockClear();
});
afterEach(() => cleanup());

describe("cart is empty — unchanged one-tap resume", () => {
  it("says «استعادة» and resumes without holding anything", async () => {
    const engine = makeFakeEngine();
    engine.localHeldOrders.mockResolvedValue([HELD] as never);
    const ctx = makeCtx({ engine, cart: makeOrder({ lines: [] }) });
    renderBoard(ctx);

    const resume = await screen.findByRole("button", { name: "استعادة" });
    fireEvent.click(resume);

    await waitFor(() => expect(ctx.loadOrderDoc).toHaveBeenCalledTimes(1));
    expect(engine.holdOrder).not.toHaveBeenCalled();
    expect(ctx.pushToast).toHaveBeenCalledWith("success", "تمت استعادة الطلب إلى السلة");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("cart has lines — hold-and-resume as ONE action", () => {
  it("labels the action for what it actually does", async () => {
    const engine = makeFakeEngine();
    engine.localHeldOrders.mockResolvedValue([HELD] as never);
    renderBoard(makeCtx({ engine }));

    expect(await screen.findByRole("button", { name: "علّق الحالي واستعد" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "استعادة" })).not.toBeInTheDocument();
    // …and warns up front, so nothing about it is a surprise.
    expect(screen.getByText(/بالسلة طلب قيد التحضير/)).toBeInTheDocument();
  });

  it("holds the CURRENT cart, then resumes the chosen order — in that order", async () => {
    const engine = makeFakeEngine();
    engine.localHeldOrders.mockResolvedValue([HELD] as never);
    const cart = makeOrder({ id: "01CURRENTCART00000000000000", lines: [makeLine({ qty: 3 })] });
    const ctx = makeCtx({ engine, cart });
    renderBoard(ctx);

    fireEvent.click(await screen.findByRole("button", { name: "علّق الحالي واستعد" }));

    await waitFor(() => expect(ctx.loadOrderDoc).toHaveBeenCalledTimes(1));

    // The cart that was on screen was parked — by value, not by reference, so
    // a later mutation of the live cart cannot rewrite what was held.
    expect(engine.holdOrder).toHaveBeenCalledTimes(1);
    const parked = engine.holdOrder.mock.calls[0]![0] as LocalOrder;
    expect(parked.id).toBe("01CURRENTCART00000000000000");
    expect(parked.lines).toHaveLength(1);
    expect(parked.lines).not.toBe(cart.lines);

    // …and the chosen order landed in the cart.
    expect((ctx.loadOrderDoc as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe(HELD.id);
    expect(ctx.pushToast).toHaveBeenCalledWith("success", "عُلّق طلب السلة، ثم استُعيد الطلب المختار");
    expect(onClose).toHaveBeenCalled();
  });

  it("aborts WITHOUT resuming when the hold fails — the in-progress order is never destroyed", async () => {
    const engine = makeFakeEngine();
    engine.localHeldOrders.mockResolvedValue([HELD] as never);
    engine.holdOrder.mockRejectedValue(new Error("IndexedDB unavailable") as never);
    const ctx = makeCtx({ engine });
    renderBoard(ctx);

    fireEvent.click(await screen.findByRole("button", { name: "علّق الحالي واستعد" }));

    await waitFor(() =>
      expect(ctx.pushToast).toHaveBeenCalledWith("error", "تعذّر تعليق الطلب الحالي — لم تُنفَّذ الاستعادة"),
    );
    expect(engine.resumeLocalOrder).not.toHaveBeenCalled();
    expect(ctx.loadOrderDoc).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the header badge honest: one row leaves the board, one joins it", async () => {
    const engine = makeFakeEngine();
    engine.localHeldOrders.mockResolvedValue([HELD] as never);
    renderBoard(makeCtx({ engine }));
    await screen.findByRole("button", { name: "علّق الحالي واستعد" });
    onCountChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "علّق الحالي واستعد" }));
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1)); // 1 out, 1 in
  });

  it("resuming with an EMPTY cart drops the board count by one", async () => {
    const engine = makeFakeEngine();
    engine.localHeldOrders.mockResolvedValue([HELD] as never);
    renderBoard(makeCtx({ engine, cart: makeOrder({ lines: [] }) }));
    await screen.findByRole("button", { name: "استعادة" });
    onCountChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "استعادة" }));
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
  });
});
