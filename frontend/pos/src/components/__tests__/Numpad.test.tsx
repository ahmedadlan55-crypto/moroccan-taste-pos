/**
 * Numpad — the on-screen touch keypad in the payment screen.
 *
 * Layer 1: the MONEY GRAMMAR (applyNumpadKey) — leading-zero normalization,
 * a single decimal point, ≤2 decimal places, backspace/clear, length cap.
 * Layer 2: the component emits edits through onChange.
 * Layer 3: inside PaymentDialog the keypad edits the SAME state as the real
 * inputs — cash tender recomputes the change row; the split keypad follows
 * the focused (ringed) leg. usePos is mocked (parityTestkit); default cart
 * totals 46.00 (2 × 23, REAL cartMath).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { makeCtx } from "./parityTestkit";
import { Numpad, applyNumpadKey } from "../Numpad";
// PaymentDialog resolves strings via useT(), which throws without an
// ancestor I18nProvider (see i18n/I18nProvider.tsx).
import { I18nProvider } from "@/i18n/I18nProvider";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { PaymentDialog } from "../dialogs/PaymentDialog";

beforeEach(() => cleanup());

describe("applyNumpadKey — money grammar", () => {
  it("appends digits and normalizes the leading zero", () => {
    expect(applyNumpadKey("", "5")).toBe("5");
    expect(applyNumpadKey("5", "0")).toBe("50");
    expect(applyNumpadKey("0", "5")).toBe("5"); // never "05"
    expect(applyNumpadKey("0", "0")).toBe("0"); // stays a single zero
  });

  it("allows exactly one decimal point and seeds '0.' from empty", () => {
    expect(applyNumpadKey("", ".")).toBe("0.");
    expect(applyNumpadKey("12", ".")).toBe("12.");
    expect(applyNumpadKey("12.", ".")).toBe("12.");
    expect(applyNumpadKey("12.5", ".")).toBe("12.5");
  });

  it("caps at two decimal places (halalas)", () => {
    expect(applyNumpadKey("12.34", "5")).toBe("12.34");
    expect(applyNumpadKey("12.3", "4")).toBe("12.34");
  });

  it("backspace deletes the last char; clear empties", () => {
    expect(applyNumpadKey("12.3", "backspace")).toBe("12.");
    expect(applyNumpadKey("1", "backspace")).toBe("");
    expect(applyNumpadKey("", "backspace")).toBe("");
    expect(applyNumpadKey("987.65", "clear")).toBe("");
  });

  it("hard length cap holds", () => {
    expect(applyNumpadKey("123456789", "1")).toBe("123456789");
  });
});

describe("Numpad component", () => {
  it("renders the 12-key grid + مسح and emits applied edits", () => {
    const onChange = vi.fn();
    render(<Numpad value="4" onChange={onChange} />);
    for (const label of ["واحد", "خمسة", "تسعة", "صفر", "فاصلة عشرية", "حذف آخر رقم", "مسح المبلغ"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "ستة" }));
    expect(onChange).toHaveBeenLastCalledWith("46");
    fireEvent.click(screen.getByRole("button", { name: "حذف آخر رقم" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: "مسح المبلغ" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});

describe("PaymentDialog — keypad wired to the real amount states", () => {
  function openDialog() {
    currentCtx = makeCtx();
    return render(
      <I18nProvider>
        <PaymentDialog open onClose={() => {}} />
      </I18nProvider>,
    );
  }

  it("cash: taps fill «المستلَم» and the change row recomputes (50 − 46 = 4.00)", () => {
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "خمسة" }));
    fireEvent.click(screen.getByRole("button", { name: "صفر" }));
    expect(screen.getByLabelText(/المستلَم من العميل/)).toHaveValue(50);
    expect(screen.getByText("الباقي للعميل")).toBeInTheDocument();
    expect(screen.getByText("4.00")).toBeInTheDocument();
  });

  it("cash: an under-tender flips the row to «المبلغ غير كافٍ»", () => {
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "أربعة" }));
    fireEvent.click(screen.getByRole("button", { name: "خمسة" }));
    expect(screen.getByText("المبلغ غير كافٍ")).toBeInTheDocument();
  });

  it("split: the keypad edits the FOCUSED leg (default cash, then شبكة)", () => {
    openDialog();
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    // default active = the cash leg
    fireEvent.click(screen.getByRole("button", { name: "اثنان" }));
    fireEvent.click(screen.getByRole("button", { name: "صفر" }));
    expect(screen.getByLabelText("كاش")).toHaveValue(20);
    // focusing شبكة redirects the taps
    fireEvent.focus(screen.getByLabelText("شبكة"));
    fireEvent.click(screen.getByRole("button", { name: "اثنان" }));
    fireEvent.click(screen.getByRole("button", { name: "ستة" }));
    expect(screen.getByLabelText("شبكة")).toHaveValue(26);
    // 20 + 26 = 46 → the sum row goes green (المجموع مطابق)
    expect(screen.getByText("المجموع مطابق")).toBeInTheDocument();
  });

  it("no keypad on fixed-amount tabs (شبكة tab has nothing to type)", () => {
    openDialog();
    fireEvent.click(screen.getByRole("tab", { name: "شبكة" }));
    expect(screen.queryByTestId("numpad")).not.toBeInTheDocument();
  });
});
