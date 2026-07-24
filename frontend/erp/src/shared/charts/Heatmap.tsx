// Heatmap — CSS-grid matrix (e.g. sales by weekday × hour). Each cell is a
// real focusable <button> (keyboard + screen-reader reachable, aria-label
// carries row/col/value), tinted on a 5-step scale of --mt-chart-1 via
// color-mix — with an opacity-layer fallback where color-mix is unsupported
// (jsdom). Layout is CSS grid in logical flow, so RTL mirrors for free.
// Like ChartCard, the same data ships as a real <table> inside <details>.
import { Fragment } from "react";
import { cn, formatNumber } from "@/shared/lib";

export interface HeatmapAxisItem {
  key: string;
  label: string;
}

export interface HeatmapCell {
  row: string;
  col: string;
  value: number;
}

export interface HeatmapProps {
  rows: HeatmapAxisItem[];
  cols: HeatmapAxisItem[];
  cells: HeatmapCell[];
  /** Intensity ceiling. Defaults to the max cell value. */
  max?: number;
  onCellClick?: (cell: HeatmapCell) => void;
  /** Formats the value for display + aria (default formatNumber — Latin digits). */
  valueFormatter?: (value: number) => string;
  /** Accessible name of the heatmap grid. */
  ariaLabel: string;
  /** <summary> label — when provided the <details> table alternative renders. */
  tableLabel?: string;
  /** sr-only <caption> for the table alternative. */
  tableCaption?: string;
  className?: string;
}

/** 5-step tint percentages (step 0 = no data / zero → plain surface). */
const STEP_PCT = [0, 12, 30, 50, 70, 90] as const;

function stepFor(value: number, max: number): number {
  if (!(max > 0) || value <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / max) * 5)));
}

// Detected once — jsdom has no color-mix; real browsers in the support matrix do.
// The probe uses only the `white` keyword (hex is forbidden in erp files).
const SUPPORTS_COLOR_MIX =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("background-color", "color-mix(in srgb, white 50%, white)");

export function Heatmap({
  rows,
  cols,
  cells,
  max,
  onCellClick,
  valueFormatter = formatNumber,
  ariaLabel,
  tableLabel,
  tableCaption,
  className,
}: HeatmapProps) {
  // Nested row → col lookup (no composite string key → no separator collisions).
  const byRow = new Map<string, Map<string, HeatmapCell>>();
  for (const cell of cells) {
    let colMap = byRow.get(cell.row);
    if (!colMap) {
      colMap = new Map<string, HeatmapCell>();
      byRow.set(cell.row, colMap);
    }
    colMap.set(cell.col, cell);
  }
  const lookup = (rowKey: string, colKey: string): HeatmapCell | undefined => byRow.get(rowKey)?.get(colKey);

  const ceiling = max ?? cells.reduce((m, c) => Math.max(m, c.value), 0);

  function renderCell(row: HeatmapAxisItem, col: HeatmapAxisItem) {
    const cell = lookup(row.key, col.key);
    const value = cell?.value;
    const step = value == null ? 0 : stepFor(value, ceiling);
    const pct = STEP_PCT[step];
    const display = value == null ? "—" : valueFormatter(value);
    return (
      <button
        key={`${row.key}:${col.key}`}
        type="button"
        onClick={cell && onCellClick ? () => onCellClick(cell) : undefined}
        aria-label={`${row.label} × ${col.label}: ${display}`}
        className={cn(
          "relative grid min-h-9 place-items-center overflow-hidden rounded-md border border-slate-100 px-1 transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
          step >= 4 ? "text-white" : "text-slate-700",
          cell && onCellClick ? "cursor-pointer hover:ring-2 hover:ring-teal-200" : "cursor-default",
        )}
        style={
          SUPPORTS_COLOR_MIX && step > 0
            ? { backgroundColor: `color-mix(in srgb, var(--mt-chart-1) ${pct}%, white)` }
            : undefined
        }
      >
        {!SUPPORTS_COLOR_MIX && step > 0 && (
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{ backgroundColor: "var(--mt-chart-1)", opacity: pct / 100 }}
          />
        )}
        <span dir="ltr" className="relative text-[11px] font-bold tabular-nums">
          {display}
        </span>
      </button>
    );
  }

  return (
    <div className={className}>
      <div className="scrollbar-thin overflow-x-auto">
        <div
          role="group"
          aria-label={ariaLabel}
          className="grid gap-1"
          style={{ gridTemplateColumns: `minmax(5rem, auto) repeat(${cols.length}, minmax(2.5rem, 1fr))` }}
        >
          <span aria-hidden="true" />
          {cols.map((c) => (
            <span key={c.key} className="truncate text-center text-[11px] font-extrabold text-slate-500">
              {c.label}
            </span>
          ))}
          {rows.map((r) => (
            <Fragment key={r.key}>
              <span className="self-center truncate pe-1 text-xs font-bold text-slate-600">{r.label}</span>
              {cols.map((c) => renderCell(r, c))}
            </Fragment>
          ))}
        </div>
      </div>

      {tableLabel && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer select-none text-xs font-extrabold text-teal-700 hover:text-teal-800">
            {tableLabel}
          </summary>
          <div className="scrollbar-thin mt-3 overflow-x-auto">
            <table className="w-full min-w-[360px] text-start">
              {tableCaption && <caption className="sr-only">{tableCaption}</caption>}
              <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start" />
                  {cols.map((c) => (
                    <th key={c.key} scope="col" className="px-3 py-2 text-start">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-slate-100 last:border-0">
                    <th scope="row" className="px-3 py-2 text-start text-xs font-extrabold text-slate-600">
                      {r.label}
                    </th>
                    {cols.map((c) => {
                      const cell = lookup(r.key, c.key);
                      return (
                        <td key={c.key} className="px-3 py-2 font-bold text-slate-600 tabular-nums">
                          {cell == null ? "—" : valueFormatter(cell.value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
