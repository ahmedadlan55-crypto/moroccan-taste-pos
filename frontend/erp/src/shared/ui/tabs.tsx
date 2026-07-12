import { useId, useRef, type ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface TabItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  "aria-label"?: string;
}

/**
 * Accessible tab strip (role=tablist/tab) with roving arrow-key navigation.
 * Render the active panel yourself keyed off `value` (headless content model).
 */
export function Tabs({ items, value, onChange, className, "aria-label": ariaLabel }: TabsProps) {
  const baseId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (dir: 1 | -1) => {
    const enabled = items.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.value === value);
    if (idx === -1) return;
    const next = enabled[(idx + dir + enabled.length) % enabled.length];
    onChange(next.value);
    refs.current[next.value]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex items-center gap-1 border-b border-slate-200", className)}
      onKeyDown={(e) => {
        // RTL-aware: ArrowLeft advances, ArrowRight goes back.
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {items.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[t.value] = el;
            }}
            id={`${baseId}-tab-${t.value}`}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={cn(
              "-mb-px min-h-11 border-b-2 px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-teal-600 text-teal-700"
                : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
