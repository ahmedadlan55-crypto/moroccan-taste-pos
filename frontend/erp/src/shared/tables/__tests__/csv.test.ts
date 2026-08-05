import { describe, expect, it } from "vitest";
import { rowsToCsv } from "../csv";
import type { ColumnDef } from "../types";

interface Row { name: string; amount: number }

const columns: ColumnDef<Row>[] = [
  { id: "name", header: "Name", accessor: (row) => row.name },
  { id: "amount", header: "Amount", accessor: (row) => row.amount },
];

describe("financial CSV safety", () => {
  it("neutralises formula-like labels without converting numeric negatives to text", () => {
    const csv = rowsToCsv(columns, [
      { name: "=HYPERLINK(\"https://example.test\")", amount: -12.5 },
      { name: "+SUM(1,2)", amount: 4 },
    ]);

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+SUM");
    expect(csv).toContain(",-12.5");
    expect(csv).not.toContain(",'-12.5");
  });
});
