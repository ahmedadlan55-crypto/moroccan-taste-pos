import type { ReactNode } from "react";

export type ColumnAlign = "start" | "center" | "end";

export interface ColumnDef<T> {
  /** Stable id — used for sort keys, visibility, and CSV headers. */
  id: string;
  /** Column header (string or node). Strings are also used as the CSV/mobile label. */
  header: ReactNode;
  /** Extract the raw value (drives client sort + the default cell + CSV). */
  accessor?: (row: T) => unknown;
  /** Custom cell renderer. Falls back to String(accessor(row)). */
  cell?: (row: T) => ReactNode;
  align?: ColumnAlign;
  /** Enable per-column sorting (client mode sorts by `accessor`). */
  sortable?: boolean;
  /** Allow the user to hide the column via the columns menu (default true). */
  hideable?: boolean;
  /** Hidden until the user enables it in the columns menu. */
  defaultHidden?: boolean;
  /** Fixed width (e.g. "8rem" or 120). */
  width?: string | number;
  /** Numeric cell → tabular-nums, LTR, end-aligned. */
  numeric?: boolean;
  /** Exclude from CSV export. */
  noExport?: boolean;
  /** Override the CSV/mobile-stack label when `header` is not a plain string. */
  label?: string;
  /** Override the exported value (else uses `accessor`). */
  exportValue?: (row: T) => string | number;
}

export type SortDir = "asc" | "desc";
export interface TableSort {
  columnId: string;
  dir: SortDir;
}
