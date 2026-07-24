import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { Heatmap, type HeatmapCell } from "@/shared/charts/Heatmap";

const ROWS = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
];
const COLS = [
  { key: "h09", label: "09" },
  { key: "h10", label: "10" },
];
const CELLS: HeatmapCell[] = [
  { row: "mon", col: "h09", value: 5 },
  { row: "mon", col: "h10", value: 20 },
  { row: "tue", col: "h09", value: 0 },
  // tue × h10 deliberately missing
];

describe("Heatmap", () => {
  it("renders a focusable button per row×col with an accessible value label", () => {
    render(<Heatmap rows={ROWS} cols={COLS} cells={CELLS} ariaLabel="Sales by day and hour" />);
    const grid = screen.getByRole("group", { name: "Sales by day and hour" });
    const buttons = within(grid).getAllByRole("button");
    expect(buttons).toHaveLength(4); // 2 rows × 2 cols
    expect(within(grid).getByRole("button", { name: "Monday × 09: 5" })).toBeInTheDocument();
    expect(within(grid).getByRole("button", { name: "Monday × 10: 20" })).toBeInTheDocument();
    // missing cell renders an em-dash placeholder
    expect(within(grid).getByRole("button", { name: "Tuesday × 10: —" })).toBeInTheDocument();
  });

  it("fires onCellClick with the cell entry (and not for empty cells)", () => {
    const onCellClick = vi.fn();
    render(
      <Heatmap rows={ROWS} cols={COLS} cells={CELLS} onCellClick={onCellClick} ariaLabel="Sales heatmap" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Monday × 10: 20" }));
    expect(onCellClick).toHaveBeenCalledWith({ row: "mon", col: "h10", value: 20 });

    fireEvent.click(screen.getByRole("button", { name: "Tuesday × 10: —" }));
    expect(onCellClick).toHaveBeenCalledTimes(1); // empty cell → no drill
  });

  it("applies the intensity tint to non-zero cells only (opacity fallback in jsdom)", () => {
    render(<Heatmap rows={ROWS} cols={COLS} cells={CELLS} ariaLabel="Tinted" />);
    const hot = screen.getByRole("button", { name: "Monday × 10: 20" });
    const cold = screen.getByRole("button", { name: "Tuesday × 09: 0" });
    // jsdom has no color-mix → the tint is an inner layer bound to --mt-chart-1
    const hotLayer = hot.querySelector('span[aria-hidden="true"]');
    expect(hotLayer).not.toBeNull();
    expect((hotLayer as HTMLElement).style.backgroundColor).toBe("var(--mt-chart-1)");
    // max value → strongest step (90%)
    expect((hotLayer as HTMLElement).style.opacity).toBe("0.9");
    // zero value → no tint layer at all
    expect(cold.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it("respects an explicit max ceiling", () => {
    render(<Heatmap rows={ROWS} cols={COLS} cells={CELLS} max={100} ariaLabel="Ceiling" />);
    const hot = screen.getByRole("button", { name: "Monday × 10: 20" });
    const layer = hot.querySelector('span[aria-hidden="true"]') as HTMLElement;
    // 20/100 → step 1 of 5 → weakest tint (12%)
    expect(layer.style.opacity).toBe("0.12");
  });

  it("uses a custom valueFormatter for both display and aria", () => {
    render(
      <Heatmap
        rows={ROWS}
        cols={COLS}
        cells={CELLS}
        valueFormatter={(v) => `${v} SAR`}
        ariaLabel="Formatted"
      />,
    );
    expect(screen.getByRole("button", { name: "Monday × 09: 5 SAR" })).toBeInTheDocument();
  });

  it("renders the accessible <details> table alternative when tableLabel is given", () => {
    render(
      <Heatmap
        rows={ROWS}
        cols={COLS}
        cells={CELLS}
        ariaLabel="Sales heatmap"
        tableLabel="Show as table"
        tableCaption="Sales by day and hour"
      />,
    );
    expect(screen.getByText("Show as table")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Sales by day and hour" });
    // row headers + values present in the table alternative
    expect(within(table).getByText("Monday")).toBeInTheDocument();
    expect(within(table).getByText("20")).toBeInTheDocument();
    expect(within(table).getByText("—")).toBeInTheDocument();
  });

  it("omits the table alternative without tableLabel", () => {
    render(<Heatmap rows={ROWS} cols={COLS} cells={CELLS} ariaLabel="No table" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
