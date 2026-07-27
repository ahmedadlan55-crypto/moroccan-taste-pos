/**
 * Regression — two CartPanel defects that each made the register lie about money.
 *
 * DEFECT 1 — the server's VAT rate never reached the per-line display.
 *   store.tsx threaded `catalog.vatRate` into the FOOTER totals, but
 *   CartPanel called `lineTotals(line)` with no rate, so every per-line amount
 *   silently used cartMath's 15% default. On any tenant whose settings.VATRate
 *   is not 15, each line contradicted the total printed directly beneath it —
 *   and the amount routes/sales.js actually charges.
 *
 * DEFECT 2 — the manual line-discount ceiling was 1/factor of the real one.
 *   The label, the `max` attribute and the clamp all used `qty × unitPrice`
 *   while the engine clamps against `baseQty × unitPrice` (cartMath.lineTotals
 *   uses `baseQty ?? qty`). On a carton line (qty 1 × factor 12 @ 5.00) the
 *   cashier was told the cap was 5.00 and anything larger was truncated on
 *   entry — a discount the engine would have accepted was unreachable.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeOrder, makeLine, makeCatalog } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { CartPanel, type CartPanelProps } from "../CartPanel";
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

beforeEach(() => cleanup());

describe("defect 1 — the per-line amount uses the SERVER's VAT rate", () => {
  // 2 × 100.00 tax-EXCLUSIVE (what every production menu row is):
  //   at the server's 5%  → net 200 + 10.00 = 210.00
  //   at cartMath's 15%   → net 200 + 30.00 = 230.00  ← the old, wrong figure
  const line = makeLine({ qty: 2, unitPrice: 100, taxInclusive: false });

  it("a 5% tenant sees 210.00 on the line, not the hardcoded-15% 230.00", () => {
    const ctx = makeCtx({
      cart: makeOrder({ lines: [line] }),
      catalog: makeCatalog({ vatRate: 5 }),
    });
    renderPanel(ctx);

    expect(screen.getAllByText("210.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("230.00")).not.toBeInTheDocument();
  });

  it("the line amount and the footer total agree — the symptom the owner reports", () => {
    const ctx = makeCtx({
      cart: makeOrder({ lines: [line] }),
      catalog: makeCatalog({ vatRate: 5 }),
    });
    renderPanel(ctx);

    // Footer total (threaded correctly all along) and the line amount (was not).
    // Before the fix these read 210.00 and 230.00 on the same screen.
    expect(screen.getByText("الإجمالي").nextElementSibling).toHaveTextContent("210.00");
    expect(screen.getByText("الضريبة (مشمولة)").nextElementSibling).toHaveTextContent("10.00");
  });

  it("still correct at 15% — the fix threads the real rate, it does not swap the constant", () => {
    const ctx = makeCtx({
      cart: makeOrder({ lines: [line] }),
      catalog: makeCatalog({ vatRate: 15 }),
    });
    renderPanel(ctx);
    expect(screen.getAllByText("230.00").length).toBeGreaterThan(0);
  });
});

describe("defect 2 — the line-discount ceiling is the REAL gross (baseQty × price)", () => {
  // A carton: 1 carton × factor 12 @ 5.00/base unit = 60.00 of actual goods.
  const carton = makeLine({
    qty: 1,
    unitPrice: 5,
    baseQty: 12,
    conversionFactorSnapshot: 12,
    enteredUnitName: "كرتون",
    enteredUnitCode: "CTN",
    taxInclusive: false,
  });

  function expandCartonRow() {
    const ctx = makeCtx({ cart: makeOrder({ lines: [carton] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    return ctx;
  }

  it("the label advertises 60.00, not the entered-qty 5.00", () => {
    expandCartonRow();
    const label = screen.getByText(/خصم السطر \(ر\.س\) — الحد/);
    expect(label).toHaveTextContent("60.00");
    expect(label).not.toHaveTextContent("5.00");
  });

  it("the input's max attribute is 60, not 5", () => {
    expandCartonRow();
    const input = screen.getByPlaceholderText("0.00");
    expect(input).toHaveAttribute("max", "60");
  });

  it("typing 50 is passed through UNTRUNCATED (it used to arrive as 5)", () => {
    const ctx = expandCartonRow();
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "50" } });
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 50);
  });

  it("the clamp still bites above the REAL gross (999 → 60)", () => {
    const ctx = expandCartonRow();
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "999" } });
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 60);
  });

  it("a plain single-unit line is unaffected (baseQty absent → qty)", () => {
    // Pins that the fix is `baseQty ?? qty`, not a blanket factor multiply.
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2, unitPrice: 23 })] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "999" } });
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 46);
  });
});
