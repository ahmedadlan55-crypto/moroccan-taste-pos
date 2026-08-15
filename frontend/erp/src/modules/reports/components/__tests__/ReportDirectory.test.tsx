import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Boxes, ReceiptText } from "lucide-react";
import { ReportDirectory, type ReportDirectoryGroup } from "../ReportDirectory";

const groups: ReportDirectoryGroup[] = [
  {
    id: "stock",
    title: "الرقابة على المخزون",
    icon: Boxes,
    items: [
      { id: "balance", title: "رصيد المخزون", to: "/reports/inventory/stock-balance", icon: Boxes },
      { id: "movement", title: "حركة المخزون", to: "/reports/inventory/movements", icon: ReceiptText },
    ],
  },
  {
    id: "finance",
    title: "الرقابة المحاسبية",
    icon: ReceiptText,
    items: [
      { id: "trial", title: "ميزان المراجعة", to: "/reports/financial/trial-balance", icon: ReceiptText },
    ],
  },
];

function renderDirectory(value: ReportDirectoryGroup[] = groups) {
  render(
    <MemoryRouter>
      <ReportDirectory groups={value} openLabel="فتح التقرير" emptyLabel="لا توجد تقارير متاحة" />
    </MemoryRouter>,
  );
}

describe("ReportDirectory", () => {
  it("renders grouped real routes with accessible actions", () => {
    renderDirectory();
    expect(screen.getByTestId("report-directory-grid")).toHaveClass("lg:grid-cols-2");
    expect(document.querySelectorAll("[data-report-group]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-report-item]")).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: /فتح التقرير/ })).toHaveLength(3);
    expect(document.querySelector("a a")).toBeNull();
  });

  it("is a name and a link — no note, no badge, no search box", () => {
    renderDirectory();
    // The owner banned explanatory copy in the catalogue: a row carries the
    // report's name and the link that opens it, and nothing else.
    expect(screen.queryByRole("searchbox")).toBeNull();
    const row = document.querySelector('[data-report-item="balance"]') as HTMLElement;
    expect(within(row).getByRole("link", { name: /فتح التقرير/ })).toHaveClass("min-h-11");
    expect(row.textContent).toBe("رصيد المخزونفتح التقرير");
  });

  it("shows the empty state rather than an empty grid", () => {
    renderDirectory([{ id: "stock", title: "الرقابة على المخزون", icon: Boxes, items: [] }]);
    expect(screen.getByText("لا توجد تقارير متاحة")).toBeInTheDocument();
    expect(screen.queryByTestId("report-directory-grid")).toBeNull();
  });
});
