/**
 * DiscountDialog — two money defects.
 *
 * DEFECT A — the preview was computed at a hardcoded VAT rate.
 *   The dialog called cartTotals(lines, discount) with NO rate, so the whole
 *   "total after discount" block used cartMath's 15% fallback while the cart
 *   footer used the server's settings.VATRate (threaded through the store as
 *   `vatRatePct`). On any tenant not on 15% the discount preview contradicted
 *   the total printed right behind it — and the amount routes/sales.js charges.
 *
 * DEFECT B — it was the last money-entry screen with no on-screen keypad, so
 *   the OS keyboard slid up over the very preview the cashier was reading.
 *
 * usePos is mocked (parityTestkit); the preset fetch is stubbed to an empty
 * list so these specs exercise manual entry only.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { _resetDiscountPresetsCache } from "@/lib/discountPresets";
import { makeCtx, makeCatalog, makeLine, makeOrder } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { DiscountDialog } from "../dialogs/DiscountDialog";
import { I18nProvider } from "@/i18n/I18nProvider";

function renderDialog(ctx: PosContextValue) {
  currentCtx = ctx;
  return render(
    <I18nProvider>
      <DiscountDialog open onClose={() => {}} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  cleanup();
  _resetDiscountPresetsCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch,
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("defect A — the preview uses the SERVER's VAT rate", () => {
  // 2 × 100.00 tax-EXCLUSIVE (what every production menu row is):
  //   at the server's 5%  → subtotal 210.00, less 10% → 189.00
  //   at cartMath's 15%   → subtotal 230.00, less 10% → 207.00  ← the old lie
  const lines = [makeLine({ qty: 2, unitPrice: 100, taxInclusive: false })];

  it("a 5% tenant previews 189.00, not the hardcoded-15% 207.00", () => {
    renderDialog(makeCtx({ cart: makeOrder({ lines }), catalog: makeCatalog({ vatRate: 5 }) }));
    fireEvent.change(screen.getByLabelText("النسبة (0–100)"), { target: { value: "10" } });
    expect(screen.getByText("189.00")).toBeInTheDocument();
    expect(screen.queryByText("207.00")).not.toBeInTheDocument();
  });

  it("the discount AMOUNT scales with the same rate (21.00 at 5%, not 23.00)", () => {
    renderDialog(makeCtx({ cart: makeOrder({ lines }), catalog: makeCatalog({ vatRate: 5 }) }));
    fireEvent.change(screen.getByLabelText("النسبة (0–100)"), { target: { value: "10" } });
    expect(screen.getByText("-21.00")).toBeInTheDocument();
  });

  it("the FIXED-amount label caps at the rate-correct subtotal (210.00 at 5%)", () => {
    renderDialog(makeCtx({ cart: makeOrder({ lines }), catalog: makeCatalog({ vatRate: 5 }) }));
    fireEvent.click(screen.getByRole("radio", { name: "مبلغ ر.س" }));
    expect(screen.getByText(/يُسقَف عند 210\.00/)).toBeInTheDocument();
  });

  it("still correct at 15% — the fix threads the real rate, it does not swap the constant", () => {
    renderDialog(makeCtx({ cart: makeOrder({ lines }), catalog: makeCatalog({ vatRate: 15 }) }));
    fireEvent.change(screen.getByLabelText("النسبة (0–100)"), { target: { value: "10" } });
    expect(screen.getByText("207.00")).toBeInTheDocument();
  });
});

describe("defect B — the on-screen keypad", () => {
  it("renders a keypad in the discount dialog", () => {
    renderDialog(makeCtx());
    expect(screen.getByTestId("numpad")).toBeInTheDocument();
  });

  it("taps fill the discount value and the live preview follows (10% of 46.00)", () => {
    renderDialog(makeCtx());
    fireEvent.click(screen.getByRole("button", { name: "واحد" }));
    fireEvent.click(screen.getByRole("button", { name: "صفر" }));
    expect(screen.getByLabelText("النسبة (0–100)")).toHaveValue(10);
    expect(screen.getByText("-4.60")).toBeInTheDocument();
    expect(screen.getByText("41.40")).toBeInTheDocument();
  });

  it("the money grammar applies — a 12.345 tap sequence stops at two decimals", () => {
    renderDialog(makeCtx());
    fireEvent.click(screen.getByRole("radio", { name: "مبلغ ر.س" }));
    for (const key of ["واحد", "اثنان", "فاصلة عشرية", "ثلاثة", "أربعة", "خمسة"]) {
      fireEvent.click(screen.getByRole("button", { name: key }));
    }
    expect(screen.getByLabelText(/المبلغ \(يُسقَف عند/)).toHaveValue(12.34);
  });

  it("clearing via the keypad disables Apply again (no half-typed discount slips through)", () => {
    renderDialog(makeCtx());
    fireEvent.click(screen.getByRole("button", { name: "خمسة" }));
    expect(screen.getByRole("button", { name: "تطبيق الخصم" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "مسح المبلغ" }));
    expect(screen.getByRole("button", { name: "تطبيق الخصم" })).toBeDisabled();
  });

  it("a keypad-entered discount reaches setDiscount unchanged", () => {
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(screen.getByRole("button", { name: "سبعة" }));
    fireEvent.click(screen.getByRole("button", { name: "خمسة" }));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("PERCENT", 75, null);
  });
});
