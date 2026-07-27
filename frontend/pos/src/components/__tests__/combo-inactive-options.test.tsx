/**
 * ComboDialog — inactive options must never be offered.
 *
 * The chooser mapped `g.options` verbatim. The server ships `active:false` for
 * an option whose menu row was deactivated and then REFUSES the sale at sync
 * with «الخيار "X" غير نشط» — so the cashier could build a cart that was
 * guaranteed to fail minutes later, after the customer had already been told
 * the price. Filtering here is display-only; the server stays the authority.
 *
 * The `active` flag is read DEFENSIVELY: an older server (or a catalog cached
 * before the field existed) omits it entirely, and dropping every option in
 * that case would empty every combo in the shop.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComboDef, ComboGroup, ComboOption } from "@/lib/types";
import {
  ComboDialog,
  activeOptions,
  isOptionActive,
  unsatisfiableGroups,
} from "../dialogs/ComboDialog";

afterEach(() => cleanup());

/** The wire carries `active`; the shared ComboOption type does not declare it. */
function opt(menuId: string, name: string, active?: unknown): ComboOption {
  const base: ComboOption = { menuId, name, priceDelta: 0 };
  return active === undefined ? base : ({ ...base, active } as ComboOption);
}

function combo(groups: ComboGroup[]): ComboDef {
  return { id: "C1", menuId: "M-COMBO", name: "وجبة العائلة", price: 35, fixedComponents: [], groups };
}

const DRINKS_ONE_DEAD = combo([
  {
    id: "G-DRINK",
    name: "اختر مشروبًا",
    min: 1,
    max: 1,
    options: [opt("M-PEPSI", "بيبسي"), opt("M-JUICE", "عصير", false), opt("M-WATER", "ماء", true)],
  },
]);

describe("isOptionActive — defensive, absence means ACTIVE", () => {
  it("treats a missing/null flag as sellable (old server, old cache)", () => {
    expect(isOptionActive(opt("A", "a"))).toBe(true);
    expect(isOptionActive(opt("A", "a", null))).toBe(true);
    expect(isOptionActive(opt("A", "a", undefined))).toBe(true);
  });

  it("only an explicit falsy marker hides an option (bool / tinyint / string)", () => {
    expect(isOptionActive(opt("A", "a", false))).toBe(false);
    expect(isOptionActive(opt("A", "a", 0))).toBe(false);
    expect(isOptionActive(opt("A", "a", "0"))).toBe(false);
    expect(isOptionActive(opt("A", "a", "false"))).toBe(false);
    expect(isOptionActive(opt("A", "a", true))).toBe(true);
    expect(isOptionActive(opt("A", "a", 1))).toBe(true);
    expect(isOptionActive(opt("A", "a", "1"))).toBe(true);
  });
});

describe("the chooser hides inactive options", () => {
  it("renders only the sellable options — the dead one is not even in the DOM", () => {
    render(<ComboDialog open combo={DRINKS_ONE_DEAD} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: /بيبسي/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ماء/ })).toBeInTheDocument();
    // …so it cannot be picked, and the sale cannot fail on it at sync.
    expect(screen.queryByRole("button", { name: /عصير/ })).not.toBeInTheDocument();
  });

  it("an active pick still confirms normally (the filter changes nothing else)", () => {
    const onConfirm = vi.fn();
    render(<ComboDialog open combo={DRINKS_ONE_DEAD} onClose={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: /بيبسي/ }));
    fireEvent.click(screen.getByTestId("combo-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ comboChoices: { "G-DRINK": ["M-PEPSI"] }, notesSummary: "بيبسي" }),
    );
  });

  it("options with NO active flag are all still shown (defensive default)", () => {
    const legacy = combo([
      { id: "G", name: "اختر", min: 1, max: 1, options: [opt("A", "كولا"), opt("B", "لبن")] },
    ]);
    render(<ComboDialog open combo={legacy} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: /كولا/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /لبن/ })).toBeInTheDocument();
    expect(screen.queryByTestId("combo-unsellable")).not.toBeInTheDocument();
  });
});

describe("a group that can no longer reach its minimum blocks the combo", () => {
  const ALL_DEAD = combo([
    {
      id: "G-DRINK",
      name: "اختر مشروبًا",
      min: 1,
      max: 1,
      options: [opt("M-PEPSI", "بيبسي", false), opt("M-JUICE", "عصير", false)],
    },
  ]);

  const SHORT = combo([
    {
      id: "G-SIDES",
      name: "اختر طبقين",
      min: 2,
      max: 2,
      options: [opt("M-FRIES", "بطاطس"), opt("M-RINGS", "حلقات", false), opt("M-SALAD", "سلطة", false)],
    },
  ]);

  it("unsatisfiableGroups names exactly the groups that cannot be completed", () => {
    expect(unsatisfiableGroups(DRINKS_ONE_DEAD)).toEqual([]);
    expect(unsatisfiableGroups(ALL_DEAD).map((g) => g.id)).toEqual(["G-DRINK"]);
    expect(unsatisfiableGroups(SHORT).map((g) => g.id)).toEqual(["G-SIDES"]);
    expect(unsatisfiableGroups(null)).toEqual([]);
  });

  it("says so and keeps «أضف للسلة» locked when every option is inactive", () => {
    const onConfirm = vi.fn();
    render(<ComboDialog open combo={ALL_DEAD} onClose={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByTestId("combo-unsellable")).toBeInTheDocument();
    expect(screen.getByTestId("combo-group-inactive-G-DRINK")).toBeInTheDocument();
    const confirm = screen.getByTestId("combo-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says so when SOME options survive but fewer than the minimum", () => {
    const onConfirm = vi.fn();
    render(<ComboDialog open combo={SHORT} onClose={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByTestId("combo-unsellable")).toBeInTheDocument();
    expect(screen.getByTestId("combo-group-short-G-SIDES")).toBeInTheDocument();
    // the survivor is still listed (the cashier can see WHAT is left)…
    expect(screen.getByRole("button", { name: /بطاطس/ })).toBeInTheDocument();
    // …but picking it can never satisfy min:2, so the gate stays shut.
    fireEvent.click(screen.getByRole("button", { name: /بطاطس/ }));
    expect(screen.getByTestId("combo-confirm")).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("an OPTIONAL group (min 0) whose options all died does not block the combo", () => {
    const optionalDead = combo([
      { id: "G-EXTRA", name: "إضافات", min: 0, max: 2, options: [opt("M-CHEESE", "جبن", false)] },
    ]);
    render(<ComboDialog open combo={optionalDead} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByTestId("combo-unsellable")).not.toBeInTheDocument();
    expect(screen.getByTestId("combo-confirm")).toBeEnabled();
  });
});

describe("activeOptions — the shared filter both the UI and the gate use", () => {
  it("keeps order and drops only the inactive entries", () => {
    const g = DRINKS_ONE_DEAD.groups[0];
    expect(activeOptions(g).map((o) => o.menuId)).toEqual(["M-PEPSI", "M-WATER"]);
  });
});
