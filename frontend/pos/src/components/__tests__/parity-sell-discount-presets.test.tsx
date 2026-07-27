/**
 * Parity — خصومات جاهزة (close/w25-sell-ui): preset discount cards in the
 * invoice DiscountDialog + the cart-line discount editor, pinned against
 * legacy public/pos/app.js:
 *   discount-legacy-apply         GET /settings/discounts-v2-full (app.js:4996)
 *   discount-invoice-apply-preset posOpenInvoiceDiscountModal cards + scope
 *                                 filter invoice|preset|manual (app.js:5438-5500)
 *   discount-line-apply-preset    posSelectLineForDiscount cards + scope filter
 *                                 line|preset|manual, % of the line gross capped
 *                                 by maxAmount then the line total (app.js:5343-5420)
 * usePos is mocked (parityTestkit); fetch is stubbed at the endpoint.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { _resetDiscountPresetsCache } from "@/lib/discountPresets";
import { makeCtx, makeOrder, makeLine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

import { DiscountDialog } from "../dialogs/DiscountDialog";
import { CartPanel, type CartPanelProps } from "../CartPanel";
// CartPanel resolves strings via useT(), which throws without an ancestor
// I18nProvider (see i18n/I18nProvider.tsx). DiscountDialog does not use i18n,
// so renderDialog() below is left unwrapped.
import { I18nProvider } from "@/i18n/I18nProvider";

const ROWS = [
  { id: 1, name: "عرض الافتتاح", type: "percentage", value: 10, enabled: true, showInPos: true, discountScope: "invoice" },
  { id: 2, name: "خصم موظف", type: "fixed", value: 5, enabled: true, showInPos: true, discountScope: "preset" },
  { id: 3, name: "خصم سطر", type: "percentage", value: 50, enabled: true, showInPos: true, discountScope: "line", maxAmount: 10 },
  { id: 4, name: "معطل", type: "percentage", value: 30, enabled: false, discountScope: "invoice" },
  { id: 5, name: "كبير", type: "percentage", value: 10, enabled: true, discountScope: "invoice", minOrder: 100 },
];

function stubPresetFetch(rows: unknown = ROWS, ok = true) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes("/api/settings/discounts-v2-full")) {
      if (!ok) throw new Error("network down");
      return { ok: true, status: 200, json: async () => rows };
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

function renderDialog(ctx: PosContextValue) {
  currentCtx = ctx;
  return render(<DiscountDialog open onClose={() => {}} />);
}

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
}

beforeEach(() => {
  cleanup();
  _resetDiscountPresetsCache();
  localStorage.setItem("pos_token", "tok-test"); // auth.getToken() source
});

afterEach(() => vi.unstubAllGlobals());

describe("discount-legacy-apply + discount-invoice-apply-preset — invoice dialog", () => {
  it("renders invoice/preset presets with the token'd endpoint; line-scoped and disabled rows stay out", async () => {
    const fetchFn = stubPresetFetch();
    renderDialog(makeCtx());
    expect(await screen.findByText("عرض الافتتاح")).toBeInTheDocument();
    expect(screen.getByText("خصم موظف")).toBeInTheDocument();
    expect(screen.queryByText("خصم سطر")).not.toBeInTheDocument(); // scope line
    expect(screen.queryByText("معطل")).not.toBeInTheDocument(); // enabled false
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toMatch(/^Bearer /);
  });

  it("a percentage preset FILLS the form (type/value/name) and applies through the normal button", async () => {
    stubPresetFetch();
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("عرض الافتتاح"));
    expect(screen.getByRole("radio", { name: "نسبة %" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText(/النسبة/)).toHaveValue(10);
    expect(screen.getByLabelText("اسم الخصم")).toHaveValue("عرض الافتتاح");
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("PERCENT", 10, "عرض الافتتاح");
  });

  it("a fixed preset fills FIXED + value exactly as manual entry would", async () => {
    stubPresetFetch();
    const ctx = makeCtx();
    renderDialog(ctx);
    fireEvent.click(await screen.findByText("خصم موظف"));
    expect(screen.getByRole("radio", { name: "مبلغ ر.س" })).toHaveAttribute("aria-checked", "true");
    // Anchored: the dialog now also carries the on-screen keypad, whose clear
    // key is labelled «مسح المبلغ» — an unanchored /المبلغ/ matches both.
    expect(screen.getByLabelText(/^المبلغ/)).toHaveValue(5);
    fireEvent.click(screen.getByRole("button", { name: "تطبيق الخصم" }));
    expect(ctx.setDiscount).toHaveBeenCalledWith("FIXED", 5, "خصم موظف");
  });

  it("minOrder gates the card (100 > the 46.00 cart → disabled)", async () => {
    stubPresetFetch();
    renderDialog(makeCtx());
    const card = (await screen.findByText("كبير")).closest("button")!;
    expect(card).toBeDisabled();
  });

  it("a failed fetch degrades to NO preset section — manual entry untouched", async () => {
    stubPresetFetch(undefined, false);
    renderDialog(makeCtx());
    // the form is there…
    expect(screen.getByLabelText(/النسبة/)).toBeInTheDocument();
    // …and no preset strip ever appears
    await Promise.resolve();
    expect(screen.queryByText("خصومات جاهزة")).not.toBeInTheDocument();
  });
});

describe("discount-line-apply-preset — the cart-line editor", () => {
  it("expanding a line shows line/preset presets; the invoice-scoped one stays out", async () => {
    stubPresetFetch();
    renderPanel(makeCtx({ cart: makeOrder({ lines: [makeLine()] }) }));
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    expect(await screen.findByText("خصم سطر")).toBeInTheDocument();
    expect(screen.getByText("خصم موظف")).toBeInTheDocument();
    expect(screen.queryByText("عرض الافتتاح")).not.toBeInTheDocument();
  });

  it("a % preset applies percentage-of-gross capped by maxAmount (50% of 46 → capped at 10)", async () => {
    stubPresetFetch();
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine()] }) }); // 2 × 23 = 46
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    fireEvent.click(await screen.findByText("خصم سطر"));
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 10);
  });

  it("a fixed preset lands as the amount manual entry would produce", async () => {
    stubPresetFetch();
    const ctx = makeCtx({ cart: makeOrder({ lines: [makeLine()] }) });
    renderPanel(ctx);
    fireEvent.click(screen.getByRole("button", { name: "تفاصيل شاي مغربي" }));
    fireEvent.click(await screen.findByText("خصم موظف"));
    expect(ctx.setLineDiscount).toHaveBeenCalledWith(0, 5);
  });
});
