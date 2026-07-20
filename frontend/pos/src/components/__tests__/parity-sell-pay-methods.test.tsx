/**
 * Parity — البيع (sell): dynamic payment-method tiles + payment notes, pinned
 * against legacy public/pos/app.js:
 *   pay-method-tiles / payment-tender-tiles — renderPayButtons driven by
 *     /settings/payment-methods-full (app.js:2390-2426 + 4976-4994)
 *   pay-notes-block / pay-notes-counter — _payNotesUpdate (app.js:1184-1194)
 *   pay-notes-required / payment-other-notes — doCheckout blocks an 'Other'
 *     tender until the note is ≥3 chars and ships it as paymentNotes
 *     (app.js:2555-2569, 2624)
 * usePos is mocked (parityTestkit); the dialog renders for real.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import type { CatalogPaymentMethod } from "@/lib/types";
import { makeCtx, makeFakeEngine, makeCatalog } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { PaymentDialog } from "../dialogs/PaymentDialog";
// PaymentDialog resolves strings via useT(), which throws without an
// ancestor I18nProvider (see i18n/I18nProvider.tsx).
import { I18nProvider } from "@/i18n/I18nProvider";

const OWNER_METHODS: CatalogPaymentMethod[] = [
  { id: 7, name: "Bank Transfer", nameAr: "تحويل بنكي", groupType: "bank" },
  { id: 9, name: "Other", nameAr: "أخرى", groupType: "other" },
  // A row shadowing a built-in must NOT render a duplicate tile.
  { id: 1, name: "Cash", nameAr: "كاش قديم", groupType: "cash" },
];

function openDialog(ctx: PosContextValue) {
  currentCtx = ctx;
  return render(
    <I18nProvider>
      <PaymentDialog open onClose={() => {}} />
    </I18nProvider>,
  );
}

function ctxWithMethods(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ catalog: makeCatalog({ paymentMethods: OWNER_METHODS }), ...opts });
}

beforeEach(() => cleanup());

describe("pay-method-tiles — tiles come from catalog.paymentMethods", () => {
  it("an old server (no paymentMethods) renders exactly the four built-in tabs", () => {
    openDialog(makeCtx());
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    for (const label of ["كاش", "شبكة", "مختلط", "آجل"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
  });

  it("owner methods append AFTER the built-ins with their Arabic labels; built-in names are not duplicated", () => {
    openDialog(ctxWithMethods());
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["كاش", "شبكة", "مختلط", "آجل", "تحويل بنكي", "أخرى"]);
  });

  it("owner tiles are disabled offline (queued replay is CASH only)", () => {
    openDialog(ctxWithMethods({ online: false }));
    expect(screen.getByRole("tab", { name: "تحويل بنكي" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "أخرى" })).toBeDisabled();
  });

  it("confirming an owner method ships the method NAME verbatim as the single payment leg", async () => {
    const engine = makeFakeEngine();
    openDialog(ctxWithMethods({ engine }));
    fireEvent.click(screen.getByRole("tab", { name: "تحويل بنكي" }));
    // non-'other' group → no notes block, confirm immediately available
    expect(screen.queryByLabelText("ملاحظات الدفع")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await waitFor(() => expect(engine.checkout).toHaveBeenCalledTimes(1));
    const [, payments, opts] = engine.checkout.mock.calls[0]!;
    expect(payments).toEqual([{ method: "Bank Transfer", amount: 46 }]);
    expect(opts.paymentNotes).toBeUndefined();
  });
});

describe("pay-notes-block + pay-notes-counter + pay-notes-required — the 'other' gate", () => {
  it("selecting «أخرى» reveals the notes field with a 0/200 counter and blocks confirm", () => {
    openDialog(ctxWithMethods());
    fireEvent.click(screen.getByRole("tab", { name: "أخرى" }));
    expect(screen.getByLabelText("ملاحظات الدفع")).toBeInTheDocument();
    expect(screen.getByTestId("pay-notes-counter")).toHaveTextContent("0/200");
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("٣ أحرف على الأقل");
  });

  it("a note under 3 chars keeps confirm blocked; ≥3 chars unblocks and updates the counter", () => {
    openDialog(ctxWithMethods());
    fireEvent.click(screen.getByRole("tab", { name: "أخرى" }));
    const note = screen.getByLabelText("ملاحظات الدفع");
    fireEvent.change(note, { target: { value: "اح" } });
    expect(screen.getByTestId("pay-notes-counter")).toHaveTextContent("2/200");
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
    fireEvent.change(note, { target: { value: "تحويل عهدة" } });
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeEnabled();
  });

  it("whitespace does not satisfy the gate (trimmed length rules)", () => {
    openDialog(ctxWithMethods());
    fireEvent.click(screen.getByRole("tab", { name: "أخرى" }));
    fireEvent.change(screen.getByLabelText("ملاحظات الدفع"), { target: { value: "     " } });
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });

  it("payment-other-notes — the trimmed note rides into checkout as paymentNotes", async () => {
    const engine = makeFakeEngine();
    openDialog(ctxWithMethods({ engine }));
    fireEvent.click(screen.getByRole("tab", { name: "أخرى" }));
    fireEvent.change(screen.getByLabelText("ملاحظات الدفع"), { target: { value: "  تحويل عهدة  " } });
    fireEvent.click(screen.getByRole("button", { name: /تأكيد الدفع/ }));
    await waitFor(() => expect(engine.checkout).toHaveBeenCalledTimes(1));
    const [, payments, opts] = engine.checkout.mock.calls[0]!;
    expect(payments).toEqual([{ method: "Other", amount: 46 }]);
    expect(opts.paymentNotes).toBe("تحويل عهدة");
  });
});

describe("split-credit-gate — the مختلط tab's آجل leg is supervisor-gated too", () => {
  it("non-supervisor: the آجل input in the split tab is disabled with the same tooltip as the credit tab", () => {
    openDialog(makeCtx({ supervisor: false }));
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [, , creditInput] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    expect(creditInput).toBeDisabled();
    expect(creditInput).toHaveAttribute("title", "البيع الآجل يتطلب مشرفًا/مديرًا");
    // Same wording the dedicated credit tab already uses.
    expect(screen.getByRole("tab", { name: "آجل" })).toHaveAttribute("title", "البيع الآجل يتطلب مشرفًا/مديرًا");
  });

  it("typing into the disabled آجل split input does nothing — value stays empty", () => {
    openDialog(makeCtx({ supervisor: false }));
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [, , creditInput] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    fireEvent.change(creditInput, { target: { value: "50" } });
    expect(creditInput.value).toBe("");
    // The live sum still reads 0 — the keystroke never reached state.
    expect(screen.getByText("0.00 / 46.00")).toBeInTheDocument();
  });

  it("supervisor: the split آجل input is enabled and behaves exactly as before (no regression)", () => {
    openDialog(makeCtx({ supervisor: true }));
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [cashInput, , creditInput] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    expect(creditInput).toBeEnabled();
    expect(creditInput).not.toHaveAttribute("title");
    fireEvent.change(cashInput, { target: { value: "20" } });
    fireEvent.change(creditInput, { target: { value: "26" } });
    expect(screen.getByText("المجموع مطابق")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeEnabled();
  });

  it("confirmDisabled: non-supervisor cash+credit split summing to the total is still blocked (role gate, not a sum check)", () => {
    openDialog(makeCtx({ supervisor: false }));
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [cashInput, , creditInput] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    fireEvent.change(cashInput, { target: { value: "20" } });
    // Bypasses the disabled attribute directly (as fireEvent does) to prove
    // confirmDisabled's own role check — not just the input's disabled state
    // — is what blocks the button.
    fireEvent.change(creditInput, { target: { value: "26" } });
    expect(screen.getByRole("button", { name: /تأكيد الدفع/ })).toBeDisabled();
  });

  it("supervisor status dropping mid-session clears a stale split-credit amount", () => {
    const ctx = makeCtx({ supervisor: true });
    const { rerender } = openDialog(ctx);
    fireEvent.click(screen.getByRole("tab", { name: "مختلط" }));
    const [, , creditInput] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    fireEvent.change(creditInput, { target: { value: "30" } });
    expect(creditInput.value).toBe("30");
    currentCtx = makeCtx({ supervisor: false });
    rerender(
      <I18nProvider>
        <PaymentDialog open onClose={() => {}} />
      </I18nProvider>,
    );
    const [, , creditInputAfter] = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    expect(creditInputAfter.value).toBe("");
  });
});
