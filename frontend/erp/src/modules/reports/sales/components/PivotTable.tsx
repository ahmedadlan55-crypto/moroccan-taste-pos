// Sales Analytics Hub — the grouped/pivot result table.
//
// Pure presentation over lib/pivot.ts: the caller owns rows/subtotals (from
// useAnalyticsQuery) and the expansion set; PivotTable builds the tree, flattens
// it, and renders 52px rows with a sticky header. Group (subtotal) rows are bold
// on a tinted background with a chevron expander; numeric cells are dir="ltr"
// tabular-nums per the formatting policy. Above WINDOW_THRESHOLD flattened rows
// the body windows itself with the same slice-on-scroll approach as the shared
// DataTable (spacer rows keep the scrollbar honest). On mobile (useIsMobile) the
// table becomes stacked cards: first-dimension path + the measures.
import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { cn } from "@/shared/lib";
import { useIsMobile } from "@/shared/hooks";
import { useTx } from "@/shared/ui/i18n";
import {
  buildTree,
  flattenTree,
  type FlatPivotRow,
  type PivotSourceRow,
} from "../lib/pivot";

export interface PivotMeasure {
  id: string;
  label: string;
  /** Formats a NON-null value; null renders as "—" here (missing contract). */
  format: (value: number) => string;
}

export interface PivotTableProps {
  rows: PivotSourceRow[];
  subtotals?: PivotSourceRow[];
  /** Row-dimension ids, outermost first (drives grouping depth). */
  rowDims: string[];
  /** Header labels for the dimension column (falls back to rowDims joined). */
  rowDimLabels?: string[];
  measures: PivotMeasure[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onRowClick?: (row: FlatPivotRow) => void;
  /**
   * Whole-period totals — the server's ROLLUP grand row, NOT the sum of the
   * rows above. Those differ whenever a top/bottom-N or a page limit is in
   * play, and the difference is the point: a "total" that only adds up what
   * happens to be on screen is a number no one can reconcile to a ledger. Pass
   * `result.totals` (QueryService computes it over the full GROUP BY,
   * independent of limit/offset) and nothing else.
   */
  grandTotals?: Record<string, number | null>;
  /** Row label for the grand-total row; required when grandTotals is given. */
  grandTotalLabel?: string;
  className?: string;
}

const ROW_HEIGHT = 52;
const MAX_BODY_HEIGHT = 560;
const WINDOW_THRESHOLD = 200;
const OVERSCAN = 8;

function cellValue(row: FlatPivotRow, measure: PivotMeasure): string {
  const v = row.values[measure.id];
  return typeof v === "number" && Number.isFinite(v) ? measure.format(v) : "—";
}

/** Same missing-value contract as cellValue, over a bare totals record. */
function totalValue(totals: Record<string, number | null>, measure: PivotMeasure): string {
  const v = totals[measure.id];
  return typeof v === "number" && Number.isFinite(v) ? measure.format(v) : "—";
}

export function PivotTable({
  rows,
  subtotals,
  rowDims,
  rowDimLabels,
  measures,
  expanded,
  onToggle,
  onRowClick,
  grandTotals,
  grandTotalLabel,
  className,
}: PivotTableProps) {
  const t = useTx();
  const isMobile = useIsMobile();
  const measureIds = measures.map((m) => m.id);

  const tree = useMemo(
    () => buildTree(rows, rowDims, measureIds, subtotals),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, subtotals, rowDims.join("|"), measureIds.join("|")],
  );
  const flat = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  // ── slice-on-scroll windowing (mirrors shared/tables/DataTable) ──
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const windowActive = !isMobile && flat.length > WINDOW_THRESHOLD;
  const vStart = windowActive ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const vCount = windowActive ? Math.ceil(MAX_BODY_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2 : flat.length;
  const vEnd = windowActive ? Math.min(flat.length, vStart + vCount) : flat.length;
  const windowRows = windowActive ? flat.slice(vStart, vEnd) : flat;
  const padTop = windowActive ? vStart * ROW_HEIGHT : 0;
  const padBottom = windowActive ? Math.max(0, (flat.length - vEnd) * ROW_HEIGHT) : 0;

  const dimHeader = (rowDimLabels && rowDimLabels.length > 0 ? rowDimLabels : rowDims).join(" / ");
  const colSpan = measures.length + 1;

  const expanderLabel = (row: FlatPivotRow) =>
    row.isExpanded ? t("salesReports.pivot.collapse") : t("salesReports.pivot.expand");

  const expander = (row: FlatPivotRow) =>
    row.isSubtotal && row.hasChildren ? (
      <button
        type="button"
        aria-expanded={row.isExpanded}
        aria-label={expanderLabel(row)}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(row.key);
        }}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-200/60 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        {row.isExpanded ? (
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        ) : (
          // Points along the RTL reading direction; flipped by dir in LTR is
          // acceptable for v1 (the affordance is the aria-expanded state).
          <ChevronLeft className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" aria-hidden="true" />
        )}
      </button>
    ) : null;

  if (flat.length === 0) return null;

  /* ── mobile: stacked cards ── */
  if (isMobile) {
    return (
      <div className={cn("space-y-2", className)} data-testid="pivot-cards">
        {/* Leads on mobile rather than trailing: there is no sticky footer on a
            card list, and a total placed after 500 cards is a total no one
            reads. */}
        {grandTotals && (
          <article
            data-testid="pivot-grand-total"
            className="rounded-xl border-2 border-slate-300 bg-slate-100 p-3"
          >
            <span className="text-sm font-extrabold text-slate-900">{grandTotalLabel}</span>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              {measures.map((m) => (
                <div key={m.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <dt className="shrink-0 font-bold text-slate-500">{m.label}</dt>
                  <dd dir="ltr" className="min-w-0 truncate font-extrabold text-slate-900 tabular-nums">
                    {totalValue(grandTotals, m)}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        )}
        {flat.map((row) => (
          <article
            key={row.key}
            className={cn(
              "surface p-3",
              row.isSubtotal && "border-teal-100 bg-slate-50",
              onRowClick && "cursor-pointer",
            )}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{ marginInlineStart: row.level * 12 }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={cn("min-w-0 truncate text-sm", row.isSubtotal ? "font-extrabold text-slate-900" : "font-bold text-slate-700")}>
                {row.labels[row.level]}
              </span>
              {expander(row)}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              {measures.map((m) => (
                <div key={m.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <dt className="shrink-0 font-bold text-slate-400">{m.label}</dt>
                  <dd dir="ltr" className="min-w-0 truncate font-extrabold text-slate-800 tabular-nums">
                    {cellValue(row, m)}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    );
  }

  /* ── desktop: sticky-header table with optional windowing ── */
  return (
    <div className={cn("surface overflow-hidden", className)}>
      <div
        ref={bodyRef}
        onScroll={windowActive ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
        className="scrollbar-thin overflow-auto"
        style={{ maxHeight: MAX_BODY_HEIGHT }}
      >
        <table className="w-full min-w-[560px] border-collapse text-start" data-testid="pivot-table">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-extrabold text-slate-400">
            <tr>
              <th scope="col" className="px-4 py-3 text-start">
                {dimHeader}
              </th>
              {/* dir="ltr" matches the numeric cells below, so the header and its
                  column stay aligned to the same physical edge in RTL and LTR. */}
              {measures.map((m) => (
                <th key={m.id} scope="col" dir="ltr" className="px-3 py-3 text-end">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {windowActive && padTop > 0 && (
              <tr aria-hidden="true">
                <td colSpan={colSpan} style={{ height: padTop, padding: 0 }} />
              </tr>
            )}
            {windowRows.map((row) => (
              <tr
                key={row.key}
                data-subtotal={row.isSubtotal || undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ height: ROW_HEIGHT }}
                className={cn(
                  "border-b border-slate-100 last:border-0",
                  row.isSubtotal ? "bg-slate-50" : "bg-white",
                  onRowClick && "cursor-pointer transition hover:bg-teal-50/40",
                )}
              >
                <td className="px-4">
                  <span
                    className="flex items-center gap-1.5"
                    style={{ paddingInlineStart: row.level * 20 }}
                  >
                    {expander(row)}
                    <span
                      className={cn(
                        "min-w-0 truncate text-sm",
                        row.isSubtotal ? "font-extrabold text-slate-900" : "font-semibold text-slate-700",
                      )}
                    >
                      {row.labels[row.level]}
                    </span>
                  </span>
                </td>
                {measures.map((m) => (
                  <td
                    key={m.id}
                    dir="ltr"
                    className={cn(
                      "px-3 text-end text-sm tabular-nums",
                      row.isSubtotal ? "font-extrabold text-slate-900" : "font-bold text-slate-600",
                    )}
                  >
                    {cellValue(row, m)}
                  </td>
                ))}
              </tr>
            ))}
            {windowActive && padBottom > 0 && (
              <tr aria-hidden="true">
                <td colSpan={colSpan} style={{ height: padBottom, padding: 0 }} />
              </tr>
            )}
          </tbody>
          {/* Sticky to the BOTTOM of the same scroll container the body uses:
              the total a reader wants to check a row against must not require
              scrolling past a windowed list of 500 rows to reach. */}
          {grandTotals && (
            <tfoot className="sticky bottom-0 z-10">
              <tr data-testid="pivot-grand-total" className="border-t-2 border-slate-300 bg-slate-100">
                <td className="px-4 py-3 text-sm font-extrabold text-slate-900">{grandTotalLabel}</td>
                {measures.map((m) => (
                  <td
                    key={m.id}
                    dir="ltr"
                    className="px-3 py-3 text-end text-sm font-extrabold tabular-nums text-slate-900"
                  >
                    {totalValue(grandTotals, m)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
