import type { ColumnDef } from "./types";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Prevent spreadsheet formula injection from labels/descriptions while
  // preserving genuine numeric cells (including negative numbers).
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Quote when the value contains a delimiter, quote, or newline (RFC 4180).
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function headerLabel<T>(col: ColumnDef<T>): string {
  if (col.label) return col.label;
  return typeof col.header === "string" ? col.header : col.id;
}

function cellValue<T>(col: ColumnDef<T>, row: T): unknown {
  if (col.exportValue) return col.exportValue(row);
  if (col.accessor) return col.accessor(row);
  return "";
}

/** Build an RFC-4180 CSV string from the current rows + visible columns. */
export function rowsToCsv<T>(columns: ColumnDef<T>[], rows: T[]): string {
  const cols = columns.filter((c) => !c.noExport);
  const header = cols.map((c) => csvCell(headerLabel(c))).join(",");
  const body = rows.map((row) => cols.map((c) => csvCell(cellValue(c, row))).join(","));
  return [header, ...body].join("\r\n");
}

/**
 * Client-side CSV download of the in-memory rows. A BOM is prepended so Excel
 * opens Arabic/UTF-8 correctly. For a SERVER-side export of a large dataset,
 * use `downloadCsv` from `@/shared/lib` against the export endpoint instead.
 */
export function downloadRowsCsv<T>(columns: ColumnDef<T>[], rows: T[], filename: string): void {
  const csv = "﻿" + rowsToCsv(columns, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
