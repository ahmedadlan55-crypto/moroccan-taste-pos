/**
 * Parity — البيع (sell): the checkout watchdog, pinned against legacy
 * public/pos/app.js:2753-2770 (v7.5) — a hung fetch (connection accepted, no
 * response, no rejection) fires NEITHER handler and the pay surface stayed
 * locked forever; after 120s legacy released the lock with «انتهت مهلة الاتصال…
 * أعد المحاولة بأمان» because the retry is deduped on clientOrderId.
 * Slugs: pay-watchdog / checkout-watchdog. The underlying engine op is NOT
 * aborted — it may still land; the copy says so and offers retry/close.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import type { CheckoutOutcome } from "@/lib/offline";
import { makeCtx, makeFakeEngine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { PaymentDialog, CHECKOUT_WATCHDOG_MS } from "../dialogs/PaymentDialog";

function openDialog(ctx: PosContextValue, onClose = vi.fn()) {
  currentCtx = ctx;
  render(<PaymentDialog open onClose={onClose} />);
  return onClose;
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pay-watchdog — a hung checkout is released after 120s", () => {
  it("fires at exactly 120s: working → «انتهت مهلة الطلب» with retry/close; retry re-runs checkout", () => {
    const engine = makeFakeEngine();
    engine.checkout.mockImplementation(() => new Promise<never>(() => {})); // hung fetch
    const onClose = openDialog(makeCtx({ engine }), vi.fn());

    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    expect(screen.getByRole("status")).toHaveTextContent("تثبيت الطلب…");

    act(() => vi.advanceTimersByTime(CHECKOUT_WATCHDOG_MS - 1));
    expect(screen.queryByText(/انتهت مهلة الطلب/)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert")).toHaveTextContent("انتهت مهلة الطلب — تحقق من الاتصال ثم أعد المحاولة");
    // the copy is explicit that the op was NOT aborted and a retry cannot double-charge
    expect(screen.getByText(/لم يُلغَ الطلب/)).toBeInTheDocument();
    expect(screen.getByText(/فلن يتكرر/)).toBeInTheDocument();

    // close is an exit (the dialog is no longer locked) — scope to the panel:
    // the Dialog shell has its own إغلاق (X) button
    const panel = within(screen.getByTestId("pay-timeout-panel"));
    expect(panel.getByRole("button", { name: "إغلاق" })).toBeEnabled();
    fireEvent.click(panel.getByRole("button", { name: "إغلاق" }));
    expect(onClose).toHaveBeenCalled();

    // retry drives the (idempotent) chain again and re-arms the working phase
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(engine.checkout).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("تثبيت الطلب…");
  });

  it("does NOT fire after success — the timer dies with the working phase", async () => {
    const engine = makeFakeEngine(); // default checkout resolves 'completed'
    openDialog(makeCtx({ engine }));

    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await act(async () => {}); // flush the resolved checkout promise
    expect(screen.getByText("تم الدفع بنجاح")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(CHECKOUT_WATCHDOG_MS * 2));
    expect(screen.queryByText(/انتهت مهلة الطلب/)).not.toBeInTheDocument();
    expect(screen.getByText("تم الدفع بنجاح")).toBeInTheDocument();
  });

  it("a LATE outcome after the watchdog fired still surfaces (the op was never aborted)", async () => {
    const engine = makeFakeEngine();
    let resolveCheckout!: (o: CheckoutOutcome) => void;
    engine.checkout.mockImplementation(
      () => new Promise<CheckoutOutcome>((res) => { resolveCheckout = res; }),
    );
    openDialog(makeCtx({ engine }));

    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    act(() => vi.advanceTimersByTime(CHECKOUT_WATCHDOG_MS));
    expect(screen.getByText(/انتهت مهلة الطلب/)).toBeInTheDocument();

    await act(async () => {
      resolveCheckout({ state: "completed", invoiceNumber: "INV-9", saleId: "S9", zatcaQrDataUrl: null });
    });
    expect(screen.getByText("تم الدفع بنجاح")).toBeInTheDocument();
    expect(screen.queryByText(/انتهت مهلة الطلب/)).not.toBeInTheDocument();
  });
});
