import {
  BarChart3,
  PackageSearch,
  SlidersHorizontal,
  Store,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/shared/lib";

export interface CenterNavOption {
  id: string;
  label: string;
  /** A real, readable phone label; never truncate a business destination. */
  shortLabel?: string;
}

export interface CenterNavProps {
  options: readonly CenterNavOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  className?: string;
}

const ICONS: Record<string, LucideIcon> = {
  executive: BarChart3,
  items: PackageSearch,
  payments: WalletCards,
  operations: Store,
  explorer: SlidersHorizontal,
};

/**
 * The five stable sales-analysis centres.
 *
 * Reports used to sit behind one large picker. That saved horizontal space but
 * hid the information architecture: a manager had to open a menu before they
 * could even discover that item, hourly, branch and cashier analysis existed.
 * Five centres are few enough to keep visible at every width. On a phone they
 * stay in one compact icon-first row (full names remain accessible and in the
 * title); from `sm` the same controls expand into their named desktop form.
 * There is no dropdown and no horizontally hidden destination.
 */
export function CenterNav({ options, value, onChange, ariaLabel, className }: CenterNavProps) {
  return (
    <nav
      aria-label={ariaLabel}
      data-testid="sales-center-nav"
      className={cn(
        "grid grid-cols-3 gap-1.5 sm:gap-2 xl:grid-cols-5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.id === value;
        const Icon = ICONS[option.id] ?? BarChart3;
        return (
          <button
            key={option.id}
            type="button"
            data-center-id={option.id}
            title={option.label}
            aria-label={option.label}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (!active) onChange(option.id);
            }}
            className={cn(
              "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2 text-center transition-colors",
              "sm:min-h-16 sm:flex-row sm:justify-start sm:gap-2.5 sm:rounded-xl sm:px-3 sm:py-2.5 sm:text-start",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40",
              active
                ? "border-teal-300 bg-white text-teal-950 shadow-soft"
                : "border-transparent bg-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900",
            )}
          >
            <span
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-md sm:h-8 sm:w-8 sm:rounded-lg",
                active ? "bg-teal-100 text-teal-800" : "bg-slate-100 text-slate-500",
              )}
            >
              <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" aria-hidden={true} />
            </span>
            <span className="w-full min-w-0 text-xs font-extrabold leading-tight xl:text-sm">
              <span aria-hidden="true" className="xl:hidden">{option.shortLabel ?? option.label}</span>
              <span aria-hidden="true" className="hidden whitespace-normal leading-5 xl:block">{option.label}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
