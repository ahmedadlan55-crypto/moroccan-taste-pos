import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { DataTable, type ColumnDef } from "@/shared/tables";

interface Row {
  id: string;
  name: string;
  code: string;
  amount: number;
}

const ROWS: Row[] = [
  { id: "1", name: "Beta", code: "B-1", amount: -5 },
  { id: "2", name: "Alpha", code: "A-1", amount: 150 },
  { id: "3", name: "Gamma", code: "G-1", amount: 50 },
];

const PLAIN_COLUMNS: ColumnDef<Row>[] = [
  { id: "name", header: "الاسم", accessor: (r) => r.name },
  { id: "code", header: "الرمز", accessor: (r) => r.code },
  { id: "amount", header: "المبلغ", accessor: (r) => r.amount, numeric: true },
];

function getDataRows(): HTMLElement[] {
  // rows[0] is the header row.
  return screen.getAllByRole("row").slice(1) as HTMLElement[];
}

describe("DataTable pinStart", () => {
  it("applies sticky positioning with cumulative logical offsets to th and td", () => {
    const columns: ColumnDef<Row>[] = [
      { ...PLAIN_COLUMNS[0], pinStart: true, width: 120 },
      { ...PLAIN_COLUMNS[1], pinStart: true, width: 100 },
      PLAIN_COLUMNS[2],
    ];
    render(
      <DataTable columns={columns} rows={ROWS} getRowId={(r) => r.id} stackOnMobile={false} paginate={false} />,
    );

    // jsdom's CSSOM may serialize "0px" as "0" — accept both spellings.
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0].style.position).toBe("sticky");
    expect(headers[0].style.insetInlineStart).toMatch(/^0(px)?$/);
    expect(headers[1].style.position).toBe("sticky");
    expect(headers[1].style.insetInlineStart).toMatch(/^120px$/); // cumulative: after the 120px pin
    expect(headers[2].style.position).not.toBe("sticky");

    const cells = within(getDataRows()[0]).getAllByRole("cell");
    expect(cells[0].style.position).toBe("sticky");
    expect(cells[0].style.insetInlineStart).toMatch(/^0(px)?$/);
    expect(cells[1].style.position).toBe("sticky");
    expect(cells[1].style.insetInlineStart).toMatch(/^120px$/);
    expect(cells[2].style.position).not.toBe("sticky");

    // pinned cells carry the end-side separator + opaque background classes
    expect(cells[0].className).toContain("border-e");
    expect(cells[0].className).toContain("bg-white");
    expect(headers[0].className).toContain("border-e");
    expect(cells[2].className).not.toContain("border-e");
  });

  it("falls back to the default 120px width for a pinned column without a numeric width", () => {
    const columns: ColumnDef<Row>[] = [
      { ...PLAIN_COLUMNS[0], pinStart: true }, // no width → 120 default
      { ...PLAIN_COLUMNS[1], pinStart: true, width: 80 },
      PLAIN_COLUMNS[2],
    ];
    render(
      <DataTable columns={columns} rows={ROWS} getRowId={(r) => r.id} stackOnMobile={false} paginate={false} />,
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0].style.width).toBe("120px");
    expect(headers[1].style.insetInlineStart).toBe("120px");
  });
});

describe("DataTable cellTone", () => {
  it("maps per-row tones to token classes and leaves undefined rows plain", () => {
    const columns: ColumnDef<Row>[] = [
      PLAIN_COLUMNS[0],
      PLAIN_COLUMNS[1],
      {
        ...PLAIN_COLUMNS[2],
        cellTone: (r) => (r.amount < 0 ? "negative" : r.amount > 100 ? "positive" : undefined),
      },
    ];
    render(
      <DataTable columns={columns} rows={ROWS} getRowId={(r) => r.id} stackOnMobile={false} paginate={false} />,
    );
    const rows = getDataRows();
    const amountCell = (i: number) => within(rows[i]).getAllByRole("cell")[2];

    expect(amountCell(0).className).toContain("text-rose-700"); // -5 → negative
    expect(amountCell(0).className).toContain("bg-rose-50");
    expect(amountCell(1).className).toContain("text-emerald-700"); // 150 → positive
    expect(amountCell(1).className).toContain("bg-emerald-50");
    expect(amountCell(2).className).not.toContain("text-rose-700"); // 50 → plain
    expect(amountCell(2).className).not.toContain("text-emerald-700");
    expect(amountCell(2).className).not.toContain("bg-amber-50");
  });

  it("supports the warning tone", () => {
    const columns: ColumnDef<Row>[] = [
      PLAIN_COLUMNS[0],
      { ...PLAIN_COLUMNS[2], cellTone: () => "warning" },
    ];
    render(
      <DataTable columns={columns} rows={[ROWS[0]]} getRowId={(r) => r.id} stackOnMobile={false} paginate={false} />,
    );
    const cell = within(getDataRows()[0]).getAllByRole("cell")[1];
    expect(cell.className).toContain("bg-amber-50");
    expect(cell.className).toContain("text-amber-700");
  });
});

describe("DataTable without pinStart/cellTone (control — zero behavior change)", () => {
  it("renders no sticky styles and no tone classes anywhere", () => {
    render(
      <DataTable columns={PLAIN_COLUMNS} rows={ROWS} getRowId={(r) => r.id} stackOnMobile={false} paginate={false} />,
    );

    for (const th of screen.getAllByRole("columnheader")) {
      expect(th.style.position).not.toBe("sticky");
      // no width and no pin → the style attribute is absent entirely, as before
      expect(th.getAttribute("style")).toBeNull();
      expect(th.className).not.toContain("border-e");
    }
    for (const row of getDataRows()) {
      for (const cell of within(row).getAllByRole("cell")) {
        expect(cell.style.position).not.toBe("sticky");
        expect(cell.getAttribute("style")).toBeNull();
        expect(cell.className).not.toContain("border-e");
        expect(cell.className).not.toContain("bg-emerald-50");
        expect(cell.className).not.toContain("bg-rose-50");
        expect(cell.className).not.toContain("bg-amber-50");
      }
    }
  });

  it("keeps the exact pre-existing cell class list (no leaked additions)", () => {
    render(
      <DataTable
        columns={[{ id: "name", header: "الاسم", accessor: (r: Row) => r.name }]}
        rows={[ROWS[0]]}
        getRowId={(r) => r.id}
        stackOnMobile={false}
        paginate={false}
      />,
    );
    const cell = within(getDataRows()[0]).getAllByRole("cell")[0];
    expect(cell.className).toBe("px-3 py-3.5 align-middle text-slate-700 text-start");
  });
});
