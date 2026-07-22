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
  /** Hide this column from the compact mobile-card representation. */
  mobileHidden?: boolean;
  /**
   * Mobile-card ordering hint. On the stacked mobile view, columns render in
   * ascending `priority` order (lower number = shown first); columns without a
   * priority keep their declared order after the prioritized ones. No priority
   * anywhere → unchanged (declaration order). `mobileHidden` still wins.
   */
  priority?: number;
  /**
   * Truncate the cell to a single line with an ellipsis (…) + a native `title`
   * tooltip instead of wrapping and growing the row. OPT-IN (default: wrap, the
   * pre-existing behavior) so existing tables are untouched. When set, the cell
   * is capped at `width` (or ~18rem) and the raw string value drives the tooltip.
   */
  ellipsis?: boolean;
  /**
   * Capability required to see this column. When set and the resolver denies it,
   * the column is omitted ENTIRELY — header, cells, columns-menu entry, and CSV
   * export. Resolution is via the DataTable `canColumn` prop (wire it from the
   * screen's `useCan`/`usePermissions`); with no resolver the default is
   * show-all, so pass `canColumn` when you rely on `requireCap`. Unset → always
   * shown (backward-compatible).
   */
  requireCap?: string;
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
