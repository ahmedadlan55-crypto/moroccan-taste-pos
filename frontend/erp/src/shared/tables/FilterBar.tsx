import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";

export interface FilterBarProps {
  /** Controlled global search value. Omit to hide the search box. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Filter controls (Select/Combobox/DatePicker …) rendered inline. */
  children?: ReactNode;
  /** Show a "clear filters" button; fires onClear. */
  onClear?: () => void;
  hasActiveFilters?: boolean;
  className?: string;
  /** Right-aligned actions (export button, "new" button, columns menu …). */
  actions?: ReactNode;
}

/** Toolbar above a table: global search + inline filter controls + actions. */
export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder,
  children,
  onClear,
  hasActiveFilters,
  className,
  actions,
}: FilterBarProps) {
  const t = useTx();
  const searchPh = searchPlaceholder ?? t("table.searchPlaceholder");
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 p-3 xl:flex-row xl:items-center", className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {search !== undefined && onSearchChange && (
          <label className="relative w-full min-w-0 flex-1 sm:min-w-48 sm:max-w-xs">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPh}
              className="field h-10 w-full py-2 pr-10"
              aria-label={searchPh}
              type="search"
            />
          </label>
        )}
        {children}
        {onClear && hasActiveFilters && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            <X className="h-3.5 w-3.5" /> {t("table.clearFilters")}
          </button>
        )}
      </div>
      {actions && (
        <div
          className="grid w-full min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center xl:mr-auto xl:w-auto xl:justify-end [&>button]:w-full sm:[&>button]:w-auto"
          aria-label={t("table.tableActions")}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
