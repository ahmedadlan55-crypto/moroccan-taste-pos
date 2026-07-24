// ChartCard — the shared shell every hub chart lives in: title/subtitle,
// an actions slot, the recharts chart inside a ResponsiveContainer, and the
// REQUIRED accessible alternative — the same data as a real <table> inside
// <details> (the inventory AnalyticsPage pattern, promoted). Strings arrive
// via props (callers pass t(...)).
//
// Drill-downs: pass `onPointClick` and ChartCard clones your chart element
// with a chart-level `onClick` — recharts calls it with the chart click state
// ({ activeLabel, activePayload, ... }) which is exactly what a drill needs.
// Series-level onClick (e.g. <Bar onClick={...}>) still works independently —
// attach it yourself on the series when you need per-shape payloads.
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { ResponsiveContainer } from "recharts";
import { cn } from "@/shared/lib";

export interface ChartCardColumn {
  key: string;
  label: string;
}

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** Toolbar slot (segment switches, export buttons …). */
  actions?: ReactNode;
  /** Chart height in px (default 280). */
  height?: number;
  /** Render the empty placeholder instead of the chart. */
  isEmpty?: boolean;
  emptyLabel?: string;
  /** Columns of the accessible alternative table (labels via t(...)). */
  tableColumns: ChartCardColumn[];
  /** Rows keyed by column key. Preformat values at the call site. */
  tableRows: Record<string, unknown>[];
  /** <summary> label of the accessible table (callers pass t(...)). */
  tableLabel: string;
  /** sr-only <caption> for the table. */
  tableCaption?: string;
  /** Chart-level click → drill. Receives the recharts chart click state. */
  onPointClick?: (payload: unknown) => void;
  /** ONE recharts chart element (BarChart/LineChart/…) — wrapped in ResponsiveContainer here. */
  children: ReactNode;
  className?: string;
}

function cellText(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

export function ChartCard({
  title,
  subtitle,
  actions,
  height = 280,
  isEmpty = false,
  emptyLabel,
  tableColumns,
  tableRows,
  tableLabel,
  tableCaption,
  onPointClick,
  children,
  className,
}: ChartCardProps) {
  const chart =
    onPointClick && isValidElement(children)
      ? cloneElement(children as ReactElement<{ onClick?: (state: unknown) => void }>, {
          onClick: (state: unknown) => onPointClick(state),
        })
      : children;

  return (
    <article className={cn("surface overflow-hidden p-5", className)}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs font-medium text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>

      {isEmpty ? (
        <div style={{ height }} className="grid place-items-center text-sm font-bold text-slate-400">
          {emptyLabel}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {chart as ReactElement}
        </ResponsiveContainer>
      )}

      {!isEmpty && tableRows.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer select-none text-xs font-extrabold text-teal-700 hover:text-teal-800">
            {tableLabel}
          </summary>
          <div className="scrollbar-thin mt-3 overflow-x-auto">
            <table className="w-full min-w-[360px] text-start">
              {tableCaption && <caption className="sr-only">{tableCaption}</caption>}
              <thead className="bg-slate-50 text-[11px] font-extrabold text-slate-400">
                <tr>
                  {tableColumns.map((c) => (
                    <th key={c.key} scope="col" className="px-3 py-2 text-start">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    {tableColumns.map((c) => (
                      <td key={c.key} className="px-3 py-2 font-bold text-slate-600 tabular-nums">
                        {cellText(row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </article>
  );
}
