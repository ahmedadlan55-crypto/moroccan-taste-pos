/**
 * QtyPad — "12 bottles of water" must cost ONE entry, not eleven taps on «+».
 *
 * Driven through the real CartPanel row, because the contract that matters is
 * the wiring: the pad commits through the SAME setQty(index, qty) the stepper
 * uses, so 0 removes the line and the store's undo affordance comes with it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeOrder, makeLine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { CartPanel, type CartPanelProps } from "../CartPanel";
import { parseQtyInput, QTY_MAX } from "../QtyPad";
import { I18nProvider } from "@/i18n/I18nProvider";

function renderPanel(ctx: PosContextValue) {
  currentCtx = ctx;
  const p: CartPanelProps = {
    heldCount: 0,
    onPay: vi.fn(),
    onHold: vi.fn(),
    onOpenHeld: vi.fn(),
    onVoid: vi.fn(),
    onOpenDiscount: vi.fn(),
    holdBusy: false,
    voidDisabledReason: null,
  };
  render(
    <I18nProvider>
      <CartPanel {...p} />
    </I18nProvider>,
  );
  return p;
}

const trigger = () => screen.getByTestId("qty-trigger");
const pad = () => screen.getByRole("dialog");
const digit = (d: string) => within(pad()).getByRole("button", { name: DIGIT_NAMES[d]! });

/** The Numpad labels its keys with Arabic number words (i18n numpad.digits). */
const DIGIT_NAMES: Record<string, string> = {
  "0": "صفر",
  "1": "واحد",
  "2": "اثنان",
  "5": "خمسة",
};

beforeEach(() => cleanup());

describe("parseQtyInput — the commit guard", () => {
  it("rejects an EMPTY draft instead of committing Number('') === 0", () => {
    // This is the whole reason the helper exists: `Number("")` is 0, and 0
    // deletes the line. A cashier who opens the pad and changes their mind
    // must not be able to delete a line by tapping «تعيين».
    expect(parseQtyInput("")).toBeNull();
    expect(parseQtyInput("   ")).toBeNull();
  });

  it("accepts an explicit zero (that is the documented remove gesture)", () => {
    expect(parseQtyInput("0")).toBe(0);
    expect(parseQtyInput("0.")).toBe(0);
  });

  it("REJECTS a decimal rather than rounding it, and rejects nonsense/negatives", () => {
    // Was "accepts decimals (weighed goods)". A fractional quantity could not
    // be shown honestly anywhere downstream — the card badge rounded 0.5 to "1"
    // and 0.4 to "0". Rejecting keeps «تعيين» disabled so the cashier fixes the
    // entry, rather than silently booking a quantity they never typed.
    expect(parseQtyInput("1.5")).toBeNull();
    expect(parseQtyInput("0.5")).toBeNull();
    expect(parseQtyInput("abc")).toBeNull();
    expect(parseQtyInput("-2")).toBeNull();
    expect(parseQtyInput("3")).toBe(3);
  });

  it("clamps an extra-digit typo instead of booking it against the shift", () => {
    expect(parseQtyInput("999999")).toBe(QTY_MAX);
  });
});

describe("typing a quantity", () => {
  it("the qty is a BUTTON that opens an anchored pad (it used to be a plain span)", () => {
    renderPanel(makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2 })] }) }));
    const t = trigger();
    expect(t.tagName).toBe("BUTTON");
    expect(t).toHaveTextContent("2");
    expect(t).toHaveAttribute("aria-haspopup", "dialog");
    expect(t).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(t);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(t).toHaveAttribute("aria-expanded", "true");
    // The EXISTING Numpad, imported — not a fork.
    expect(within(pad()).getByTestId("numpad")).toBeInTheDocument();
  });

  it("«12» + تعيين is ONE setQty(index, 12) — not eleven increments", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 1 })] }) });
    renderPanel(ctx);
    fireEvent.click(trigger());
    fireEvent.click(digit("1"));
    fireEvent.click(digit("2"));
    expect(screen.getByTestId("qtypad-value")).toHaveTextContent("12");
    fireEvent.click(within(pad()).getByRole("button", { name: "تعيين" }));
    expect(ctx.setQty).toHaveBeenCalledTimes(1);
    expect(ctx.setQty).toHaveBeenCalledWith(0, 12);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the CURRENT qty until something is typed, so the pad is never blank", () => {
    renderPanel(makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 7 })] }) }));
    fireEvent.click(trigger());
    expect(screen.getByTestId("qtypad-value")).toHaveTextContent("7");
    fireEvent.click(digit("5"));
    expect(screen.getByTestId("qtypad-value")).toHaveTextContent("5");
  });

  it("«تعيين» is disabled until a digit is entered", () => {
    renderPanel(makeCtx());
    fireEvent.click(trigger());
    const set = within(pad()).getByRole("button", { name: "تعيين" });
    expect(set).toBeDisabled();
    fireEvent.click(digit("1"));
    expect(set).toBeEnabled();
  });

  it("Enter inside the pad commits, like every other numeric field here", () => {
    const ctx = makeCtx();
    renderPanel(ctx);
    fireEvent.click(trigger());
    fireEvent.click(digit("5"));
    fireEvent.keyDown(pad(), { key: "Enter" });
    expect(ctx.setQty).toHaveBeenCalledWith(0, 5);
  });
});

describe("setting 0 removes the line", () => {
  it("commits setQty(index, 0) — the store's documented removal path", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 3 })] }) });
    renderPanel(ctx);
    fireEvent.click(trigger());
    fireEvent.click(digit("0"));
    fireEvent.click(within(pad()).getByRole("button", { name: "تعيين" }));
    expect(ctx.setQty).toHaveBeenCalledWith(0, 0);
  });
});

describe("keyboard + dismissal", () => {
  it("Escape cancels, commits NOTHING, and restores focus to the trigger", () => {
    const ctx = makeCtx();
    renderPanel(ctx);
    const t = trigger();
    fireEvent.click(t);
    fireEvent.click(digit("5"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(ctx.setQty).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(t);
  });

  it("«إلغاء الكمية» closes without committing, and the draft does not survive", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2 })] }) });
    renderPanel(ctx);
    fireEvent.click(trigger());
    fireEvent.click(digit("5"));
    fireEvent.click(within(pad()).getByRole("button", { name: "إلغاء الكمية" }));
    expect(ctx.setQty).not.toHaveBeenCalled();
    // Re-opening starts clean — a stale "5" would be committed by accident.
    fireEvent.click(trigger());
    expect(screen.getByTestId("qtypad-value")).toHaveTextContent("2");
  });

  it("a click outside closes it (a cashier moving on must not leave it hanging)", () => {
    renderPanel(makeCtx());
    fireEvent.click(trigger());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the cancel affordance does not shadow the cart's «إلغاء» (void) button", () => {
    // A pad labelled plain «إلغاء» would make getByRole('button', {name:'إلغاء'})
    // ambiguous while it is open — and that button VOIDS THE ORDER.
    renderPanel(makeCtx());
    fireEvent.click(trigger());
    expect(screen.getAllByRole("button", { name: "إلغاء" })).toHaveLength(1);
  });
});

describe("it stays on screen", () => {
  it("is fixed-positioned and clamped inside the viewport at 390px", () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    renderPanel(makeCtx());
    fireEvent.click(trigger());
    const el = pad() as HTMLElement;
    // position:fixed is what escapes the cart's overflow-y-auto clip; the two
    // offsets are clamped to >= the 8px edge margin and the box is narrower
    // than the viewport, so it can never hang off the side of a 390px screen.
    expect(el.style.position).toBe("fixed");
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    const width = parseFloat(el.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(width).toBeLessThan(390 - 16);
    expect(left + width).toBeLessThanOrEqual(390 - 8);
  });
});

describe("the stepper still works exactly as before", () => {
  it("+ and − keep calling setQty(index, ±1) — the pad is additive, not a replacement", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2 })] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "زيادة شاي مغربي" }));
    expect(ctx.setQty).toHaveBeenCalledWith(0, 3);
    fireEvent.click(screen.getByRole("button", { name: "إنقاص شاي مغربي" }));
    expect(ctx.setQty).toHaveBeenCalledWith(0, 1);
  });
});
