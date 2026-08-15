// StatementTable — the shape DataTable cannot express.
//
// The assertions that matter here are accounting rules, not rendering details:
// the footer must be the SERVER's total, and a collapsed branch must never fall
// out of the printed or exported copy. Both of those have already been real
// defects in this repo (TrialBalance.tsx:135-142 records removing a client-side
// footer sum), which is why they are pinned in the shared renderer rather than
// re-argued on each new statement.
import { cleanup, render, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Num } from "@/shared/ui";
import {
  StatementTable,
  statementCsv,
  visibleStatementRows,
  type StatementColumn,
  type StatementRowBase,
} from "../StatementTable";

interface Row extends StatementRowBase {
  current: number;
  prior: number;
}

/**
 *   1000 Assets                 (parent)
 *     1100 Current assets       (child, has children)
 *       1101 Cash               (grandchild)
 *       1102 Bank               (grandchild)
 *     Total current assets      (subtotal)
 */
const ROWS: Row[] = [
  { id: "1000", parentId: null, depth: 0, label: "الأصول", labelText: "الأصول", hasChildren: true, current: 500, prior: 400 },
  { id: "1100", parentId: "1000", depth: 1, label: "الأصول المتداولة", labelText: "الأصول المتداولة", hasChildren: true, current: 300, prior: 250 },
  { id: "1101", parentId: "1100", depth: 2, label: "الصندوق", labelText: "الصندوق", current: 100, prior: 90 },
  { id: "1102", parentId: "1100", depth: 2, label: "البنك", labelText: "البنك", current: 200, prior: 160 },
  { id: "st-1100", parentId: "1000", depth: 1, label: "إجمالي الأصول المتداولة", labelText: "إجمالي الأصول المتداولة", kind: "subtotal", current: 300, prior: 250 },
];

const COLUMNS: Array<StatementColumn<Row>> = [
  {
    id: "current",
    header: "مدين",
    groupId: "cur",
    align: "end",
    render: (r) => <Num value={r.current} />,
    csv: (r) => r.current,
  },
  {
    id: "prior",
    header: "مدين",
    groupId: "prev",
    align: "end",
    render: (r) => <Num value={r.prior} />,
    csv: (r) => r.prior,
  },
];

const GROUPS = [
  { id: "cur", header: "الفترة الحالية" },
  { id: "prev", header: "الفترة المقارنة" },
];

function renderTable(props: Partial<React.ComponentProps<typeof StatementTable<Row>>> = {}) {
  return render(
    <StatementTable<Row>
      rows={ROWS}
      columns={COLUMNS}
      groups={GROUPS}
      labelHeader="الحساب"
      leadHeader="الرمز"
      renderLead={(r) => <code>{r.id}</code>}
      expandLabel="توسيع"
      collapseLabel="طي"
      {...props}
    />,
  );
}

function row(id: string): HTMLElement {
  const el = document.querySelector(`[data-statement-row="${id}"]`);
  if (!el) throw new Error(`row ${id} is not in the document at all`);
  return el as HTMLElement;
}

afterEach(cleanup);

describe("account hierarchy", () => {
  it("indents each level by its depth, so the tree is readable on paper", () => {
    renderTable();
    const cellAt = (id: string) => row(id).querySelectorAll("td")[1] as HTMLElement;
    expect(cellAt("1000").style.paddingInlineStart).toBe("12px");
    expect(cellAt("1100").style.paddingInlineStart).toBe("34px");
    expect(cellAt("1101").style.paddingInlineStart).toBe("56px");
  });

  it("records the depth on the row, so a CSS or export rule can key off it", () => {
    renderTable();
    expect(row("1101").getAttribute("data-statement-depth")).toBe("2");
  });
});

describe("subtotals and the bottom line", () => {
  it("marks a subtotal row as one, in place among the lines it sums", () => {
    renderTable();
    expect(row("st-1100").getAttribute("data-statement-kind")).toBe("subtotal");
    expect(row("1101").getAttribute("data-statement-kind")).toBe("line");
    // Order matters: a subtotal after the lines it sums, not at the end.
    const ids = Array.from(document.querySelectorAll("[data-statement-row]")).map((e) =>
      e.getAttribute("data-statement-row"),
    );
    expect(ids.indexOf("st-1100")).toBeGreaterThan(ids.indexOf("1102"));
  });

  it("puts the bottom line in a real <tfoot>, so it repeats on every printed sheet", () => {
    renderTable({ totals: { label: "الإجمالي", values: { current: <Num value={9999} strong />, prior: <Num value={8888} strong /> } } });
    const tfoot = document.querySelector("tfoot");
    expect(tfoot, "no tfoot means no repeating total on a multi-page statement").not.toBeNull();
    expect(within(tfoot as HTMLElement).getByText("الإجمالي")).toBeTruthy();
  });

  it("renders the SERVER's total verbatim — it never sums the visible rows", () => {
    // The rows on screen add up to 500/400 at the root. The server says 9,999 —
    // because its total comes from a tree-independent ledger sum, and the two
    // are not guaranteed to agree the moment the tree has real rollup. The
    // renderer must print what the server said, not what the screen shows.
    renderTable({ totals: { label: "الإجمالي", values: { current: <Num value={9999} strong />, prior: <Num value={8888} strong /> } } });
    const tfoot = document.querySelector("tfoot") as HTMLElement;
    expect(tfoot.textContent).toContain("9,999.00");
    expect(tfoot.textContent).not.toContain("500.00");
    expect(tfoot.getAttribute("data-statement-totals")).toBe("server");
  });

  it("omits the footer entirely when totals are unknown, rather than showing zeros", () => {
    renderTable({ totals: null });
    expect(document.querySelector("tfoot")).toBeNull();
  });
});

describe("the comparative column", () => {
  it("groups the periods under a two-tier header", () => {
    renderTable();
    const headerRows = document.querySelectorAll("thead tr");
    expect(headerRows).toHaveLength(2);
    expect(headerRows[0].textContent).toContain("الفترة الحالية");
    expect(headerRows[0].textContent).toContain("الفترة المقارنة");
    expect(headerRows[1].textContent).toContain("مدين");
  });

  it("spans the label and code columns across BOTH header tiers", () => {
    renderTable();
    const first = document.querySelectorAll("thead tr")[0].querySelectorAll("th");
    expect(first[0].getAttribute("rowspan")).toBe("2");
    expect(first[1].getAttribute("rowspan")).toBe("2");
  });

  it("renders a single-tier header when there are no groups", () => {
    renderTable({ groups: undefined, columns: COLUMNS.map((c) => ({ ...c, groupId: undefined })) });
    expect(document.querySelectorAll("thead tr")).toHaveLength(1);
  });

  it("prints both periods on the same line", () => {
    renderTable();
    const cells = row("1101").querySelectorAll("td");
    expect(cells[2].textContent).toContain("100.00");
    expect(cells[3].textContent).toContain("90.00");
  });
});

describe("collapse is a screen preference, never an accounting filter", () => {
  const collapsed = new Set(["1100"]);

  it("hides a collapsed branch from the SCREEN", () => {
    renderTable({ collapsedIds: collapsed, onToggleRow: vi.fn() });
    expect(row("1101").getAttribute("data-statement-screen-hidden")).toBe("true");
    expect(row("1101").className).toContain("hidden");
  });

  it("still PRINTS the collapsed rows — the sheet must add up to its own footer", () => {
    renderTable({ collapsedIds: collapsed, onToggleRow: vi.fn() });
    // `hidden print:table-row` is the repo's existing idiom (TrialBalance.tsx,
    // InventoryValuation.tsx): removed from the screen, restored on paper.
    expect(row("1101").className).toContain("print:table-row");
    expect(row("1102").className).toContain("print:table-row");
  });

  it("still EXPORTS the collapsed rows", () => {
    const csv = statementCsv(ROWS, COLUMNS, "الحساب", { leadHeader: "الرمز", renderLeadText: (r) => r.id });
    const ids = csv.rows.map((r) => r[0]);
    expect(ids).toContain("1101");
    expect(ids).toContain("1102");
    expect(csv.rows).toHaveLength(ROWS.length);
  });

  it("keeps the parent of a collapsed branch visible", () => {
    renderTable({ collapsedIds: collapsed, onToggleRow: vi.fn() });
    expect(row("1100").getAttribute("data-statement-screen-hidden")).toBeNull();
  });

  it("hides a whole SUBTREE, not just the immediate children", () => {
    const visible = visibleStatementRows(ROWS, new Set(["1000"]));
    expect(visible.map((r) => r.id)).toEqual(["1000"]);
  });

  it("survives a parent cycle in the data instead of hanging", () => {
    const cyclic: Row[] = [
      { id: "a", parentId: "b", depth: 0, label: "a", current: 1, prior: 1 },
      { id: "b", parentId: "a", depth: 0, label: "b", current: 1, prior: 1 },
    ];
    expect(visibleStatementRows(cyclic, new Set(["zzz"])).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("offers a toggle only on rows that have children", () => {
    const onToggleRow = vi.fn();
    renderTable({ collapsedIds: new Set<string>(), onToggleRow });
    expect(within(row("1100")).getByRole("button", { name: "طي" })).toBeTruthy();
    expect(within(row("1101")).queryByRole("button")).toBeNull();
    fireEvent.click(within(row("1100")).getByRole("button", { name: "طي" }));
    expect(onToggleRow).toHaveBeenCalledWith("1100");
  });

  it("reports the collapse state to assistive tech", () => {
    renderTable({ collapsedIds: collapsed, onToggleRow: vi.fn() });
    expect(within(row("1100")).getByRole("button", { name: "توسيع" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("csv", () => {
  it("carries the code, the label and every column", () => {
    const csv = statementCsv(ROWS, COLUMNS, "الحساب", { leadHeader: "الرمز", renderLeadText: (r) => r.id });
    expect(csv.header).toEqual(["الرمز", "الحساب", "مدين", "مدين"]);
    expect(csv.rows[2]).toEqual(["1101", "الصندوق", 100, 90]);
  });

  it("uses labelText when the on-screen label is not a bare string", () => {
    const rows: Row[] = [{ id: "x", depth: 0, label: <strong>الصندوق</strong>, labelText: "الصندوق", current: 1, prior: 2 }];
    expect(statementCsv(rows, COLUMNS, "الحساب").rows[0][0]).toBe("الصندوق");
  });
});

describe("the money cells are the house ones", () => {
  it("renders zero as a dash, not as 0.00", () => {
    const rows: Row[] = [{ id: "z", depth: 0, label: "صفر", current: 0, prior: 0 }];
    renderTable({ rows });
    expect(row("z").querySelectorAll("td")[2].textContent).toBe("—");
  });

  it("flags an invalid figure instead of formatting it as a number", () => {
    const rows: Row[] = [{ id: "bad", depth: 0, label: "خطأ", current: NaN, prior: 0 }];
    renderTable({ rows });
    expect(row("bad").querySelector("[data-invalid-financial-value]")).not.toBeNull();
  });
});
