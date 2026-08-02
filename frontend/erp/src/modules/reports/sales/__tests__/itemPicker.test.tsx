// The item filter has to survive a real catalogue.
//
// The shared MultiSelectCombobox is documented for IN-MEMORY lists and mounts
// every matching option on every keystroke. The menu is the one lookup in the
// filter bar that runs to four figures and the one field people type into, so
// at 2,000 items that is 2,000 DOM nodes rebuilt per character.
//
// These pin the three properties that make it usable, by MEASURING them —
// counting mounted rows and counting filter passes — rather than asserting that
// a component with the right name is on screen.
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { ItemPicker } from "../components/ItemPicker";

const CATALOGUE = Array.from({ length: 2000 }, (_, i) => ({
  value: `M-${i}`,
  label: i === 7 ? "Zaatar Manakish" : `Item ${i}`,
}));

function renderPicker(values: string[] = [], onChange = vi.fn()) {
  render(
    <I18nProvider>
      <ItemPicker
        options={CATALOGUE}
        values={values}
        onChange={onChange}
        ariaLabel="الصنف"
        placeholder="كل الأصناف"
      />
    </I18nProvider>,
  );
  return { onChange };
}

async function openList() {
  fireEvent.click(screen.getByRole("button", { name: "الصنف" }));
  return screen.findByTestId("item-picker-list");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("a two-thousand-item catalogue", () => {
  it("mounts only the rows in the scroll window, not the catalogue", async () => {
    renderPicker();
    const list = await openList();
    const rows = within(list).getAllByRole("option");
    // 8 visible + 6 overscan each side, so well under 30 — and nowhere near
    // 2,000, which is the number this control exists to avoid.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(30);
  });

  it("the scrollbar still describes the WHOLE list — a short window is not a short list", async () => {
    renderPicker();
    const list = await openList();
    const spacer = list.firstElementChild as HTMLElement;
    // The spacer carries the full height (2000 rows × 40px); a virtualizer that
    // sized itself to the window would let the user believe the list ends.
    expect(spacer.style.height).toBe(`${2000 * 40}px`);
  });

  it("scrolling mounts a DIFFERENT window — the rows are real, not the first page twice", async () => {
    renderPicker();
    const list = await openList();
    const before = within(list).getAllByRole("option")[0].textContent;
    fireEvent.scroll(list, { target: { scrollTop: 40 * 500 } });
    await waitFor(() => {
      expect(within(list).getAllByRole("option")[0].textContent).not.toBe(before);
    });
    expect(within(list).getAllByRole("option")[0].textContent).toContain("Item 4");
  });

  it("carries NO images — an option row is a name, never a base64 payload", async () => {
    renderPicker();
    const list = await openList();
    expect(list.querySelectorAll("img")).toHaveLength(0);
    expect(list.innerHTML).not.toContain("data:image");
  });
});

describe("the search input", () => {
  it("is debounced: typing six characters filters ONCE, at the end", async () => {
    renderPicker();
    const list = await openList();
    const input = screen.getByRole("textbox", { name: "بحث في الأصناف" });

    for (const value of ["Z", "Za", "Zaa", "Zaat", "Zaata", "Zaatar"]) {
      fireEvent.change(input, { target: { value } });
    }
    // Before the debounce elapses the list still shows the UNFILTERED head —
    // proof that the intermediate keystrokes did not each run a filter pass.
    expect(within(list).getAllByRole("option")[0].textContent).toContain("Item 0");

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await waitFor(() => {
      const rows = within(list).getAllByRole("option");
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain("Zaatar Manakish");
    });
  });

  it("keeps the input responsive while the list lags behind it", async () => {
    renderPicker();
    await openList();
    const input = screen.getByRole("textbox", { name: "بحث في الأصناف" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Zaat" } });
    // The typed text is on screen immediately even though the list has not
    // re-filtered yet: the debounce must never make the field itself feel slow.
    expect(input.value).toBe("Zaat");
  });

  it("says so when nothing matches, instead of showing an empty box", async () => {
    renderPicker();
    const list = await openList();
    fireEvent.change(screen.getByRole("textbox", { name: "بحث في الأصناف" }), {
      target: { value: "nothing-like-this" },
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await waitFor(() => expect(within(list).queryAllByRole("option")).toHaveLength(0));
    expect(list.textContent).toContain("لا يوجد صنف مطابق");
  });
});

describe("selection", () => {
  it("toggles a value without closing the popover (it is a MULTI-select)", async () => {
    const onChange = vi.fn();
    renderPicker([], onChange);
    const list = await openList();
    fireEvent.click(within(list).getAllByRole("option")[0]);
    expect(onChange).toHaveBeenCalledWith(["M-0"]);
    expect(screen.getByTestId("item-picker-list")).toBeInTheDocument();
  });

  it("removes an already-selected value rather than adding it twice", async () => {
    const onChange = vi.fn();
    renderPicker(["M-0"], onChange);
    const list = await openList();
    fireEvent.click(within(list).getAllByRole("option")[0]);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("summarises a long selection as a count, so the trigger cannot grow unbounded", () => {
    renderPicker(["M-0", "M-1", "M-2", "M-3"]);
    expect(screen.getByRole("button", { name: "الصنف" }).textContent).toContain("4");
  });

  it("warns when the server's own row cap bit — a short list is not a complete one", async () => {
    renderPicker();
    await openList();
    // CATALOGUE is exactly the route's 2,000-row cap, so the note must show.
    expect(screen.getByText(/2,000/)).toBeInTheDocument();
  });
});
