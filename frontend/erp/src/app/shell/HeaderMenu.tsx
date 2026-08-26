import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/shared/lib";

// Minimal accessible header dropdown: a trigger button + a panel that closes on
// outside-click and Esc. Reused by the notification / approvals / user menus.
export function HeaderMenu({
  trigger,
  label,
  align = "start",
  panelClassName,
  children,
}: {
  /** Rendered inside the trigger button. */
  trigger: ReactNode;
  /** Accessible name for the trigger. */
  label: string;
  align?: "start" | "end";
  panelClassName?: string;
  /** Panel content; receives a `close` callback. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="grid min-h-11 min-w-11 place-items-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-[calc(100%+0.5rem)] z-popover w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lift",
            align === "start" ? "start-0" : "end-0",
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
