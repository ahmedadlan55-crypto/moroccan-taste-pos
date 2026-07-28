/**
 * ItemMultiPicker — the behaviour the owner actually asked for, pinned.
 *
 * The complaint being fixed: in الجرد / النواقص nothing appears until you TYPE
 * (StocktakeDialog.tsx:449 / RequisitionsDialog.tsx:568 gate the list on
 * `items && query.trim()`). The first test here is therefore the load-bearing
 * one — FOCUS, zero keystrokes, full list.
 *
 * These tests deliberately assert against the DICTIONARY values (imported from
 * i18n/dictionaries/{ar,en}/itemMultiPicker.ts), never against inline Arabic
 * literals, so a translation edit cannot silently rot the suite — and so the
 * "no user-facing literal in the component" rule is checked, not assumed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { I18nProvider } from "@/i18n/I18nProvider";
import { format } from "@/i18n/interpolate";
import { itemMultiPicker as pickerAr } from "@/i18n/dictionaries/ar/itemMultiPicker";
import { itemMultiPicker as pickerEn } from "@/i18n/dictionaries/en/itemMultiPicker";
import {
  DEFAULT_MAX_VISIBLE,
  ItemMultiPicker,
  filterPickerItems,
  isPickerItemActive,
  normalizePickerText,
  pickerHaystack,
  type PickerItem,
} from "../ItemMultiPicker";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped like GET /api/inventory/items rows (lib/api.ts:400 InvItem) plus the
// optional nameEn/code/barcode the picker can also match on. INV-OLD is the
// inactive row that route happily returns (routes/inventory.js:1229-1233 has no
// `active` filter) — the picker must hide it by default.

const ITEMS: PickerItem[] = [
  { id: "INV-1", name: "أرز بسمتي", nameEn: "Basmati rice", code: "RICE-01", barcode: "6291000001", unit: "كيلو", category: "مواد جافة", active: 1 },
  { id: "INV-2", name: "زيت زيتون", nameEn: "Olive oil", code: "OIL-07", barcode: "6291000002", unit: "لتر", category: "زيوت", active: 1 },
  { id: "INV-3", name: "طماطم", nameEn: "Tomato", code: "VEG-11", barcode: "6291000003", unit: "كيلو", category: "خضار", active: true },
  { id: "INV-4", name: "دجاج مجمد", nameEn: "Frozen chicken", code: "MEA-02", barcode: "6291000004", unit: "كيلو", category: "لحوم", active: 1 },
  { id: "INV-OLD", name: "صنف موقوف", nameEn: "Retired item", code: "OLD-99", barcode: "6291000099", unit: "كيلو", category: "مواد جافة", active: 0 },
];

const ACTIVE_IDS = ["INV-1", "INV-2", "INV-3", "INV-4"];

const onChangeSpy = vi.fn();

function Harness({
  items = ITEMS,
  initial = [] as string[],
  ...rest
}: {
  items?: PickerItem[] | null;
  initial?: string[];
  includeInactive?: boolean;
  maxVisible?: number;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <ItemMultiPicker
      items={items}
      selectedIds={selected}
      onChange={(next) => {
        onChangeSpy(next);
        setSelected(next);
      }}
      {...rest}
    />
  );
}

function renderPicker(props: Parameters<typeof Harness>[0] = {}) {
  return render(
    <I18nProvider>
      <Harness {...props} />
    </I18nProvider>,
  );
}

function box(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

/** Real DOM focus (jsdom fires focusin, which is what React 18 binds onFocus to). */
async function focusBox(): Promise<HTMLInputElement> {
  const input = box();
  await act(async () => {
    input.focus();
  });
  return input;
}

function optionNames(): string[] {
  return screen.getAllByRole("option").map((li) => (li.textContent ?? "").trim());
}

/**
 * Click a row BY NAME inside the listbox. Scoped on purpose: once an item is
 * picked its name also appears on a chip, so an unscoped getByText would match
 * two nodes.
 */
function clickOption(name: string) {
  fireEvent.click(within(screen.getByRole("listbox")).getByText(name));
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  onChangeSpy.mockClear();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The actual complaint: open with ZERO typing
// ═══════════════════════════════════════════════════════════════════════════

describe("opens on focus with no typing at all", () => {
  it("shows the FULL item list on focus, with an empty query", async () => {
    renderPicker();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box()).toHaveAttribute("aria-expanded", "false");

    const input = await focusBox();

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(""); // ← nothing was typed
    expect(input).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(within(listbox).getAllByRole("option")).toHaveLength(ACTIVE_IDS.length);
    for (const name of ["أرز بسمتي", "زيت زيتون", "طماطم", "دجاج مجمد"]) {
      expect(within(listbox).getByText(name)).toBeInTheDocument();
    }
  });

  it("a tap (click) opens it too, and a second tap keeps it open", async () => {
    renderPicker();
    const input = box();

    fireEvent.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("ArrowDown opens it from closed without moving the selection", async () => {
    renderPicker();
    const input = box();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it("hides inactive rows by default and shows them on request", async () => {
    const { unmount } = renderPicker();
    await focusBox();
    expect(optionNames().some((n) => n.includes("صنف موقوف"))).toBe(false);
    unmount();

    renderPicker({ includeInactive: true });
    await focusBox();
    expect(screen.getAllByRole("option")).toHaveLength(ITEMS.length);
    expect(optionNames().some((n) => n.includes("صنف موقوف"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Filtering
// ═══════════════════════════════════════════════════════════════════════════

describe("typing filters the open list", () => {
  it.each([
    ["arabic name, hamza folded", "ارز", "أرز بسمتي"],
    ["english name", "olive", "زيت زيتون"],
    ["code", "MEA-02", "دجاج مجمد"],
    ["barcode", "6291000003", "طماطم"],
    ["id", "INV-2", "زيت زيتون"],
    ["multi-token, any order", "rice basmati", "أرز بسمتي"],
  ])("matches on %s", async (_label, query, expected) => {
    renderPicker();
    const input = await focusBox();

    type(input, query);

    const names = optionNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(expected);
  });

  it("shows the no-results string when nothing matches, and the list stays open", async () => {
    renderPicker();
    const input = await focusBox();

    type(input, "zzzzz");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(pickerAr.list.noResults)).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("clearing the query restores the whole list", async () => {
    renderPicker();
    const input = await focusBox();

    type(input, "olive");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    type(input, "");
    expect(screen.getAllByRole("option")).toHaveLength(ACTIVE_IDS.length);
  });

  it("renders the empty-list string when the caller has no items", async () => {
    renderPicker({ items: [] });
    await focusBox();
    expect(screen.getByText(pickerAr.list.empty)).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Multi-select + chips + bulk actions
// ═══════════════════════════════════════════════════════════════════════════

describe("multi-select", () => {
  it("ticks several items in one open session and reports every id", async () => {
    renderPicker();
    await focusBox();

    clickOption("أرز بسمتي");
    clickOption("طماطم");
    clickOption("دجاج مجمد");

    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-1", "INV-3", "INV-4"]);
    expect(screen.getByRole("listbox")).toBeInTheDocument(); // stays open

    const selected = screen
      .getAllByRole("option")
      .filter((li) => li.getAttribute("aria-selected") === "true")
      .map((li) => (li.textContent ?? "").trim());
    expect(selected).toHaveLength(3);
    expect(screen.getByText(format(pickerAr.selectedCount, { count: 3 }))).toBeInTheDocument();
  });

  it("clicking a picked row un-picks it (the row never disappears)", async () => {
    renderPicker();
    await focusBox();

    clickOption("زيت زيتون");
    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-2"]);

    clickOption("زيت زيتون");
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
    expect(within(screen.getByRole("listbox")).getByText("زيت زيتون")).toBeInTheDocument();
  });

  it("the aria-live count reflects the selection", async () => {
    renderPicker({ initial: ["INV-1", "INV-2"] });

    const count = screen.getByText(format(pickerAr.selectedCount, { count: 2 }));
    expect(count).toHaveAttribute("aria-live", "polite");
  });
});

describe("chips", () => {
  it("renders one removable chip per picked item, in pick order", () => {
    renderPicker({ initial: ["INV-3", "INV-1"] });

    const chipList = screen.getByRole("list", { name: pickerAr.chips.ariaLabel });
    const chips = within(chipList).getAllByRole("button");
    expect(chips.map((b) => b.getAttribute("aria-label"))).toEqual([
      format(pickerAr.chips.removeAria, { name: "طماطم" }),
      format(pickerAr.chips.removeAria, { name: "أرز بسمتي" }),
    ]);
  });

  it("clicking a chip removes exactly that item", () => {
    renderPicker({ initial: ["INV-1", "INV-2", "INV-3"] });

    fireEvent.click(
      screen.getByLabelText(format(pickerAr.chips.removeAria, { name: "زيت زيتون" })),
    );

    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-1", "INV-3"]);
    expect(screen.getByText(format(pickerAr.selectedCount, { count: 2 }))).toBeInTheDocument();
  });

  it("shows no chip strip at all when nothing is picked", () => {
    renderPicker();
    expect(screen.queryByRole("list", { name: pickerAr.chips.ariaLabel })).toBeNull();
  });
});

describe("bulk actions", () => {
  it("'select all shown' adds only the CURRENTLY FILTERED rows", async () => {
    renderPicker();
    const input = await focusBox();

    type(input, "o"); // Olive oil / Tomato / Frozen chicken — not the rice
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: pickerAr.actions.selectAllShown }));

    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-2", "INV-3", "INV-4"]);
    expect(screen.getByText(format(pickerAr.selectedCount, { count: 3 }))).toBeInTheDocument();
  });

  it("'select all shown' does not duplicate what is already picked", async () => {
    renderPicker({ initial: ["INV-2"] });
    await focusBox();

    fireEvent.click(screen.getByRole("button", { name: pickerAr.actions.selectAllShown }));

    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-2", "INV-1", "INV-3", "INV-4"]);
  });

  it("'clear selection' empties it and is disabled when there is nothing to clear", async () => {
    renderPicker({ initial: ["INV-1", "INV-2"] });

    const clear = screen.getByRole("button", { name: pickerAr.actions.clearAll });
    expect(clear).toBeEnabled();

    fireEvent.click(clear);
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("button", { name: pickerAr.actions.clearAll })).toBeDisabled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Keyboard
// ═══════════════════════════════════════════════════════════════════════════

describe("keyboard navigation", () => {
  it("ArrowDown/ArrowUp move the active option and wrap around", async () => {
    renderPicker();
    const input = await focusBox();

    const ids = screen.getAllByRole("option").map((li) => li.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(ids[0]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(ids[1]);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(ids[ids.length - 1]);
  });

  it("Enter toggles the active option without closing the list", async () => {
    renderPicker();
    const input = await focusBox();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-2"]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChangeSpy).toHaveBeenLastCalledWith([]);
  });

  it("Space toggles while the box is EMPTY, but types a space mid-query", async () => {
    renderPicker();
    const input = await focusBox();

    fireEvent.keyDown(input, { key: " " });
    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-1"]);

    onChangeSpy.mockClear();
    type(input, "olive");
    fireEvent.keyDown(input, { key: " " });
    expect(onChangeSpy).not.toHaveBeenCalled(); // the space belongs to the query
  });

  it("Backspace on an empty box removes the LAST chip; with a query it does not", async () => {
    renderPicker({ initial: ["INV-1", "INV-2", "INV-3"] });
    const input = await focusBox();

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChangeSpy).toHaveBeenLastCalledWith(["INV-1", "INV-2"]);

    onChangeSpy.mockClear();
    type(input, "olive");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it("Escape closes the list and is NOT allowed to reach the dialog; once closed it is", async () => {
    const documentEscape = vi.fn();
    document.addEventListener("keydown", documentEscape);
    try {
      renderPicker();
      const input = await focusBox();
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(documentEscape).not.toHaveBeenCalled(); // Dialog.tsx:38 must not fire

      fireEvent.keyDown(input, { key: "Escape" });
      expect(documentEscape).toHaveBeenCalledTimes(1); // now the dialog may close
    } finally {
      document.removeEventListener("keydown", documentEscape);
    }
  });

  it("closes on an outside mousedown", async () => {
    renderPicker();
    await focusBox();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Scale cap, loading, touch + a11y shape
// ═══════════════════════════════════════════════════════════════════════════

describe("render cap", () => {
  it("announces the cap instead of silently truncating", async () => {
    renderPicker({ maxVisible: 2 });
    await focusBox();

    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(
      screen.getByText(format(pickerAr.list.showingOf, { shown: 2, total: 4 })),
    ).toBeInTheDocument();
  });

  it("shows no cap notice when everything fits", async () => {
    renderPicker();
    await focusBox();
    expect(screen.queryByText(/يُعرض/)).toBeNull();
    expect(DEFAULT_MAX_VISIBLE).toBe(300);
  });
});

describe("loading and disabled", () => {
  it("items === null disables the box, blocks opening, and announces loading", async () => {
    renderPicker({ items: null });

    const input = box();
    expect(input).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(pickerAr.list.loading);

    fireEvent.click(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("disabled blocks the bulk actions", () => {
    renderPicker({ initial: ["INV-1"], disabled: true });
    expect(screen.getByRole("button", { name: pickerAr.actions.selectAllShown })).toBeDisabled();
    expect(screen.getByRole("button", { name: pickerAr.actions.clearAll })).toBeDisabled();
  });
});

describe("touch + a11y contract", () => {
  it("wires the combobox/listbox relationship", async () => {
    renderPicker();
    const input = await focusBox();
    const listbox = screen.getByRole("listbox");

    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-label", pickerAr.search.ariaLabel);
    expect(input).toHaveAttribute("placeholder", pickerAr.search.placeholder);
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    expect(listbox).toHaveAttribute("aria-label", pickerAr.list.ariaLabel);

    for (const option of within(listbox).getAllByRole("option")) {
      expect(option).toHaveAttribute("aria-selected");
    }
  });

  it("every row is a ≥44px touch target and the list scrolls inside itself", async () => {
    renderPicker({ initial: ["INV-1"] });
    const input = await focusBox();
    const listbox = screen.getByRole("listbox");

    expect(input.className).toContain("min-h-11");
    for (const option of within(listbox).getAllByRole("option")) {
      expect(option.className).toContain("min-h-11");
    }
    const chip = screen.getByLabelText(format(pickerAr.chips.removeAria, { name: "أرز بسمتي" }));
    expect(chip.className).toContain("min-h-11");

    // The list owns its own scroll…
    expect(listbox.className).toContain("overflow-y-auto");
    expect(listbox.className).toMatch(/max-h-/);
    // …and the popover is absolutely positioned, so opening it cannot reflow
    // the host dialog's body.
    expect(listbox.parentElement?.className).toContain("absolute");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("pure helpers", () => {
  it("normalizePickerText folds the Arabic orthography the legacy search folds", () => {
    expect(normalizePickerText("أَرُزّ")).toBe("ارز");
    expect(normalizePickerText("طماطة")).toBe("طماطه");
    expect(normalizePickerText("مصطفى")).toBe("مصطفي");
    expect(normalizePickerText("RICE")).toBe("rice");
  });

  it("isPickerItemActive treats a missing flag as active", () => {
    expect(isPickerItemActive({ id: "a", name: "a" })).toBe(true);
    expect(isPickerItemActive({ id: "a", name: "a", active: 1 })).toBe(true);
    expect(isPickerItemActive({ id: "a", name: "a", active: true })).toBe(true);
    expect(isPickerItemActive({ id: "a", name: "a", active: 0 })).toBe(false);
    expect(isPickerItemActive({ id: "a", name: "a", active: false })).toBe(false);
  });

  it("pickerHaystack covers both names, code, barcode, id and category", () => {
    const hay = pickerHaystack(ITEMS[0]);
    for (const needle of ["ارز", "basmati", "rice-01", "6291000001", "inv-1", "مواد"]) {
      expect(hay).toContain(needle);
    }
  });

  it("filterPickerItems returns the WHOLE active pool for an empty query", () => {
    expect(filterPickerItems(ITEMS, "").map((i) => i.id)).toEqual(ACTIVE_IDS);
    expect(filterPickerItems(ITEMS, "   ").map((i) => i.id)).toEqual(ACTIVE_IDS);
    expect(filterPickerItems(ITEMS, "", true)).toHaveLength(ITEMS.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. i18n — nothing user-facing outside the dictionaries
// ═══════════════════════════════════════════════════════════════════════════

type NsNode = string | { [key: string]: NsNode };

function flattenNs(node: NsNode, path: string, out: Array<[string, string]>) {
  if (typeof node === "string") {
    out.push([path, node]);
    return;
  }
  for (const [k, v] of Object.entries(node)) flattenNs(v, path ? `${path}.${k}` : k, out);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "إزالة {name}" → /^إزالة [\s\S]+$/ */
function templateRe(tpl: string): RegExp {
  return new RegExp(`^${escapeRe(tpl).replace(/\\\{\w+\\\}/g, "[\\s\\S]+")}$`);
}

const AR_LEAVES: Array<[string, string]> = [];
flattenNs(pickerAr as unknown as NsNode, "", AR_LEAVES);
const EN_LEAVES: Array<[string, string]> = [];
flattenNs(pickerEn as unknown as NsNode, "", EN_LEAVES);

const AR_PATTERNS = AR_LEAVES.map(([, v]) => templateRe(v));

/** Everything the FIXTURES legitimately put on screen (item data, not copy). */
const FIXTURE_STRINGS = new Set<string>(
  ITEMS.flatMap((i) => [i.id, i.name, i.nameEn, i.code, i.barcode, i.unit, i.category])
    .filter((v): v is string => typeof v === "string"),
);

function isAllowedRenderedString(raw: string): boolean {
  const s = raw.trim();
  if (s === "") return true;
  if (!/[\p{L}]/u.test(s)) return true; // digits / punctuation only
  if (FIXTURE_STRINGS.has(s)) return true;
  return AR_PATTERNS.some((re) => re.test(s));
}

function collectRenderedStrings(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    out.push(node.textContent ?? "");
    node = walker.nextNode();
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of ["aria-label", "placeholder", "title", "alt"]) {
      const v = el.getAttribute(attr);
      if (v !== null) out.push(v);
    }
  }
  return out;
}

describe("i18n", () => {
  it("ar and en namespaces have identical key sets and identical leaf types", () => {
    expect(AR_LEAVES.map(([p]) => p).sort()).toEqual(EN_LEAVES.map(([p]) => p).sort());
    // All leaves are strings — a function leaf would be called with a plain
    // NUMBER by makeT (i18n/makeT.ts:52-72), so multi-variable copy here MUST
    // stay a {placeholder} template.
    for (const [, v] of [...AR_LEAVES, ...EN_LEAVES]) expect(typeof v).toBe("string");
    expect(AR_LEAVES.length).toBeGreaterThan(0);
  });

  it("both languages use the same {placeholder} tokens in every template", () => {
    const tokensOf = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const enByPath = new Map(EN_LEAVES);
    for (const [path, arVal] of AR_LEAVES) {
      expect(tokensOf(arVal), `token mismatch at ${path}`).toEqual(tokensOf(enByPath.get(path) ?? ""));
    }
  });

  it("renders NOTHING user-facing that is not a dictionary string or fixture data", async () => {
    const { container } = renderPicker({ initial: ["INV-1"], maxVisible: 2 });
    await focusBox();

    const offenders = collectRenderedStrings(container).filter((s) => !isAllowedRenderedString(s));
    expect(offenders).toEqual([]);

    // …and again in the no-results / empty states, which take other branches.
    type(box(), "zzzzz");
    expect(collectRenderedStrings(container).filter((s) => !isAllowedRenderedString(s))).toEqual([]);
  });

  it("switches to English copy and English item names when the UI is English", async () => {
    localStorage.setItem("pos_lang", "en");
    renderPicker();

    const input = box();
    expect(input).toHaveAttribute("placeholder", pickerEn.search.placeholder);
    expect(input).toHaveAttribute("aria-label", pickerEn.search.ariaLabel);

    await focusBox();
    expect(screen.getByText("Basmati rice")).toBeInTheDocument();
    expect(screen.queryByText("أرز بسمتي")).toBeNull();
    expect(screen.getByRole("button", { name: pickerEn.actions.selectAllShown })).toBeInTheDocument();
  });

  it("has no hardcoded aria-label / placeholder / title literal in the source", () => {
    // vitest's cwd is frontend/pos (where vite.config.ts lives), including
    // under `npm --prefix frontend/pos run test` from the repo root.
    const src = readFileSync(
      path.resolve(process.cwd(), "src/components/ItemMultiPicker.tsx"),
      "utf8",
    );
    expect(src).toContain("export function ItemMultiPicker"); // guards the path itself
    const hardcoded = src.match(/\b(aria-label|placeholder|title|alt)\s*=\s*["'][^"']*[\p{L}][^"']*["']/gu);
    expect(hardcoded).toBeNull();
  });
});
