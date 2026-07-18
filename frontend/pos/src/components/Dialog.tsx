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
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = () => Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const items = focusable();
        if (items.length === 0) {
          e.preventDefault();
          panelRef.current?.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog for keyboard/scanner users.
    const t = setTimeout(() => {
      const el = focusable()[0];
      (el ?? panelRef.current)?.focus();
    }, 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
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
        tabIndex={-1}
        className={cn(
          "dialog-in flex max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-lift sm:max-h-[92dvh] sm:rounded-2xl",
          widthClass,
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3.5 sm:px-5">
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
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-slate-100 bg-slate-50/70 px-4 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:px-5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
