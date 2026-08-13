import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Boxes, ReceiptText } from "lucide-react";
import { ReportDirectory } from "../ReportDirectory";

const groups = [
  {
    id: "stock",
    title: "الرقابة على المخزون",
    description: "الأرصدة والحركات",
    icon: Boxes,
    items: [
      { id: "balance", title: "رصيد المخزون", description: "الكميات الحالية", to: "/reports/inventory/stock-balance", icon: Boxes },
      { id: "movement", title: "حركة المخزون", description: "الوارد والمنصرف", to: "/reports/inventory/movements", icon: ReceiptText },
    ],
  },
  {
    id: "finance",
    title: "الرقابة المحاسبية",
    description: "المصالحة",
    icon: ReceiptText,
    items: [
      { id: "trial", title: "ميزان المراجعة", description: "الأرصدة والحركة", to: "/accounting/trial-balance", icon: ReceiptText },
    ],
  },
];

function renderDirectory() {
  render(
    <MemoryRouter>
      <ReportDirectory
        groups={groups}
        searchLabel="البحث في التقارير"
        searchPlaceholder="ابحث…"
        openLabel="فتح التقرير"
        countLabel={(count) => `${count} تقرير`}
        emptyLabel="لا توجد نتائج"
      />
    </MemoryRouter>,
  );
}

describe("ReportDirectory", () => {
  it("renders grouped real routes with accessible actions", () => {
    renderDirectory();
    expect(screen.getByTestId("report-directory-grid")).toHaveClass("xl:grid-cols-2");
    expect(document.querySelectorAll("[data-report-group]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-report-item]")).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: /فتح التقرير/ })).toHaveLength(3);
    expect(document.querySelector("a a")).toBeNull();
  });

  it("filters by report title or purpose without leaving empty families", () => {
    renderDirectory();
    fireEvent.change(screen.getByRole("searchbox", { name: "البحث في التقارير" }), { target: { value: "المراجعة" } });
    expect(document.querySelectorAll("[data-report-group]")).toHaveLength(1);
    expect(screen.getByText("ميزان المراجعة")).toBeInTheDocument();
    expect(screen.queryByText("رصيد المخزون")).not.toBeInTheDocument();
  });

  it("shows an empty result and keeps controls touch-sized", () => {
    renderDirectory();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "غير موجود" } });
    expect(screen.getByText("لا توجد نتائج")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "رصيد" } });
    const row = document.querySelector('[data-report-item="balance"]') as HTMLElement;
    expect(within(row).getByRole("link", { name: /فتح التقرير/ })).toHaveClass("min-h-11");
  });
});
