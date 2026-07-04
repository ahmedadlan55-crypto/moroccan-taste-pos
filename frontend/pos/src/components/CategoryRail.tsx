/**
 * Category rail — vertical chips on wide screens (first column in RTL),
 * horizontal scroll strip on smaller screens. "الكل" + live categories.
 */
import { LayoutGrid } from "lucide-react";
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
  const totalCount = Object.values(counts).reduce((s, n) => s + n, 0);
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
          {label}
        </span>
        <span className={cn("num rounded-full px-1.5 text-[10px] font-extrabold", isActive ? "bg-white/15" : "bg-slate-100 text-slate-500")}>
          {fmtInt(count)}
        </span>
      </button>
    );
  };

  return (
    <div
      className={cn(
        "scrollbar-thin",
        horizontal ? "flex gap-2 overflow-x-auto pb-1" : "flex max-h-full flex-col gap-2 overflow-y-auto pe-1",
      )}
      role="tablist"
      aria-label="التصنيفات"
    >
      {item("الكل", null, totalCount)}
      {categories.map((c) => item(c, c, counts[c] ?? 0))}
    </div>
  );
}
