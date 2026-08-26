import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { apiClient } from "@/shared/api";
import { DataTable, type ColumnDef } from "@/shared/tables";

interface Row {
  id: string;
  name: string;
  amount: number;
}

const ROWS: Row[] = [
  { id: "1", name: "Beta", amount: 30 },
  { id: "2", name: "Alpha", amount: 10 },
  { id: "3", name: "Gamma", amount: 20 },
];

const COLUMNS: ColumnDef<Row>[] = [
  { id: "name", header: "الاسم", accessor: (r) => r.name, sortable: true },
  { id: "amount", header: "المبلغ", accessor: (r) => r.amount, numeric: true, sortable: true },
];

function firstDataCell(): string {
  // row[0] is the header row; row[1] is the first data row.
  const rows = screen.getAllByRole("row");
  return within(rows[1]).getAllByRole("cell")[0].textContent ?? "";
}

describe("DataTable", () => {
  it("renders all rows (client mode)", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} stackOnMobile={false} />);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("sorts by a column when its header is clicked", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} stackOnMobile={false} paginate={false} />);
    expect(firstDataCell()).toBe("Beta"); // input order
    fireEvent.click(screen.getByRole("button", { name: /الاسم/ }));
    expect(firstDataCell()).toBe("Alpha"); // ascending
    fireEvent.click(screen.getByRole("button", { name: /الاسم/ }));
    expect(firstDataCell()).toBe("Gamma"); // descending
  });

  it("filters rows via the global search box", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        searchable
        searchPlaceholder="بحث"
        stackOnMobile={false}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alpha" } });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
  });

  it("paginates client-side", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        initialPageSize={2}
        stackOnMobile={false}
      />,
    );
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("الصفحة التالية"));
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("fires the selection callback when the header checkbox is toggled", () => {
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        selectable
        onSelectionChange={onSelectionChange}
        stackOnMobile={false}
      />,
    );
    fireEvent.click(screen.getByLabelText("تحديد كل الصفوف"));
    expect(onSelectionChange).toHaveBeenCalledWith(["1", "2", "3"]);
  });

  it("fires the export callback with the current rows", () => {
    const onExport = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        exportFilename="rows.csv"
        onExport={onExport}
        stackOnMobile={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /تصدير/ }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport.mock.calls[0][0]).toHaveLength(3);
  });

  it("shows the empty state when there are no rows", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowId={(r) => r.id}
        emptyTitle="لا توجد سجلات"
        stackOnMobile={false}
      />,
    );
    expect(screen.getByText("لا توجد سجلات")).toBeInTheDocument();
  });

  it("omits mobileHidden columns from the compact mobile cards", () => {
    const compactColumns: ColumnDef<Row>[] = [
      COLUMNS[0],
      { ...COLUMNS[1], mobileHidden: true },
    ];
    const { container } = render(
      <DataTable columns={compactColumns} rows={[ROWS[0]]} getRowId={(r) => r.id} paginate={false} />,
    );
    const mobileList = container.querySelector("ul");
    expect(mobileList).not.toBeNull();
    expect(within(mobileList as HTMLElement).getByText("Beta")).toBeInTheDocument();
    expect(within(mobileList as HTMLElement).queryByText("المبلغ")).not.toBeInTheDocument();
    expect(within(mobileList as HTMLElement).queryByText("30")).not.toBeInTheDocument();
  });

  it("uses a real keyboard-focusable button for clickable mobile cards", () => {
    const onRowClick = vi.fn();
    const { container } = render(
      <DataTable
        columns={COLUMNS}
        rows={[ROWS[0]]}
        getRowId={(r) => r.id}
        mobileTitle={(row) => row.name}
        onRowClick={onRowClick}
        paginate={false}
      />,
    );
    const mobileList = container.querySelector("ul");
    const openButton = within(mobileList as HTMLElement).getByRole("button", { name: "Beta" });
    openButton.focus();
    fireEvent.keyDown(openButton, { key: "Enter" });
    fireEvent.click(openButton);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  // ── A4 additions ────────────────────────────────────────────────────────

  it("debounces the onStateChange search callback (immediate echo, deferred report)", () => {
    vi.useFakeTimers();
    try {
      const onStateChange = vi.fn();
      render(
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          getRowId={(r) => r.id}
          searchable
          searchPlaceholder="بحث"
          onStateChange={onStateChange}
          stackOnMobile={false}
        />,
      );
      // drop the initial mount report (search: "")
      onStateChange.mockClear();

      act(() => {
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alpha" } });
      });
      // the input echoes immediately …
      expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Alpha");
      // … but the downstream report has NOT fired with the new search yet
      expect(onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ search: "Alpha" }));

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ search: "Alpha" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits a requireCap column when the cap is absent and shows it when present", () => {
    const withSecret: ColumnDef<Row>[] = [
      ...COLUMNS,
      { id: "secret", header: "سري", accessor: (r) => r.name, requireCap: "secret.view" },
    ];
    const { rerender } = render(
      <DataTable
        columns={withSecret}
        rows={ROWS}
        getRowId={(r) => r.id}
        canColumn={() => false}
        stackOnMobile={false}
        paginate={false}
      />,
    );
    // header + cells absent when the cap is missing
    expect(screen.queryByText("سري")).not.toBeInTheDocument();

    rerender(
      <DataTable
        columns={withSecret}
        rows={ROWS}
        getRowId={(r) => r.id}
        canColumn={() => true}
        stackOnMobile={false}
        paginate={false}
      />,
    );
    expect(screen.getByText("سري")).toBeInTheDocument();
  });

  it("truncates an ellipsis column with a native title tooltip", () => {
    const longText = "قيمة نصية طويلة جدًا لا ينبغي أن تلتف إلى عدة أسطر في الجدول";
    const cols: ColumnDef<Row>[] = [
      { id: "desc", header: "الوصف", accessor: () => longText, ellipsis: true },
    ];
    render(
      <DataTable
        columns={cols}
        rows={[ROWS[0]]}
        getRowId={(r) => r.id}
        stackOnMobile={false}
        paginate={false}
      />,
    );
    const el = screen.getByTitle(longText);
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass("truncate");
  });

  it("defaults rows to a 52px comfortable density when virtualized", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        virtualize
        stackOnMobile={false}
        paginate={false}
      />,
    );
    const rows = screen.getAllByRole("row");
    // rows[0] = header; rows[1] = first data row (no top pad at scrollTop 0)
    expect((rows[1] as HTMLElement).style.height).toBe("52px");
  });

  it("virtualizes automatically once the rendered page exceeds 200 rows", () => {
    const many: Row[] = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      name: `row-${i}`,
      amount: i,
    }));
    const { container } = render(
      <DataTable
        columns={COLUMNS}
        rows={many}
        getRowId={(r) => r.id}
        paginate={false}
        stackOnMobile={false}
      />,
    );
    // a scroll viewport wraps the sticky-header table
    expect(container.querySelector(".overflow-y-auto")).not.toBeNull();
    // early rows render; far rows are windowed out of the DOM
    expect(screen.getByText("row-0")).toBeInTheDocument();
    expect(screen.queryByText("row-249")).not.toBeInTheDocument();
  });

  it("materializes every virtualized row before print and restores virtualization after", () => {
    const many: Row[] = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      name: `print-row-${i}`,
      amount: i,
    }));
    render(
      <DataTable
        columns={COLUMNS}
        rows={many}
        getRowId={(r) => r.id}
        paginate={false}
        stackOnMobile={false}
      />,
    );

    expect(screen.queryByText("print-row-249")).not.toBeInTheDocument();
    fireEvent(window, new Event("beforeprint"));
    expect(screen.getByText("print-row-249")).toBeInTheDocument();
    fireEvent(window, new Event("afterprint"));
    expect(screen.queryByText("print-row-249")).not.toBeInTheDocument();
  });

  it("renders the saved-views control when savedViewsModule is set (localStorage fallback)", async () => {
    // Simulate A2's endpoint not being reachable → the control still renders and
    // degrades to localStorage rather than hard-breaking.
    const getSpy = vi.spyOn(apiClient, "get").mockRejectedValue(new Error("endpoint not available"));
    try {
      render(
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          getRowId={(r) => r.id}
          savedViewsModule="test-module"
          stackOnMobile={false}
          paginate={false}
        />,
      );
      expect(await screen.findByText("طرق العرض")).toBeInTheDocument();
    } finally {
      getSpy.mockRestore();
    }
  });
});
