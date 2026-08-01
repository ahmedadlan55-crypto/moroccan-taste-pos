// The center's view switcher — the second level of the hub's two-level
// navigation.
//
// The hub used to be seventeen flat reports behind one picker. Five CENTERS
// answer "which part of the business", and the views inside a center answer
// "which cut of it": both questions are now on screen at once, so moving from
// branches to cashiers is one click instead of reopening a seventeen-item menu
// and reading it top to bottom.
//
// WHY BUTTONS THAT WRAP, NOT A TAB STRIP
//   Operations carries seven views. A single-line strip scrolls sideways below
//   a desktop width, which puts the view you want off-screen and — measured by
//   the e2e sweep at 1024/768/375 — pushes the PAGE into horizontal overflow.
//   `flex-wrap` costs a second row on a phone and never overflows.
//
// a11y: a list of links-in-spirit, so `aria-current="page"` marks the open one.
// Not role=tab: these navigate (they change the URL and the routed report), and
// a tablist promises a panel relationship that a route change does not have.
import { cn } from "@/shared/lib";

export interface ViewSwitcherOption {
  id: string;
  label: string;
}

export interface ViewSwitcherProps {
  options: readonly ViewSwitcherOption[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name for the group (e.g. "Operations views"). */
  ariaLabel: string;
  className?: string;
}

export function ViewSwitcher({ options, value, onChange, ariaLabel, className }: ViewSwitcherProps) {
  // One view is not a choice — rendering a single button that cannot be
  // unpicked is chrome pretending to be a control.
  if (options.length < 2) return null;
  return (
    <nav
      aria-label={ariaLabel}
      data-testid="view-switcher"
      className={cn("no-print flex flex-wrap items-center gap-1.5", className)}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (!active) onChange(opt.id);
            }}
            className={cn(
              "min-h-11 rounded-xl border px-3 text-sm font-extrabold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40",
              active
                ? "border-teal-300 bg-teal-50 text-teal-900"
                : "border-slate-200 bg-white text-slate-600 hover:border-teal-200 hover:bg-slate-50",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </nav>
  );
}
