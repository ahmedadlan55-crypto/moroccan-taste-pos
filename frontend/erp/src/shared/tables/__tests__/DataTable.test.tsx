import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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
});
