// Sales Analytics Hub — PivotTable rendering: subtotal rows, the expand/
// collapse expander, missing-value masking ("—"), and the mobile card layout.
// Rendered WITHOUT an I18nProvider on purpose — PivotTable uses the
// never-throwing useTx (Arabic fallback), like every shared table surface.
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PivotTable, type PivotMeasure } from "../components/PivotTable";
import { pivotPathKey, type PivotSourceRow } from "../lib/pivot";
import { formatNumber } from "@/shared/lib";

const ROWS: PivotSourceRow[] = [
  { keys: ["b1", "i1"], labels: ["فرع الرياض", "شاورما"], values: { net: 100, qty: 2 } },
  { keys: ["b1", "i2"], labels: ["فرع الرياض", "برجر"], values: { net: 50, qty: 1 } },
  { keys: ["b2", "i1"], labels: ["فرع جدة", "شاورما"], values: { net: 30, qty: null } },
];

const MEASURES: PivotMeasure[] = [
  { id: "net", label: "الصافي", format: (v) => formatNumber(v) },
  { id: "qty", label: "الكمية", format: (v) => formatNumber(v) },
];

function renderTable(expanded: Set<string>, onToggle = vi.fn()) {
  const utils = render(
    <PivotTable
      rows={ROWS}
      rowDims={["branch", "menu_item"]}
      rowDimLabels={["الفرع", "الصنف"]}
      measures={MEASURES}
      expanded={expanded}
      onToggle={onToggle}
    />,
  );
  return { ...utils, onToggle };
}

afterEach(cleanup);

describe("PivotTable — desktop", () => {
  it("renders collapsed group rows with their subtotal values", () => {
    renderTable(new Set());
    expect(screen.getByTestId("pivot-table")).toBeInTheDocument();
    expect(screen.getByText("فرع الرياض")).toBeInTheDocument();
    expect(screen.getByText("فرع جدة")).toBeInTheDocument();
    // subtotal sums: 100+50=150 / 2+1=3 — and NO leaf rows yet
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("شاورما")).not.toBeInTheDocument();
    // group rows are marked
    expect(document.querySelectorAll("tr[data-subtotal]")).toHaveLength(2);
  });

  it("masks a null subtotal as — (never 0)", () => {
    renderTable(new Set());
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("expander toggles: aria-expanded + onToggle(groupKey)", () => {
    const { onToggle } = renderTable(new Set());
    const expanders = screen.getAllByRole("button", { name: "توسيع المجموعة" });
    expect(expanders).toHaveLength(2);
    expect(expanders[0]).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expanders[0]);
    expect(onToggle).toHaveBeenCalledWith(pivotPathKey(["b1"]));
  });

  it("renders leaf rows once the group is expanded", () => {
    renderTable(new Set([pivotPathKey(["b1"])]));
    expect(screen.getByText("شاورما")).toBeInTheDocument();
    expect(screen.getByText("برجر")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "طي المجموعة" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("PivotTable — mobile stacked cards", () => {
  it("switches to cards below the md breakpoint", () => {
    // useIsMobile → useMediaQuery("(max-width: 767px)") — force a match.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      renderTable(new Set());
      expect(screen.getByTestId("pivot-cards")).toBeInTheDocument();
      expect(screen.queryByTestId("pivot-table")).not.toBeInTheDocument();
      // cards show the first-dim label + the measures
      expect(screen.getByText("فرع الرياض")).toBeInTheDocument();
      expect(screen.getAllByText("الصافي").length).toBeGreaterThan(0);
    } finally {
      window.matchMedia = original;
    }
  });
});
