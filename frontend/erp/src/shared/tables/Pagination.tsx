import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, formatNumber } from "@/shared/lib";
import { IconButton } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";

/**
 * The "page N of M" counter. One implementation, because there were ten.
 *
 * TWO DEFECTS IT FIXES, and the second is not cosmetic:
 *
 *   1. IT WRAPPED. As a flex item with no `whitespace-nowrap`, the span shrinks
 *      when the row is tight and the text breaks at its spaces — so "1 / 1"
 *      stacked into three lines, one character each.
 *
 *   2. IT READ BACKWARDS. Without `dir="ltr"` the bidi algorithm reorders the
 *      run inside an RTL page: measured in a real browser, the source text
 *      "2 / 10" renders visually as "10 / 2". On page 2 of 10 the user was told
 *      they were on page 10 of 2. "1 / 1" hid it — the only pair symmetric
 *      enough to look right.
 *
 * `tabular-nums` keeps the counter from twitching as the digit count changes.
 */
export function PageCounter({
  page,
  pageCount,
  className,
}: {
  page: number;
  pageCount: number;
  className?: string;
}) {
  return (
    <span
      dir="ltr"
      aria-current="page"
      className={cn("shrink-0 whitespace-nowrap text-center tabular-nums", className)}
    >
      {formatNumber(page)} / {formatNumber(pageCount)}
    </span>
  );
}

export interface PaginationProps {
  page: number;
  pageCount: number;
  total?: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

/** Page navigation + optional page-size selector + a "showing X of Y" readout. */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  className,
}: PaginationProps) {
  const t = useTx();
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = total != null ? Math.min(page * pageSize, total) : page * pageSize;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-3 py-3 text-xs font-semibold text-slate-500",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {total != null ? (
          <span dir="rtl">
            {t("table.showing")}{" "}
            <span dir="ltr" className="tabular-nums">
              {formatNumber(from)}–{formatNumber(to)}
            </span>{" "}
            {t("table.of")}{" "}
            <span dir="ltr" className="tabular-nums">
              {formatNumber(total)}
            </span>
          </span>
        ) : (
          <span>
            {t("table.page")} <span className="tabular-nums">{formatNumber(page)}</span>
          </span>
        )}
        {onPageSizeChange && (
          <label className="flex items-center gap-1">
            <span className="sr-only">{t("table.rowsPerPage")}</span>
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              aria-label={t("table.rowsPerPage")}
            >
              {pageSizeOptions.map((s) => (
                <option key={s} value={s}>
                  {t("table.perPage", { count: s })}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <nav className="flex items-center gap-1" aria-label={t("table.paginationNav")}>
        <IconButton
          aria-label={t("table.prevPage")}
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {/* RTL: "previous" points to the right */}
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <PageCounter page={page} pageCount={pageCount} className="min-w-16" />
        <IconButton
          aria-label={t("table.nextPage")}
          size="sm"
          variant="secondary"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
      </nav>
    </div>
  );
}
