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
        "flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-white px-1 py-3",
        sticky && "sticky bottom-0 z-10 -mx-5 mt-2 px-5 shadow-soft",
        className,
      )}
    >
      {start && <div className="mr-auto flex items-center gap-2">{start}</div>}
      {children}
    </div>
  );
}
