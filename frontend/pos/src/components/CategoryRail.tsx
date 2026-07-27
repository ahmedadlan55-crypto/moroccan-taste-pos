/**
 * Category rail — vertical chips on wide screens (first column in RTL),
 * horizontal scroll strip on smaller screens. «الأكثر مبيعًا» (once this till
 * has a history) + "الكل" + live categories.
 *
 * The quick-picks chip is PINNED FIRST and lives in this one component, so the
 * vertical rail and the horizontal mobile strip get it identically — the host
 * mounts <CategoryRail/> twice and neither call site changes.
 *
 * It selects the QUICK_PICKS_CATEGORY sentinel through the SAME `onSelect`
 * channel a real category uses, and ProductGrid's filterItems understands that
 * sentinel. That is the whole integration: no new prop, no host state, no
 * server call (the tally is local — see lib/quickPicks.ts).
 */
import { LayoutGrid, Star } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import { QUICK_PICKS_CATEGORY, useQuickPicks } from "@/lib/quickPicks";
import { cn } from "./ui";
import { fmtInt } from "@/lib/format";

export interface CategoryRailProps {
  categories: string[];
  counts: Record<string, number>;
  active: string | null; // null = الكل
  onSelect: (category: string | null) => void;
  horizontal?: boolean;
}

export function CategoryRail({ categories, counts, active, onSelect, horizontal }: CategoryRailProps) {
  const t = useT();
  const quickPicks = useQuickPicks();
  const totalCount = Object.values(counts).reduce((s, n) => s + n, 0);
  // Categories arrive from the DB as Arabic strings. Map known ones to the
  // active language via the dictionary; unknown categories fall back to the
  // raw Arabic value (t() returns the dotted path itself on a lookup miss).
  const catLabel = (category: string) => {
    const path = `categoryRail.categoryLabels.${category}`;
    const label = t(path);
    return label === path ? category : label;
  };
  const item = (label: string, value: string | null, count: number) => {
    const isActive = active === value;
    return (
      <button
        key={value ?? "__all"}
        type="button"
        onClick={() => onSelect(value)}
        aria-pressed={isActive}
        className={cn(
          "btn-press flex min-h-11 shrink-0 items-center justify-between gap-2 rounded-xl border px-3.5 py-2 text-sm font-bold transition",
          horizontal ? "" : "w-full",
          isActive
            ? "border-ink bg-ink text-white shadow-sm"
            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
        )}
      >
        <span className="flex items-center gap-2">
          {value === null ? <LayoutGrid className="h-4 w-4" aria-hidden /> : null}
          {value === QUICK_PICKS_CATEGORY ? <Star className="h-4 w-4" aria-hidden /> : null}
          {label}
        </span>
        <span className={cn("num rounded-full px-1.5 text-[10px] font-extrabold", isActive ? "bg-white/15" : "bg-slate-100 text-slate-500")}>
          {fmtInt(count)}
        </span>
      </button>
    );
  };

  // Shown once this till has actually sold something — and kept on screen while
  // it is the ACTIVE chip even if a prune just emptied the tally, so the cashier
  // is never left holding a filtered grid with no chip to leave it by.
  const showQuickPicks = quickPicks.length > 0 || active === QUICK_PICKS_CATEGORY;

  return (
    <div
      className={cn(
        "scrollbar-thin",
        horizontal ? "flex gap-2 overflow-x-auto pb-1" : "flex max-h-full flex-col gap-2 overflow-y-auto pe-1",
      )}
      role="tablist"
      aria-label={t("categoryRail.aria.tablist")}
    >
      {showQuickPicks ? item(t("categoryRail.quickPicks"), QUICK_PICKS_CATEGORY, quickPicks.length) : null}
      {item(t("categoryRail.all"), null, totalCount)}
      {categories.map((c) => item(catLabel(c), c, counts[c] ?? 0))}
    </div>
  );
}
