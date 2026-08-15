// StatementTable — the renderer DataTable cannot be.
//
// WHY IT IS NOT A DataTable FEATURE
//   That was already asked and answered in writing, in
//   `modules/reports/sales/components/ReportTotals.tsx`: adding a footer to the
//   shared table kit "would have to answer for virtualization spacers, the
//   mobile card list, pagination and CSV export — a lot of blast radius for a
//   row of numbers". A statement needs FOUR things DataTable has none of, and
//   every one of them fights a feature DataTable exists for:
//     · a row HIERARCHY, indented by account depth — DataTable rows are flat
//       and sortable, and sorting a hierarchy destroys it;
//     · SUBTOTAL rows interleaved with the lines they sum — DataTable rows are
//       homogeneous and paginated, and a subtotal on the wrong page is a lie;
//     · a bottom line in a real <tfoot> that repeats onto every printed sheet;
//     · a COMPARATIVE column pair (this period vs prior) under a two-tier
//       header — DataTable headers are one tier and one column per header.
//   So this is a separate, deliberately un-virtualized, un-paginated renderer
//   for documents. Lists stay on DataTable.
//
// WHAT IT GENERALISES
//   `modules/accounting/pages/TrialBalance.tsx` already proved the shape by
//   hand: rowSpan/colSpan header tiers, `paddingInlineStart: 12 + depth * 22`
//   indentation, and a <tfoot> fed from the server. This is that, extracted, so
//   the next statement does not hand-write it a fourth time.
//
// THE TWO RULES IT ENFORCES RATHER THAN DOCUMENTS
//
//   1. THE FOOTER IS THE SERVER'S TOTAL. `totals.values` is rendered as given.
//      Nothing here sums the rows. TrialBalance.tsx:135-142 records removing
//      exactly that bug: a client-side `roots.reduce(...)` disagreed with the
//      server's tree-independent ledger sum the moment the tree had more than
//      one level of rollup — and a wrong total that looks authoritative is the
//      worst possible defect on an accounting document.
//
//   2. COLLAPSE IS A SCREEN PREFERENCE, NEVER AN ACCOUNTING FILTER. `rows` is
//      the COMPLETE, filter-applied set — the output. `collapsedIds` only
//      decides what the screen shows: a collapsed row is still rendered, still
//      printed (`hidden print:table-row`) and still exported. Letting a
//      collapsed branch fall out of the paper copy would mean a printed
//      statement whose lines do not add up to its own footer.
import type { ReactNode } from "react";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { cn } from "@/shared/lib";

/** Visual weight of a row. `line` is an ordinary account line. */
export type StatementRowKind = "line" | "subtotal" | "total";

export interface StatementRowBase {
  id: string;
  /** Parent row id, for hierarchy + collapse. Null/undefined = a root. */
  parentId?: string | null;
  /** 0-based indentation depth. */
  depth: number;
  /** What the row is called. */
  label: ReactNode;
  /** Plain text for CSV, when `label` is not a bare string. */
  labelText?: string;
  kind?: StatementRowKind;
  /** Show a collapse toggle. */
  hasChildren?: boolean;
}

export interface StatementColumn<R extends StatementRowBase> {
  id: string;
  header: ReactNode;
  /** Tier-1 group this column sits under. Ungrouped columns span both tiers. */
  groupId?: string;
  /** Money columns read at the end of the line; text reads from the start. */
  align?: "start" | "end";
  render: (row: R) => ReactNode;
  /** Plain value for CSV. Falls back to nothing when absent. */
  csv?: (row: R) => string | number;
}

export interface StatementColumnGroup {
  id: string;
  header: ReactNode;
}

/**
 * The bottom line. `values` are keyed by column id and come from the SERVER —
 * see rule 1 above. Pass null while totals are unknown; the footer is then
 * omitted rather than shown as zeros.
 */
export interface StatementTotals {
  label: ReactNode;
  values: Record<string, ReactNode>;
}

export interface StatementTableProps<R extends StatementRowBase> {
  /** The COMPLETE filter-applied hierarchy — the output, not the screen view. */
  rows: R[];
  columns: Array<StatementColumn<R>>;
  /** Header for the account/label column. */
  labelHeader: ReactNode;
  /** Optional leading column (account code, line no.) before the label. */
  leadHeader?: ReactNode;
  renderLead?: (row: R) => ReactNode;
  /** Tier-1 header groups, e.g. current period vs comparative prior period. */
  groups?: StatementColumnGroup[];
  /** SCREEN-only collapse. Never removes a row from print or export. */
  collapsedIds?: ReadonlySet<string>;
  onToggleRow?: (id: string) => void;
  /** Accessible labels for the collapse toggle. */
  expandLabel?: string;
  collapseLabel?: string;
  /** Server-computed bottom line. */
  totals?: StatementTotals | null;
  /** Table caption — read by screen readers, printed above the table. */
  caption?: ReactNode;
  className?: string;
}

/** Indentation the trial balance already proved readable on screen and on A4. */
const INDENT_BASE = 12;
const INDENT_STEP = 22;

/**
 * Rows the SCREEN shows: every row whose ancestors are all expanded.
 *
 * Exported because a page's "showing N of M" counter must count the same rows
 * the user is looking at, and re-deriving that beside the table is how the two
 * numbers drift apart.
 */
export function visibleStatementRows<R extends StatementRowBase>(
  rows: R[],
  collapsedIds?: ReadonlySet<string>,
): R[] {
  if (!collapsedIds || collapsedIds.size === 0) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hidden = (row: R): boolean => {
    // Walk ancestors, guarding against a parent cycle — a cycle in the account
    // tree must not hang the render; it is a data defect the report still shows.
    const seen = new Set<string>([row.id]);
    let cursor = row.parentId ?? null;
    while (cursor && !seen.has(cursor)) {
      if (collapsedIds.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return false;
  };
  return rows.filter((r) => !hidden(r));
}

/**
 * The CSV of a statement: the COMPLETE row set, collapse state ignored.
 *
 * Pair with `exportRowsCsv(filename, header, rows)`.
 */
export function statementCsv<R extends StatementRowBase>(
  rows: R[],
  columns: Array<StatementColumn<R>>,
  labelHeader: string,
  options: { leadHeader?: string; renderLeadText?: (row: R) => string | number } = {},
): { header: string[]; rows: Array<Array<string | number>> } {
  const header: string[] = [];
  if (options.leadHeader != null) header.push(options.leadHeader);
  header.push(labelHeader);
  for (const c of columns) header.push(typeof c.header === "string" ? c.header : c.id);

  const body = rows.map((row) => {
    const cells: Array<string | number> = [];
    if (options.leadHeader != null) cells.push(options.renderLeadText ? options.renderLeadText(row) : "");
    cells.push(row.labelText ?? (typeof row.label === "string" ? row.label : ""));
    for (const c of columns) cells.push(c.csv ? c.csv(row) : "");
    return cells;
  });

  return { header, rows: body };
}

function alignClass(align: StatementColumn<StatementRowBase>["align"]): string {
  return align === "start" ? "text-start" : "text-end";
}

function rowClass(kind: StatementRowKind | undefined): string {
  if (kind === "total") return "border-t-2 border-slate-300 bg-slate-50 font-extrabold text-slate-900";
  if (kind === "subtotal") return "border-t border-slate-300 bg-slate-50/70 font-extrabold text-slate-900";
  return "border-b border-slate-100 last:border-0 bg-white hover:bg-slate-50/70";
}

export function StatementTable<R extends StatementRowBase>({
  rows,
  columns,
  labelHeader,
  leadHeader,
  renderLead,
  groups,
  collapsedIds,
  onToggleRow,
  expandLabel,
  collapseLabel,
  totals,
  caption,
  className,
}: StatementTableProps<R>) {
  const hasLead = renderLead != null;
  const tiered = (groups?.length ?? 0) > 0;
  const visibleIds = new Set(visibleStatementRows(rows, collapsedIds).map((r) => r.id));
  const groupById = new Map((groups ?? []).map((g) => [g.id, g]));

  // Tier 1: consecutive columns sharing a groupId become ONE spanning header;
  // an ungrouped column spans both tiers instead. Built as a list so the header
  // markup stays a flat map with no conditional nesting.
  const tier1: Array<{ key: string; header: ReactNode; span: number; spansBothTiers: boolean }> = [];
  for (const column of columns) {
    const group = column.groupId ? groupById.get(column.groupId) : undefined;
    const last = tier1[tier1.length - 1];
    if (group && last && last.key === `g:${group.id}`) {
      last.span += 1;
      continue;
    }
    tier1.push(
      group
        ? { key: `g:${group.id}`, header: group.header, span: 1, spansBothTiers: false }
        : { key: `c:${column.id}`, header: column.header, span: 1, spansBothTiers: true },
    );
  }

  const headSpan = tiered ? 2 : 1;

  return (
    <div className="overflow-x-auto">
      <table
        className={cn("w-full min-w-[48rem] text-sm", className)}
        data-statement-table="true"
      >
        {caption != null && (
          <caption className="pb-3 text-start text-xs font-bold text-slate-500">{caption}</caption>
        )}
        <thead>
          <tr className="border-b border-slate-200 text-xs font-extrabold text-slate-500">
            {hasLead && (
              <th rowSpan={headSpan} className="w-28 px-3 py-2 text-start">
                {leadHeader}
              </th>
            )}
            <th rowSpan={headSpan} className="px-3 py-2 text-start">
              {labelHeader}
            </th>
            {tier1.map((cell) => (
              <th
                key={cell.key}
                colSpan={cell.span > 1 ? cell.span : undefined}
                rowSpan={tiered && cell.spansBothTiers ? 2 : undefined}
                className={cn(
                  "px-3 py-2",
                  cell.span > 1 ? "border-e border-slate-100 text-center" : "text-end",
                )}
              >
                {cell.header}
              </th>
            ))}
          </tr>
          {tiered && (
            <tr className="border-b border-slate-200 text-[11px] font-bold text-slate-400">
              {columns
                .filter((c) => c.groupId != null)
                .map((c) => (
                  <th key={c.id} className={cn("px-3 py-1.5", alignClass(c.align))}>
                    {c.header}
                  </th>
                ))}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((row) => {
            const onScreen = visibleIds.has(row.id);
            const collapsed = collapsedIds?.has(row.id) ?? false;
            return (
              <tr
                key={row.id}
                data-statement-row={row.id}
                data-statement-kind={row.kind ?? "line"}
                data-statement-depth={row.depth}
                data-statement-screen-hidden={onScreen ? undefined : "true"}
                className={cn(onScreen ? "" : "hidden print:table-row", rowClass(row.kind))}
              >
                {hasLead && <td className="px-3 py-2 text-start">{renderLead?.(row)}</td>}
                <td
                  className="px-3 py-2 text-start"
                  style={{ paddingInlineStart: INDENT_BASE + row.depth * INDENT_STEP }}
                >
                  <span className="inline-flex items-center gap-2">
                    {row.hasChildren && onToggleRow ? (
                      <button
                        type="button"
                        className="no-print grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? expandLabel : collapseLabel}
                        onClick={() => onToggleRow(row.id)}
                      >
                        {collapsed ? (
                          <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                    ) : (
                      <span className="no-print inline-block h-7 w-7" />
                    )}
                    <span className={cn(row.kind && row.kind !== "line" ? "font-extrabold" : "font-semibold")}>
                      {row.label}
                    </span>
                  </span>
                </td>
                {columns.map((c) => (
                  <td key={c.id} className={cn("px-3 py-2", alignClass(c.align))}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {totals && (
          <tfoot data-statement-totals="server">
            <tr className="border-t-2 border-slate-300 bg-slate-50 text-sm font-extrabold">
              <td colSpan={hasLead ? 2 : 1} className="px-3 py-2.5 text-start">
                {totals.label}
              </td>
              {columns.map((c) => (
                <td key={c.id} className={cn("px-3 py-2.5", alignClass(c.align))}>
                  {totals.values[c.id] ?? null}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
