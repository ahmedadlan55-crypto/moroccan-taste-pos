/**
 * ComboDialog — العروض chooser, pinned against the legacy acceptance contract
 * (public/pos/app.js _comboOpenModal/_comboFinalize):
 *   - fixed components render READ-ONLY;
 *   - «أضف للسلة» stays LOCKED until every group satisfies its min;
 *   - max is enforced (single-select replaces; multi-select refuses past max);
 *   - the title shows name + price and the price follows picked priceDeltas;
 *   - confirm emits the EXACT frozen shape: { [groupId]: menuId[] } + a human
 *     notes summary.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComboDialog,
  emptySelection,
  finalizeCombo,
  gateSatisfied,
  toggleOption,
  type ComboFinalizeResult,
} from "../dialogs/ComboDialog";
import type { ComboDef, ComboGroup } from "@/lib/types";

const DRINKS: ComboGroup = {
  id: "G-DRINK",
  name: "اختر مشروبًا",
  min: 1,
  max: 1,
  options: [
    { menuId: "M-PEPSI", name: "بيبسي", priceDelta: 0 },
    { menuId: "M-JUICE", name: "عصير برتقال", priceDelta: 3 },
  ],
};
const SIDES: ComboGroup = {
  id: "G-SIDE",
  name: "اختر إضافتين",
  min: 0,
  max: 2,
  options: [
    { menuId: "M-FRIES", name: "بطاطس", priceDelta: 0 },
    { menuId: "M-RINGS", name: "حلقات بصل", priceDelta: 2 },
    { menuId: "M-SALAD", name: "سلطة", priceDelta: 0 },
  ],
};
const COMBO: ComboDef = {
  id: "C-1",
  menuId: "M-COMBO",
  name: "وجبة شاورما",
  price: 35,
  fixedComponents: [{ menuId: "M-SHAWARMA", name: "شاورما دجاج", qty: 2 }],
  groups: [DRINKS, SIDES],
};

beforeEach(() => cleanup());

function renderDialog(onConfirm = vi.fn(), combo: ComboDef = COMBO) {
  render(<ComboDialog open combo={combo} onClose={vi.fn()} onConfirm={onConfirm} />);
  return onConfirm;
}

describe("fixed components — read-only", () => {
  it("lists every fixed component with its qty, with no button to change it", () => {
    renderDialog();
    const fixed = screen.getByTestId("combo-fixed");
    expect(fixed.textContent).toContain("يشمل دائماً");
    expect(fixed.textContent).toContain("شاورما دجاج ×2");
    expect(fixed.querySelector("button")).toBeNull();
  });
});

describe("combo-confirm-gate — locked until every group satisfies min", () => {
  it("confirm is disabled with nothing picked and enables once min is met", () => {
    renderDialog();
    const confirm = screen.getByTestId("combo-confirm");
    expect(confirm).toBeDisabled(); // G-DRINK needs 1
    fireEvent.click(screen.getByRole("button", { name: /بيبسي/ }));
    expect(confirm).toBeEnabled(); // G-SIDE min=0 — already satisfied
  });

  it("toggling the required pick back OFF re-locks the gate", () => {
    renderDialog();
    const pepsi = screen.getByRole("button", { name: /بيبسي/ });
    fireEvent.click(pepsi);
    expect(screen.getByTestId("combo-confirm")).toBeEnabled();
    fireEvent.click(pepsi); // off again
    expect(screen.getByTestId("combo-confirm")).toBeDisabled();
  });

  it("a combo with no groups is confirmable immediately", () => {
    const onConfirm = renderDialog(vi.fn(), { ...COMBO, groups: [] });
    expect(screen.getByText("هذا العرض بلا خيارات")).toBeInTheDocument();
    const confirm = screen.getByTestId("combo-confirm");
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      comboChoices: {},
      notesSummary: null,
      priceDeltaTotal: 0,
      unitPrice: 35,
    } satisfies ComboFinalizeResult);
  });
});

describe("combo-option-toggle — max enforced", () => {
  it("single-select (max=1): picking another option REPLACES the pick", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /بيبسي/ }));
    fireEvent.click(screen.getByRole("button", { name: /عصير برتقال/ }));
    expect(screen.getByRole("button", { name: /بيبسي/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /عصير برتقال/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("multi-select at max: further options are blocked, toggling one off frees a slot", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /بطاطس/ }));
    fireEvent.click(screen.getByRole("button", { name: /حلقات بصل/ }));
    const salad = screen.getByRole("button", { name: /سلطة/ });
    expect(salad).toBeDisabled(); // at max=2
    fireEvent.click(salad); // refused
    expect(salad).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /بطاطس/ })); // off — slot freed
    expect(salad).toBeEnabled();
  });

  it("pure toggleOption: at-max add is a no-op, off is always allowed", () => {
    expect(toggleOption(SIDES, ["M-FRIES", "M-RINGS"], "M-SALAD")).toEqual(["M-FRIES", "M-RINGS"]);
    expect(toggleOption(SIDES, ["M-FRIES", "M-RINGS"], "M-RINGS")).toEqual(["M-FRIES"]);
    expect(toggleOption(DRINKS, ["M-PEPSI"], "M-JUICE")).toEqual(["M-JUICE"]); // replace
  });
});

describe("combo-modal-title-price — name + live price", () => {
  it("title shows the combo name and base price, then follows priceDelta picks", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "وجبة شاورما — 35.00 ر.س" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /عصير برتقال/ })); // +3
    fireEvent.click(screen.getByRole("button", { name: /حلقات بصل/ })); // +2
    expect(screen.getByRole("dialog", { name: "وجبة شاورما — 40.00 ر.س" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /بيبسي/ })); // replaces juice (+3 → 0)
    expect(screen.getByRole("dialog", { name: "وجبة شاورما — 37.00 ر.س" })).toBeInTheDocument();
  });
});

describe("combo-finalize — the exact frozen shape", () => {
  it("confirm emits { [groupId]: menuId[] } + the human notes summary + the price", () => {
    const onConfirm = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /عصير برتقال/ }));
    fireEvent.click(screen.getByRole("button", { name: /بطاطس/ }));
    fireEvent.click(screen.getByRole("button", { name: /سلطة/ }));
    fireEvent.click(screen.getByTestId("combo-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual({
      comboChoices: { "G-DRINK": ["M-JUICE"], "G-SIDE": ["M-FRIES", "M-SALAD"] },
      notesSummary: "عصير برتقال + بطاطس + سلطة",
      priceDeltaTotal: 3,
      unitPrice: 38,
    } satisfies ComboFinalizeResult);
  });

  it("pure finalizeCombo matches the dialog byte-for-byte", () => {
    const sel = { ...emptySelection(COMBO), "G-DRINK": ["M-PEPSI"] };
    expect(gateSatisfied(COMBO, sel)).toBe(true);
    expect(finalizeCombo(COMBO, sel, 35)).toEqual({
      comboChoices: { "G-DRINK": ["M-PEPSI"], "G-SIDE": [] },
      notesSummary: "بيبسي",
      priceDeltaTotal: 0,
      unitPrice: 35,
    });
  });
});
