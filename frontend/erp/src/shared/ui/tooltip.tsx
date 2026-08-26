import { useId, useState, type ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/**
 * Lightweight tooltip. Shows on hover AND keyboard focus (WCAG 1.4.13); the
 * trigger is described by the tip via aria-describedby. Purely supplemental —
 * never put essential-only information here.
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute left-1/2 z-popover w-max max-w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 whitespace-normal break-words rounded-lg bg-slate-900 px-3 py-2 text-center text-xs font-bold leading-5 text-white shadow-lg",
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
