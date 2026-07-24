import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MultiSelectCombobox, type MultiSelectOption } from "@/shared/ui/multi-select-combobox";

const OPTIONS: MultiSelectOption[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma", sublabel: "third" },
];

const LABELS = {
  placeholder: "Pick branches",
  searchPlaceholder: "Search options",
  empty: "Nothing found",
  selectAll: "Select all",
  clear: "Clear all",
  countLabel: (n: number) => `${n} selected`,
};

function renderBox(values: string[], onChange = vi.fn(), extra: Partial<Parameters<typeof MultiSelectCombobox>[0]> = {}) {
  const utils = render(
    <MultiSelectCombobox
      options={OPTIONS}
      values={values}
      onChange={onChange}
      ariaLabel="Branches"
      labels={LABELS}
      {...extra}
    />,
  );
  return { ...utils, onChange };
}

function openIt() {
  fireEvent.click(screen.getByRole("button", { name: "Branches" }));
}

describe("MultiSelectCombobox", () => {
  it("shows the placeholder when empty, joined labels when few, count when many", () => {
    const { rerender } = renderBox([]);
    const trigger = () => screen.getByRole("button", { name: "Branches" });
    expect(trigger()).toHaveTextContent("Pick branches");

    rerender(
      <MultiSelectCombobox options={OPTIONS} values={["a", "b"]} onChange={vi.fn()} ariaLabel="Branches" labels={LABELS} />,
    );
    expect(trigger()).toHaveTextContent("Alpha, Beta");

    rerender(
      <MultiSelectCombobox options={OPTIONS} values={["a", "b", "c"]} onChange={vi.fn()} ariaLabel="Branches" labels={LABELS} />,
    );
    expect(trigger()).toHaveTextContent("3 selected");
  });

  it("toggles an option on click without closing the popover", () => {
    const { onChange } = renderBox(["a"]);
    openIt();
    fireEvent.click(screen.getByRole("option", { name: /Beta/ }).querySelector("button") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);
    // still open (multi-select keeps the list up)
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("unselects a selected option on click", () => {
    const { onChange } = renderBox(["a", "b"]);
    openIt();
    fireEvent.click(screen.getByRole("option", { name: /Alpha/ }).querySelector("button") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("filters options via the search input", () => {
    renderBox([]);
    openIt();
    fireEvent.change(screen.getByPlaceholderText("Search options"), { target: { value: "gam" } });
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByText("Gamma")).toBeInTheDocument();
    expect(within(listbox).queryByText("Alpha")).not.toBeInTheDocument();
    expect(within(listbox).queryByText("Beta")).not.toBeInTheDocument();
  });

  it("shows the empty label when the search matches nothing", () => {
    renderBox([]);
    openIt();
    fireEvent.change(screen.getByPlaceholderText("Search options"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing found")).toBeInTheDocument();
  });

  it("select-all selects every (filtered) enabled option and toggles back off", () => {
    const first = renderBox([]);
    openIt();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(first.onChange).toHaveBeenCalledWith(["a", "b", "c"]);
    first.unmount();

    // when everything is already selected the same button DESELECTS the filtered set
    const second = renderBox(["a", "b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(second.onChange).toHaveBeenCalledWith([]);
  });

  it("clear empties the selection from both the popover and the trigger affordance", () => {
    const { onChange } = renderBox(["a", "c"]);
    openIt();
    // "Clear all" exists twice by design: the trigger X affordance and the
    // popover button. Scope to the popover (the listbox's container) first.
    const popover = screen.getByRole("listbox").parentElement as HTMLElement;
    fireEvent.click(within(popover).getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenCalledWith([]);
    onChange.mockClear();

    // the trigger X clears too
    const trigger = screen.getByRole("button", { name: "Branches" });
    fireEvent.click(within(trigger).getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("supports keyboard: ArrowDown + Enter toggles the active option", () => {
    const { onChange } = renderBox([]);
    const trigger = screen.getByRole("button", { name: "Branches" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // opens
    const search = screen.getByPlaceholderText("Search options");
    fireEvent.keyDown(search, { key: "ArrowDown" }); // active 0 → 1 (Beta)
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("marks selected rows with aria-selected on a multiselectable listbox", () => {
    renderBox(["b"]);
    openIt();
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute("aria-selected", "false");
  });
});
