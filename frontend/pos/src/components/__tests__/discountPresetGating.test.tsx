/**
 * W2-B — the register now OBEYS the discount campaign the owner configured.
 *
 * Before this, lib/discountPresets kept only {id,name,type,value,scope,
 * minOrder,maxAmount} out of a row that also carries requireCode, code,
 * requireApproval, minRole, validFrom, validTo and maxPerInvoice. So a promo
 * code applied without its code, a manager-only discount applied by a cashier,
 * a weekend campaign applied on a Tuesday, and an invoice-scope ceiling was
 * ignored entirely (it was honoured on LINE discounts only).
 *
 * Companion to lib/__tests__/discountPresetsCampaign.test.ts, which pins the
 * pure rules; this file pins what the cashier actually sees and can press.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { _resetDiscountPresetsCache } from "@/lib/discountPresets";
import { makeCtx, makeOrder, makeLine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { DiscountDialog } from "../dialogs/DiscountDialog";
import { CartPanel, type CartPanelProps } from "../CartPanel";
import { I18nProvider } from "@/i18n/I18nProvider";

/** A row EXACTLY as routes/settings.js:371 serialises it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "D1",
    name: "عرض",
    type: "percentage",
    value: 10,
    enabled: true,
    showInPos: true,
    discountScope: "invoice",
    maxAmount: 0,
    minOrder: 0,
    maxPerInvoice: 0,
    requireCode: false,
    code: "",
    requireApproval: false,
    minRole: "cashier",
    validFrom: null,
    validTo: null,
    applyOn: "invoice",
    ...over,
  };
}

function stubPresets(rows: unknown[]) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes("/api/settings/discounts-v2-full")) {
      return { ok: true, status: 200, json: async () => rows };
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

const PANEL: CartPanelProps = {
  heldCount: 0, onPay: vi.fn(), onHold: vi.fn(), onOpenHeld: vi.fn(), onVoid: vi.fn(),
  onOpenDiscount: vi.fn(), holdBusy: false, voidDisabledReason: null,
};

function renderDialog(ctx: PosContextValue) {
  currentCtx = ctx;
  render(<DiscountDialog open onClose={() => {}} />);
}

function renderPanelExpanded(ctx: PosContextValue) {
  currentCtx = ctx;
  render(
    <I18nProvider>
      <CartPanel {...PANEL} />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
}

beforeEach(() => {
  cleanup();
  _resetDiscountPresetsCache();
  localStorage.setItem("pos_token", "tok-test");
});
afterEach(() => vi.unstubAllGlobals());

// ── validFrom / validTo ─────────────────────────────────────────────────────
describe("a campaign outside its window is not OFFERED", () => {
  it("hides a preset whose window has closed and one that has not opened", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12));
    try {
      stubPresets([
        row({ id: "live", name: "ساري" }),
        row({ id: "gone", name: "منتهٍ", validTo: "2026-07-01" }),
        row({ id: "soon", name: "قادم", validFrom: "2026-08-01" }),
      ]);
      renderDialog(makeCtx());
      await vi.waitFor(() => expect(screen.getByText("ساري")).toBeInTheDocument());
      expect(screen.queryByText("منتهٍ")).not.toBeInTheDocument();
      expect(screen.queryByText("قادم")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── requireCode ─────────────────────────────────────────────────────────────
describe("requireCode — the promo code is asked for, and it has to be right", () => {
  const PROMO = [row({ id: "promo", name: "رمضان", type: "fixed", value: 25, requireCode: true, code: "RAMADAN25" })];

  it("tapping the card does NOT apply anything — it asks for the code", async () => {
    stubPresets(PROMO);
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("رمضان"));
    expect(screen.getByLabelText("رمز العرض — رمضان")).toBeInTheDocument();
    // the form is untouched until the code is confirmed
    expect(screen.getByLabelText(/^المبلغ|النسبة/)).toHaveValue(null);
  });

  it("a wrong code is refused and nothing is filled", async () => {
    stubPresets(PROMO);
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("رمضان"));
    fireEvent.change(screen.getByLabelText("رمز العرض — رمضان"), { target: { value: "WRONG" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الرمز" }));
    expect(screen.getByRole("alert")).toHaveTextContent("الرمز غير صحيح");
    expect(ctx.setDiscount).not.toHaveBeenCalled();
  });

  it("the right code fills the form, and only then does «تطبيق الخصم» apply it", async () => {
    stubPresets(PROMO);
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("رمضان"));
    fireEvent.change(screen.getByLabelText("رمز العرض — رمضان"), { target: { value: "ramadan25" } }); // case-insensitive
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الرمز" }));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("FIXED", 25, "رمضان");
  });

  it("the line editor asks for the code too", async () => {
    stubPresets([row({ id: "lp", name: "رمز سطر", discountScope: "line", type: "fixed", value: 5, requireCode: true, code: "L5" })]);
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine()] }) });
    renderPanelExpanded(ctx);
    fireEvent.click(await screen.findByText("رمز سطر"));
    expect(ctx.setLineDiscount).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("رمز العرض — رمز سطر"), { target: { value: "L5" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد" }));
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 5);
  });
});

// ── requireApproval / minRole ───────────────────────────────────────────────
describe("requireApproval / minRole — a cashier cannot apply a manager's discount", () => {
  const GATED = [row({ id: "staff", name: "خصم موظف", type: "fixed", value: 20, requireApproval: true })];

  it("the card is disabled for a plain cashier, with the reason on it", async () => {
    stubPresets(GATED);
    renderDialog(makeCtx()); // makeCtx: role cashier, supervisor false, posCan → false
    const card = (await screen.findByText("خصم موظف")).closest("button")!;
    expect(card).toBeDisabled();
    expect(card).toHaveAttribute("title", "هذا الخصم يتطلب صلاحية مدير");
  });

  it("a supervisor applies it directly — privileged actors short-circuit the gate", async () => {
    stubPresets(GATED);
    const ctx = makeCtx({ supervisor: true });
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("خصم موظف"));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("FIXED", 20, "خصم موظف");
  });

  it("the pos.discount.override capability opens it without the supervisor role", async () => {
    stubPresets(GATED);
    const ctx = makeCtx({ overrides: { posCan: vi.fn((c: string) => c === "pos.discount.override") } });
    renderDialog(ctx);
    const card = (await screen.findByText("خصم موظف")).closest("button")!;
    expect(card).not.toBeDisabled();
  });

  it("minRole above the cashier locks the card just the same", async () => {
    stubPresets([row({ id: "mgr", name: "خصم مدير", minRole: "manager" })]);
    renderDialog(makeCtx());
    expect((await screen.findByText("خصم مدير")).closest("button")).toBeDisabled();
  });

  it("the line editor locks it too", async () => {
    stubPresets([row({ id: "lm", name: "سطر مدير", discountScope: "line", minRole: "manager" })]);
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine()] }) });
    renderPanelExpanded(ctx);
    expect((await screen.findByText("سطر مدير")).closest("button")).toBeDisabled();
    expect(ctx.setLineDiscount).not.toHaveBeenCalled();
  });
});

// ── maxAmount on the INVOICE (the fixed asymmetry) + maxPerInvoice ──────────
describe("the ceilings the invoice dialog used to ignore", () => {
  it("a 20%/max-50 preset on a 900 subtotal fills 50 FIXED, not 20% (=180)", async () => {
    stubPresets([row({ id: "cap", name: "عرض مسقوف", type: "percentage", value: 20, maxAmount: 50 })]);
    // 20 × 45.00 tax-inclusive = 900.00 subtotal
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 20, unitPrice: 45 })] }) });
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("عرض مسقوف"));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("FIXED", 50, "عرض مسقوف");
    expect(screen.getByText(/سُقِف الخصم عند/)).toBeInTheDocument();
  });

  it("maxPerInvoice caps the invoice discount exactly the same way", async () => {
    stubPresets([row({ id: "cap2", name: "سقف الفاتورة", type: "fixed", value: 300, maxPerInvoice: 75 })]);
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 20, unitPrice: 45 })] }) });
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("سقف الفاتورة"));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("FIXED", 75, "سقف الفاتورة");
  });

  it("under the ceiling a percentage still fills as a PERCENTAGE — no needless rewrite", async () => {
    stubPresets([row({ id: "ok", name: "عرض عادي", type: "percentage", value: 10, maxAmount: 500 })]);
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine({ qty: 20, unitPrice: 45 })] }) });
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("عرض عادي"));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("PERCENT", 10, "عرض عادي");
    expect(screen.queryByText(/سُقِف الخصم عند/)).not.toBeInTheDocument();
  });

  it("maxPerInvoice is a shared budget ACROSS lines, not a per-line allowance", async () => {
    stubPresets([row({ id: "budget", name: "ميزانية", discountScope: "line", type: "fixed", value: 5, maxPerInvoice: 8 })]);
    const ctx = makeCtx({
      cart: makeOrder({ lines: [makeLine(), makeLine({ menuId: "M2", name: "طاجين لحم" })] }),
    });
    currentCtx = ctx;
    render(
      <I18nProvider>
        <CartPanel {...PANEL} />
      </I18nProvider>,
    );
    // first line takes the full 5
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    fireEvent.click(await screen.findByText("ميزانية"));
    expect(ctx.setLineDiscount).toHaveBeenLastCalledWith(0, 5);
    // the second line only gets what is left of the 8
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل طاجين لحم" }));
    await waitFor(() => expect(screen.getAllByText("ميزانية")).toHaveLength(2));
    const cards = screen.getAllByText("ميزانية");
    fireEvent.click(cards[cards.length - 1]);
    expect(ctx.setLineDiscount).toHaveBeenLastCalledWith(1, 3);
  });
});

// ── nothing configured behaves exactly as before ────────────────────────────
describe("a plain preset is untouched by any of this", () => {
  it("still fills type/value/name on a single tap", async () => {
    stubPresets([row({ id: "plain", name: "عرض الافتتاح", type: "percentage", value: 10 })]);
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("عرض الافتتاح"));
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("PERCENT", 10, "عرض الافتتاح");
  });
});
