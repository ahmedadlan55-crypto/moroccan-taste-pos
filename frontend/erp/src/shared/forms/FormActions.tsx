import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface FormActionsProps {
  children: ReactNode;
  /** Stick to the bottom of the scroll container (long forms). */
  sticky?: boolean;
  /** Optional left-aligned content (e.g. a "delete" action or dirty hint). */
  start?: ReactNode;
  className?: string;
}

/**
 * The action row for a form. When `sticky`, it pins to the bottom with a top
 * divider so Save/Cancel stay reachable on long forms without scrolling.
 */
export function FormActions({ children, sticky = false, start, className }: FormActionsProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-center justify-end gap-2 border-t border-slate-100 bg-white px-1 py-3 sm:flex sm:flex-wrap [&>a]:w-full [&>button]:w-full sm:[&>a]:w-auto sm:[&>button]:w-auto",
        // Full-bleed to the page gutters (main uses px-4 / sm:px-6), so the sticky
        // bar never overshoots the viewport on a phone. Below `lg` the shell's
        // MobileNav dock (fixed, z-40, lg:hidden) floats over the bottom, so the
        // sticky row must clear it — otherwise the dock overlays Save/Cancel and a
        // real tap lands on the dock. Flush at bottom-0 on lg+ where the dock is gone.
        sticky &&
          "sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 mt-2 px-4 shadow-soft sm:-mx-6 sm:px-6 lg:bottom-0",
        className,
      )}
    >
      {start && <div className="flex min-w-0 items-center gap-2 sm:me-auto">{start}</div>}
      {children}
    </div>
  );
}
