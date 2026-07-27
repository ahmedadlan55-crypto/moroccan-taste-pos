/**
 * Parity — السلة (cart) + خصومات: CartPanel / DiscountDialog / VoidDialog /
 * Toasts behaviors, pinned against the legacy matrix rows:
 *   cart-qty-stepper, cart-remove-line, cart-empty-state, cart-line-discount-chip,
 *   cart-render, cart-math-* (display), cart-discount-header-btn, cart-clear,
 *   discount-line-open, discount-line-picker, discount-line-apply-manual,
 *   discount-invoice-open, discount-invoice-apply-manual, discount-invoice-clear,
 *   invoice-discount-modal, pay-open-from-total / payment-modal-open,
 *   pay-legacy-checkout-btn, toast-and-confirm-primitives.
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
import { DiscountDialog } from "../dialogs/DiscountDialog";
import { VoidDialog } from "../dialogs/VoidDialog";
import { Toasts } from "../Toasts";
// CartPanel resolves strings via useT(), which throws without an ancestor
// I18nProvider (see i18n/I18nProvider.tsx). DiscountDialog/VoidDialog/Toasts
// do not use i18n, so their render() calls below are left unwrapped.
import { I18nProvider } from "@/i18n/I18nProvider";

function renderPanel(ctx: PosContextValue, props: Partial<CartPanelProps> = {}) {
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
    ...props,
  };
  render(
    <I18nProvider>
      <CartPanel {...p} />
    </I18nProvider>,
  );
  return p;
}

beforeEach(() => cleanup());

describe("cart-qty-stepper — +/− act on the line INDEX", () => {
  it("+ calls setQty(index, qty+1) and − calls setQty(index, qty−1)", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2 })] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "زيادة شاي مغربي" }));
    expect(ctx.setQty).toHaveBeenCalledWith(0, 3);
    fireEvent.click(screen.getByRole("button", { name: "إنقاص شاي مغربي" }));
    expect(ctx.setQty).toHaveBeenCalledWith(0, 1);
  });
});

describe("cart-remove-line — trash button removes by index", () => {
  it("calls removeLine(index)", () => {
    const ctx = makeCtx();
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "حذف شاي مغربي" }));
    expect(ctx.removeLine).toHaveBeenCalledWith(0);
  });
});

describe("cart-empty-state — an empty cart says so and disables actions", () => {
  it("renders سلة فارغة and disables pay/hold/void", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [] }) });
    const p = renderPanel(ctx);
    expect(screen.getByText("سلة فارغة")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /دفع/ }));
    expect(p.onPay).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "تعليق" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "إلغاء" })).toBeDisabled();
  });
});

describe("pay-open-from-total / payment-modal-open — the pay affordance", () => {
  it("the دفع button carries the live total and opens payment", () => {
    const ctx = makeCtx(); // 2×23 → 46.00
    const p = renderPanel(ctx);
    const payBtn = screen.getByRole("button", { name: /دفع/ });
    expect(payBtn).toHaveTextContent("46.00");
    fireEvent.click(payBtn);
    expect(p.onPay).toHaveBeenCalledTimes(1);
  });
});

describe("cart-render + cart-math display — totals block", () => {
  it("shows المجموع / الضريبة / الإجمالي from the REAL cartTotals", () => {
    const ctx = makeCtx(); // subtotal 46, vat 6, total 46
    renderPanel(ctx);
    expect(screen.getByText("المجموع").nextElementSibling).toHaveTextContent("46.00");
    expect(screen.getByText("الضريبة (مشمولة)").nextElementSibling).toHaveTextContent("6.00");
    expect(screen.getByText("الإجمالي").nextElementSibling).toHaveTextContent("46.00");
  });

  it("cart-math-line-disc-total: خصومات الأسطر row appears only when > 0", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ lineDiscount: 5 })] }) });
    renderPanel(ctx);
    expect(screen.getByText("خصومات الأسطر").nextElementSibling).toHaveTextContent("-5.00");
  });

  it("order-discount row appears when a discount is set (10% of 46 → -4.60)", () => {
    const ctx = makeCtx({
      cart: makeOrder({ discountType: "PERCENT", discountValue: 10, discountName: "عرض" }),
    });
    renderPanel(ctx);
    expect(screen.getByText("خصم الطلب").nextElementSibling).toHaveTextContent("-4.60");
  });
});

describe("cart-line-discount-chip — the line's discount is visible on its row", () => {
  it("shows the خصم amount inline on the cart line", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ lineDiscount: 3 })] }) });
    renderPanel(ctx);
    const row = screen.getByRole("button", { name: "تفاصيل شاي مغربي" });
    expect(within(row).getByText("خصم")).toBeInTheDocument();
    expect(within(row).getByText("3.00")).toBeInTheDocument();
  });
});

describe("discount-line-open + discount-line-apply-manual — inline per-row editor", () => {
  it("expanding a row reveals the notes + line-discount editor with the line's ceiling", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2, unitPrice: 23 })] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    expect(screen.getByText(/خصم السطر \(ر\.س\) — الحد/)).toBeInTheDocument();
    expect(screen.getByLabelText("ملاحظات للمطبخ", { exact: false })).toBeInTheDocument();
  });

  it("a manual line discount above the line total is CLAMPED before setLineDiscount", () => {
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 2, unitPrice: 23 })] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "999" } });
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 46); // clamped to qty×price
  });

  it("kitchen notes flow through setLineNotes", () => {
    const ctx = makeCtx();
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    fireEvent.change(screen.getByPlaceholderText("بدون بصل، حار…"), { target: { value: "بدون سكر" } });
    expect(ctx.setLineNotes).toHaveBeenCalledWith(0, "بدون سكر");
  });
});

describe("cart-discount-header-btn / discount-invoice-open — the order-discount entry", () => {
  it("the discount button opens the dialog and shows the applied amount", () => {
    const ctx = makeCtx({ cart: makeOrder({ discountType: "FIXED", discountValue: 6, discountName: "موظف" }) });
    const p = renderPanel(ctx);
    const btn = screen.getByRole("button", { name: /خصم/ });
    expect(btn).toHaveTextContent("«موظف»");
    expect(btn).toHaveTextContent("-6.00");
    fireEvent.click(btn);
    expect(p.onOpenDiscount).toHaveBeenCalledTimes(1);
  });
});

describe("invoice-discount-modal / discount-invoice-apply-manual — DiscountDialog", () => {
  function renderDiscount(ctx: PosContextValue) {
    currentCtx = ctx;
    render(<DiscountDialog open onClose={() => {}} />);
  }

  it("PERCENT apply calls setDiscount with type/value/name", () => {
    const ctx = makeCtx();
    renderDiscount(ctx);
    fireEvent.change(screen.getByPlaceholderText("10"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("عرض الافتتاح، موظف…"), { target: { value: "عرض" } });
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("PERCENT", 10, "عرض");
  });

  it("FIXED preview caps the discount at the subtotal (999 on a 46.00 cart → -46.00)", () => {
    const ctx = makeCtx();
    renderDiscount(ctx);
    fireEvent.click(screen.getByRole("radio", { name: "مبلغ ر.س" }));
    fireEvent.change(screen.getByPlaceholderText("15.00"), { target: { value: "999" } });
    expect(screen.getByText("قيمة الخصم").nextElementSibling).toHaveTextContent("-46.00");
    expect(screen.getByText("الإجمالي بعد الخصم").nextElementSibling).toHaveTextContent("0.00");
  });

  it("cashier over the ceiling sees the server-will-refuse warning; supervisor does not", () => {
    const ctx = makeCtx({ supervisor: false });
    renderDiscount(ctx);
    fireEvent.change(screen.getByPlaceholderText("10"), { target: { value: "50" } }); // 50% > 10% ceiling
    expect(screen.getByRole("alert")).toHaveTextContent("يتجاوز حد الكاشير");
    cleanup();
    const sup = makeCtx({ supervisor: true });
    renderDiscount(sup);
    fireEvent.change(screen.getByPlaceholderText("10"), { target: { value: "50" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discount-invoice-clear: إزالة الخصم renders only when a discount is set and clears it", () => {
    const ctx = makeCtx({ cart: makeOrder({ discountType: "PERCENT", discountValue: 10 }) });
    renderDiscount(ctx);
    fireEvent.click(screen.getByRole("button", { name: "إزالة الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith(null, 0, null);
    cleanup();
    const none = makeCtx();
    renderDiscount(none);
    expect(screen.queryByRole("button", { name: "إزالة الخصم" })).not.toBeInTheDocument();
  });
});

describe("cart-clear — emptying the cart goes through the auditable void flow", () => {
  it("the إلغاء button opens VoidDialog; confirm requires a non-empty reason", () => {
    const ctx = makeCtx();
    const p = renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(p.onVoid).toHaveBeenCalledTimes(1);
    cleanup();

    const onConfirm = vi.fn();
    render(<VoidDialog open onClose={() => {}} onConfirm={onConfirm} busy={false} />);
    const confirmBtn = screen.getByRole("button", { name: /تأكيد الإلغاء/ });
    expect(confirmBtn).toBeDisabled(); // reason mandatory
    fireEvent.change(screen.getByPlaceholderText(/طلب العميل الإلغاء/), { target: { value: "خطأ إدخال" } });
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith("خطأ إدخال");
  });
});

describe("toast-and-confirm-primitives — Toasts render and dismiss", () => {
  it("renders queued toasts with their kind and dismisses on ×", () => {
    const dismissToast = vi.fn();
    currentCtx = makeCtx({
      overrides: {
        toasts: [
          { id: 1, kind: "success", message: "تم الحفظ" },
          { id: 2, kind: "error", message: "فشل الإرسال" },
        ],
        dismissToast,
      },
    });
    render(<Toasts />);
    expect(screen.getByText("تم الحفظ")).toBeInTheDocument();
    expect(screen.getByText("فشل الإرسال")).toBeInTheDocument();
    // Picked by IDENTITY, not by index: errors now render above the transient
    // toasts (they persist until dismissed — see components/Toasts.tsx), so
    // "the first × on screen" is no longer "the first toast in the array".
    const successCard = screen.getByText("تم الحفظ").closest('[data-testid="pos-toast"]') as HTMLElement;
    fireEvent.click(within(successCard).getByRole("button", { name: "إغلاق التنبيه" }));
    expect(dismissToast).toHaveBeenCalledWith(1);
  });
});
