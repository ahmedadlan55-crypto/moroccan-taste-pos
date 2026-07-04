/**
 * Base modal dialog — RTL, Esc-to-close, backdrop click, focus containment,
 * plain CSS enter animation (no framer-motion by design).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "./ui";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
  /** Block closing (mid-payment progress etc.) */
  locked?: boolean;
}

export function Dialog({ open, onClose, title, children, footer, widthClass = "max-w-lg", locked }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog for keyboard/scanner users.
    const t = setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>("input, button, [tabindex]");
      el?.focus();
    }, 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose, locked]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "dialog-in flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-lift sm:rounded-2xl",
          widthClass,
        )}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-base font-extrabold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={locked}
            aria-label="إغلاق"
            className="btn-press flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-slate-100 bg-slate-50/70 px-5 py-3.5">{footer}</div> : null}
      </div>
    </div>
  );
}
