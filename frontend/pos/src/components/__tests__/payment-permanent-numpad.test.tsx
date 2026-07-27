/**
 * PaymentDialog — the PERMANENT keypad, the derived tender ladder, split
 * fill-remainder, and the inline "open shift" handoff.
 *
 * The keypad used to render inside the cash tab and inside the split block, so
 * it appeared, vanished and jumped as the cashier moved between methods — a
 * thumb cannot learn a target that moves. There is now exactly one <Numpad>,
 * mounted unconditionally in one slot on every tab; what it DRIVES changes,
 * where it IS does not. These specs pin both halves of that: the slot, and the
 * per-tab wiring (amount / reference / inert).
 *
 * usePos is mocked (parityTestkit); the dialog renders for real. Default cart
 * totals 46.00 (2 × 23, REAL cartMath).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import type { CatalogPaymentMethod } from "@/lib/types";
import { makeCtx, makeCatalog, makeFakeEngine, makeLine, makeOrder } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { PaymentDialog } from "../dialogs/PaymentDialog";
import { I18nProvider } from "@/i18n/I18nProvider";

function openDialog(ctx: PosContextValue, props: { onOpenShift?: () => void } = {}) {
  currentCtx = ctx;
  return render(
    <I18nProvider>
      <PaymentDialog open onClose={() => {}} {...props} />
    </I18nProvider>,
  );
}

/** A cart whose gross total is exactly `total` (tax-inclusive single line). */
function cartOf(total: number) {
  return makeOrder({ lines: [makeLine({ qty: 1, unitPrice: total, taxInclusive: true })] });
}

const TAB = { cash: "كاش", card: "شبكة", split: "مختلط", credit: "آجل" } as const;

beforeEach(() => cleanup());

describe("the keypad is permanent — one pad, one slot, every method", () => {
  it("is mounted on cash, card, split AND credit (it used to exist only on cash/split)", () => {
    openDialog(makeCtx({ supervisor: true }));
    for (const label of [TAB.cash, TAB.card, TAB.split, TAB.credit]) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect(screen.getAllByTestId("numpad")).toHaveLength(1);
    }
  });

  it("occupies the SAME DOM slot on every tab — same parent, same index, same preceding hint", () => {
    openDialog(makeCtx({ supervisor: true }));
    const slots = [TAB.cash, TAB.card, TAB.split, TAB.credit].map((label) => {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      const pad = screen.getByTestId("numpad");
      const parent = pad.parentElement!;
      return {
        parent,
        index: Array.from(parent.children).indexOf(pad),
        prevTestId: pad.previousElementSibling?.getAttribute("data-testid"),
      };
    });
    for (const slot of slots) {
      expect(slot.parent).toBe(slots[0]!.parent); // literally the same element
      expect(slot.index).toBe(slots[0]!.index);
      expect(slot.prevTestId).toBe("numpad-hint");
    }
  });

  it("always carries a one-line hint saying what it types", () => {
    openDialog(makeCtx({ supervisor: true }));
    const hints: Record<string, string> = {};
    for (const [key, label] of Object.entries(TAB)) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      hints[key] = screen.getByTestId("numpad-hint").textContent ?? "";
      expect(hints[key]!.length).toBeGreaterThan(0);
    }
    expect(hints.cash).toContain("المبلغ المستلَم");
    expect(hints.split).toContain("الخانة المحددة");
    expect(hints.card).toContain("رقم العملية");
    expect(hints.credit).toContain("حساب العميل");
  });
});

describe("what the keypad drives, per tab", () => {
  it("cash — taps fill the tendered amount and the change row recomputes", () => {
    openDialog(makeCtx());
    fireEvent.click(screen.getByRole("button", { name: "خمسة" }));
    fireEvent.click(screen.getByRole("button", { name: "صفر" }));
    expect(screen.getByLabelText(/المستلَم من العميل/)).toHaveValue(50);
    expect(screen.getByText("4.00")).toBeInTheDocument();
  });

  it("split — taps land in the ACTIVE (ringed) leg, and the pad does not move when it changes", () => {
    openDialog(makeCtx({ supervisor: true }));
    fireEvent.click(screen.getByRole("tab", { name: TAB.split }));
    const before = screen.getByTestId("numpad").parentElement;
    fireEvent.click(screen.getByRole("button", { name: "اثنان" }));
    fireEvent.click(screen.getByRole("button", { name: "صفر" }));
    expect(screen.getByLabelText("كاش")).toHaveValue(20);
    fireEvent.focus(screen.getByLabelText("شبكة"));
    fireEvent.click(screen.getByRole("button", { name: "اثنان" }));
    fireEvent.click(screen.getByRole("button", { name: "ستة" }));
    expect(screen.getByLabelText("شبكة")).toHaveValue(26);
    expect(screen.getByText("المجموع مطابق")).toBeInTheDocument();
    expect(screen.getByTestId("numpad").parentElement).toBe(before);
  });

  it("card — taps type the approval/reference number, NOT money", () => {
    openDialog(makeCtx());
    fireEvent.click(screen.getByRole("tab", { name: TAB.card }));
    const ref = screen.getByLabelText(/رقم العملية/);
    // A leading zero is significant on a terminal slip: the money grammar
    // would have collapsed "0" + "4" to "4".
    fireEvent.click(screen.getByRole("button", { name: "صفر" }));
    fireEvent.click(screen.getByRole("button", { name: "أربعة" }));
    fireEvent.click(screen.getByRole("button", { name: "اثنان" }));
    expect(ref).toHaveValue("042");
    // …and there is still no cash tender/change UI on this tab.
    expect(screen.queryByLabelText(/المستلَم من العميل/)).not.toBeInTheDocument();
  });

  it("card — the typed reference rides into checkout as paymentNotes", async () => {
    const engine = makeFakeEngine();
    openDialog(makeCtx({ engine }));
    fireEvent.click(screen.getByRole("tab", { name: TAB.card }));
    fireEvent.change(screen.getByLabelText(/رقم العملية/), { target: { value: "778812" } });
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await waitFor(() => expect(engine.checkout).toHaveBeenCalledTimes(1));
    const [, payments, opts] = engine.checkout.mock.calls[0]!;
    expect(payments).toEqual([{ method: "card", amount: 46 }]);
    expect(opts.paymentNotes).toBe("مرجع: 778812");
  });

  it("card — an untouched reference leaves paymentNotes undefined (no phantom note)", async () => {
    const engine = makeFakeEngine();
    openDialog(makeCtx({ engine }));
    fireEvent.click(screen.getByRole("tab", { name: TAB.card }));
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await waitFor(() => expect(engine.checkout).toHaveBeenCalledTimes(1));
    expect(engine.checkout.mock.calls[0]![2].paymentNotes).toBeUndefined();
  });

  it("credit — the pad stays mounted but goes INERT, with the reason spelled out", () => {
    openDialog(makeCtx({ supervisor: true }));
    fireEvent.click(screen.getByRole("tab", { name: TAB.credit }));
    const pad = screen.getByTestId("numpad");
    expect(pad).toBeInTheDocument();
    expect(pad).toHaveAttribute("aria-disabled", "true");
    for (const label of ["خمسة", "صفر", "فاصلة عشرية", "حذف آخر رقم", "مسح المبلغ"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
    expect(screen.getByTestId("numpad-hint")).toHaveTextContent("لا يوجد رقم لإدخاله");
    // Pressing an inert key must not disturb the confirmable state.
    fireEvent.click(screen.getByRole("button", { name: "خمسة" }));
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeEnabled();
  });

  it("owner method — a slip-bearing group gets the reference field; 'other' keeps the note and an inert pad", () => {
    const methods: CatalogPaymentMethod[] = [
      { id: 7, name: "Bank Transfer", nameAr: "تحويل بنكي", groupType: "bank" },
      { id: 9, name: "Other", nameAr: "أخرى", groupType: "other" },
    ];
    openDialog(makeCtx({ catalog: makeCatalog({ paymentMethods: methods }) }));

    fireEvent.click(screen.getByRole("tab", { name: "تحويل بنكي" }));
    expect(screen.getByLabelText(/رقم العملية/)).toBeInTheDocument();
    expect(screen.getByTestId("numpad")).not.toHaveAttribute("aria-disabled");

    fireEvent.click(screen.getByRole("tab", { name: "أخرى" }));
    expect(screen.queryByLabelText(/رقم العملية/)).not.toBeInTheDocument();
    expect(screen.getByTestId("numpad")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("numpad-hint")).toHaveTextContent("ملاحظة مكتوبة");
  });
});

describe("the derived tender ladder on the cash tab", () => {
  it("a 46.00 bill offers exact / 50 / 100 — never the old, unreachable 200", () => {
    openDialog(makeCtx());
    expect(screen.getByRole("button", { name: "المبلغ بالضبط" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "50" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "100" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "200" })).not.toBeInTheDocument();
  });

  it("a 460.00 bill finally offers the 500 note (three taps saved, every time)", () => {
    openDialog(makeCtx({ cart: cartOf(460) }));
    expect(screen.getByRole("button", { name: "500" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "500" }));
    expect(screen.getByLabelText(/المستلَم من العميل/)).toHaveValue(500);
    expect(screen.getByText("40.00")).toBeInTheDocument(); // change due
  });

  it("slot 0 keeps the pinned «المبلغ بالضبط» label and sets the exact amount", () => {
    openDialog(makeCtx({ cart: cartOf(37.25) }));
    const row = screen.getByRole("button", { name: "المبلغ بالضبط" });
    fireEvent.click(row);
    expect(screen.getByLabelText(/المستلَم من العميل/)).toHaveValue(37.25);
    expect(screen.getByText("الباقي للعميل")).toBeInTheDocument();
    // …and the rest of the ladder for 37.25 is 40 / 50 / 100.
    for (const label of ["40", "50", "100"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });
});

describe("split fill-remainder", () => {
  /** 73.50 bill, 50.00 already in cash — the brief's 23.50 mental subtraction. */
  function splitCtx(overrides: Parameters<typeof makeCtx>[0] = {}) {
    return makeCtx({ supervisor: true, cart: cartOf(73.5), ...overrides });
  }

  it("fills the ACTIVE leg with total − the other legs, and the sum row goes green", () => {
    openDialog(splitCtx());
    fireEvent.click(screen.getByRole("tab", { name: TAB.split }));
    fireEvent.change(screen.getByLabelText("كاش"), { target: { value: "50" } });
    fireEvent.focus(screen.getByLabelText("شبكة"));
    const fill = screen.getByRole("button", { name: "املأ المبلغ المتبقي في الخانة المحددة" });
    expect(fill).toHaveTextContent("المتبقي: 23.50");
    fireEvent.click(fill);
    expect(screen.getByLabelText("شبكة")).toHaveValue(23.5);
    expect(screen.getByText("المجموع مطابق")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeEnabled();
  });

  it("ignores the ACTIVE leg's own current value (re-filling is idempotent, not cumulative)", () => {
    openDialog(splitCtx());
    fireEvent.click(screen.getByRole("tab", { name: TAB.split }));
    fireEvent.change(screen.getByLabelText("كاش"), { target: { value: "50" } });
    fireEvent.focus(screen.getByLabelText("شبكة"));
    fireEvent.change(screen.getByLabelText("شبكة"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "املأ المبلغ المتبقي في الخانة المحددة" }));
    expect(screen.getByLabelText("شبكة")).toHaveValue(23.5);
    fireEvent.click(screen.getByRole("button", { name: "املأ المبلغ المتبقي في الخانة المحددة" }));
    expect(screen.getByLabelText("شبكة")).toHaveValue(23.5);
  });

  it("clamps at zero: an over-tendered other leg cannot fill a negative amount", () => {
    openDialog(splitCtx());
    fireEvent.click(screen.getByRole("tab", { name: TAB.split }));
    fireEvent.change(screen.getByLabelText("كاش"), { target: { value: "100" } });
    fireEvent.focus(screen.getByLabelText("شبكة"));
    const fill = screen.getByRole("button", { name: "املأ المبلغ المتبقي في الخانة المحددة" });
    expect(fill).toHaveTextContent("المتبقي: 0.00");
    expect(fill).toBeDisabled();
  });

  it("respects the credit-leg guard — filling into a disabled آجل leg is a NO-OP", () => {
    openDialog(splitCtx({ supervisor: false }));
    fireEvent.click(screen.getByRole("tab", { name: TAB.split }));
    const credit = screen.getByLabelText("آجل") as HTMLInputElement;
    expect(credit).toBeDisabled();
    fireEvent.focus(credit);
    const fill = screen.getByRole("button", { name: "املأ المبلغ المتبقي في الخانة المحددة" });
    expect(fill).toBeDisabled();
    fireEvent.click(fill);
    expect(credit.value).toBe("");
    expect(screen.getByText("0.00 / 73.50")).toBeInTheDocument();
    // The pad is inert for the same reason, and says so.
    expect(screen.getByTestId("numpad")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("numpad-hint")).toHaveTextContent("مشرفًا/مديرًا");
  });

  it("keeps «المجموع مطابق» when balanced (the pinned string is untouched)", () => {
    openDialog(splitCtx());
    fireEvent.click(screen.getByRole("tab", { name: TAB.split }));
    fireEvent.click(screen.getByRole("button", { name: "املأ المبلغ المتبقي في الخانة المحددة" }));
    expect(screen.getByLabelText("كاش")).toHaveValue(73.5);
    expect(screen.getByText("المجموع مطابق")).toBeInTheDocument();
  });
});

describe("inline open-shift handoff", () => {
  const noShift = { cart: makeOrder({ shiftId: null }), shiftId: null } as const;

  it("offers a button that hands off to the FULL ShiftDialog", () => {
    const onOpenShift = vi.fn();
    openDialog(makeCtx(noShift), { onOpenShift });
    expect(screen.getByText(/لا يمكن الدفع بلا وردية مفتوحة/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /افتح وردية الآن/ }));
    expect(onOpenShift).toHaveBeenCalledTimes(1);
    // The dialog must NOT open a shift itself — no zero-float shortcut exists.
    expect(currentCtx.openShiftNow).not.toHaveBeenCalled();
  });

  it("without the prop the banner is unchanged (no orphan button)", () => {
    openDialog(makeCtx(noShift));
    expect(screen.getByText(/لا يمكن الدفع بلا وردية مفتوحة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /افتح وردية/ })).not.toBeInTheDocument();
  });

  it("does not appear once a shift is open", () => {
    openDialog(makeCtx(), { onOpenShift: vi.fn() });
    expect(screen.queryByRole("button", { name: /افتح وردية/ })).not.toBeInTheDocument();
  });
});
