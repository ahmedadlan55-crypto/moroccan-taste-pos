/**
 * Parity — البيع (sell): payment dialog behaviors, pinned against the legacy
 * matrix rows (docs/pos-parity-matrix.md):
 *   pay-modal-summary / payment-modal-summary, pay-methods-fallback,
 *   tender-add, tender-set-given-clamp, tender-derive / payment-tender-derive,
 *   tender-cash-detection, pay-amount-due / payment-tender-amount-due,
 *   pay-change-total / payment-tender-change, pay-keypad-exact,
 *   pay-keypad-quick / payment-tender-quick-keys, pay-confirm-btn,
 *   pay-confirm-gating / payment-confirm-gate, pay-unsettled-guard,
 *   pay-double-charge-guard / checkout-double-charge-guard, pay-checkout-guards.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeFakeEngine, makeOrder, makeLine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { PaymentDialog } from "../dialogs/PaymentDialog";

function openDialog(ctx: PosContextValue) {
  currentCtx = ctx;
  return render(<PaymentDialog open onClose={() => {}} />);
}

beforeEach(() => {
  cleanup();
});

describe("pay-modal-summary — the amount due is shown inside the dialog", () => {
  it("renders الإجمالي المستحق with the cart total (2×23 = 46.00)", () => {
    openDialog(makeCtx());
    expect(screen.getByText("الإجمالي المستحق")).toBeInTheDocument();
    expect(screen.getAllByText("46.00").length).toBeGreaterThan(0);
  });
});

describe("pay-methods-fallback — a usable method set with zero configuration", () => {
  it("always renders كاش / شبكة / مختلط / آجل tabs", () => {
    openDialog(makeCtx());
    for (const label of ["كاش", "شبكة", "مختلط", "آجل"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  it("offline forces cash: card/split/credit tabs are disabled", () => {
    openDialog(makeCtx({ online: false, supervisor: true }));
    expect(screen.getByRole("tab", { name: "كاش" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: "شبكة" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "مختلط" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "آجل" })).toBeDisabled();
  });

  it("credit requires a supervisor (cashier sees it disabled)", () => {
    openDialog(makeCtx({ supervisor: false }));
    expect(screen.getByRole("tab", { name: "آجل" })).toBeDisabled();
  });
});

describe("pay-keypad-exact + pay-keypad-quick — quick tender amounts", () => {
  it("«المبلغ بالضبط» sets tendered = total (change 0.00)", () => {
    openDialog(makeCtx());
    fireEvent.click(screen.getByRole("button", { name: "المبلغ بالضبط" }));
    expect(screen.getByText("الباقي للعميل")).toBeInTheDocument();
    expect(screen.getByText("0.00")).toBeInTheDocument();
  });

  it("quick 50/100/200 buttons exist and 100 yields change 54.00 on a 46.00 bill", () => {
    openDialog(makeCtx());
    for (const label of ["50", "100", "200"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "100" }));
    expect(screen.getByText("54.00")).toBeInTheDocument();
  });
});

describe("tender-cash-detection + pay-change-total — change math is CASH-only", () => {
  it("cash tab computes الباقي للعميل from the tendered amount", () => {
    openDialog(makeCtx());
    const input = screen.getByLabelText(/المستلَم من العميل/);
    fireEvent.change(input, { target: { value: "60" } });
    expect(screen.getByText("الباقي للعميل")).toBeInTheDocument();
    expect(screen.getByText("14.00")).toBeInTheDocument();
  });

  it("card tab has no tendered/change input at all", () => {
    openDialog(makeCtx());
    fireEvent.click(screen.getByRole("tab", { name: "شبكة" }));
    expect(screen.queryByLabelText(/المستلَم من العميل/)).not.toBeInTheDocument();
    expect(screen.queryByText("الباقي للعميل")).not.toBeInTheDocument();
  });
});

describe("pay-unsettled-guard + pay-confirm-gating — cannot confirm an unsettled amount", () => {
  it("cash short → المبلغ غير كافٍ + confirm disabled, and the shortfall is shown", () => {
    openDialog(makeCtx());
    fireEvent.change(screen.getByLabelText(/المستلَم من العميل/), { target: { value: "40" } });
    expect(screen.getByText("المبلغ غير كافٍ")).toBeInTheDocument();
    expect(screen.getByText("6.00")).toBeInTheDocument(); // 46 − 40
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });
});

describe("tender-add + tender-derive + pay-amount-due — split payments", () => {
  it("split legs that do not sum to the total show the live sum/total and disable confirm", () => {
    openDialog(makeCtx({ supervisor: true }));
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [cashInput, cardInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(cashInput, { target: { value: "20" } });
    fireEvent.change(cardInput, { target: { value: "10" } });
    expect(screen.getByRole("alert")).toHaveTextContent("مجموع الدفعات (30) لا يساوي إجمالي الطلب (46)");
    expect(screen.getByText("30.00 / 46.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });

  it("a matching split (20 cash + 26 card) settles and confirm sends BOTH payment legs", async () => {
    const engine = makeFakeEngine();
    const ctx = makeCtx({ supervisor: true, engine });
    openDialog(ctx);
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [cashInput, cardInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(cashInput, { target: { value: "20" } });
    fireEvent.change(cardInput, { target: { value: "26" } });
    expect(screen.getByText("المجموع مطابق")).toBeInTheDocument();
    const confirmBtn = screen.getByRole("button", { name: /تأكيد الدفع/ });
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(engine.checkout).toHaveBeenCalledTimes(1));
    const [, payments] = engine.checkout.mock.calls[0]!;
    expect(payments).toEqual([
      { method: "cash", amount: 20 },
      { method: "card", amount: 26 },
    ]);
  });
});

describe("tender-set-given-clamp — non-cash can never overpay", () => {
  it("split legs exceeding the total are rejected (46 + 10 card on a 46 bill)", () => {
    openDialog(makeCtx({ supervisor: true }));
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [cashInput, cardInput] = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(cashInput, { target: { value: "46" } });
    fireEvent.change(cardInput, { target: { value: "10" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });
});

describe("pay-confirm-btn + pay-emit — confirm drives the checkout chain with cash figures", () => {
  it("cash confirm passes payments + cashTendered + changeDue to engine.checkout", async () => {
    const engine = makeFakeEngine();
    openDialog(makeCtx({ engine }));
    fireEvent.change(screen.getByLabelText(/المستلَم من العميل/), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await waitFor(() => expect(engine.checkout).toHaveBeenCalledTimes(1));
    const [doc, payments, opts] = engine.checkout.mock.calls[0]!;
    expect(doc.id).toBe(makeOrder().id);
    expect(payments).toEqual([{ method: "cash", amount: 46 }]);
    expect(opts).toMatchObject({ cashTendered: 100, changeDue: 54 });
  });
});

describe("pay-double-charge-guard — the confirm affordance disappears while in flight", () => {
  it("during the working phase there is no confirm button to press twice", async () => {
    const engine = makeFakeEngine();
    // A checkout that never resolves keeps the dialog in the working phase.
    engine.checkout.mockImplementation(() => new Promise(() => {}));
    openDialog(makeCtx({ engine }));
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /تأكيد الدفع/ })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("تثبيت الطلب…");
    expect(engine.checkout).toHaveBeenCalledTimes(1);
  });
});

describe("pay-checkout-guards — no open shift blocks payment", () => {
  it("shows the no-shift alert and disables confirm when shiftId is null everywhere", () => {
    const cart = makeOrder({ shiftId: null });
    openDialog(makeCtx({ cart, shiftId: null }));
    expect(screen.getByText(/لا يمكن الدفع بلا وردية مفتوحة/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });

  it("falls back to the shift stored ON the cart doc when the live query is offline/null", () => {
    const cart = makeOrder({ shiftId: "SH-CACHED" });
    openDialog(makeCtx({ cart, shiftId: null }));
    expect(screen.queryByText(/لا يمكن الدفع بلا وردية مفتوحة/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeEnabled();
  });
});

describe("O2C credit gate — credit needs a linked customer", () => {
  it("credit tab without customerId blocks confirm with the explicit message", () => {
    const cart = makeOrder({ customerId: null, lines: [makeLine()] });
    openDialog(makeCtx({ cart, supervisor: true, o2cEnabled: true }));
    fireEvent.click(screen.getByRole("tab", { name: "آجل" }));
    expect(screen.getByText(/البيع الآجل يتطلب اختيار عميل/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });
});
