import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// Accessible right-side drawer (RTL: enters from the right edge). Implements
// the §15 requirements: role=dialog/aria-modal, focus moves in on open, Escape
// closes, focus is trapped while open, and focus is restored to the trigger on
// close. Body scroll is locked while open.
interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  icon?: LucideIcon;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, eyebrow = "عرض سريع", icon: Icon, children, footer }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    // Move focus inside the drawer.
    const focusables = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    const first = focusables()[0];
    (first ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const els = focusables();
        if (!els.length) return;
        const firstEl = els[0];
        const lastEl = els[els.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-950/35"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 280 }}
            className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl focus:outline-none"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
          >
            <div className="flex items-start gap-3 border-b border-slate-100 p-5">
              {Icon && (
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                  <Icon className="h-5 w-5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-extrabold text-teal-700">{eyebrow}</div>
                <h2 className="truncate text-lg font-extrabold text-slate-900">{title}</h2>
              </div>
              <Button variant="ghost" size="icon" aria-label="إغلاق" onClick={onClose}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="scrollbar-thin flex-1 overflow-y-auto p-5">{children}</div>
            {footer && <div className="flex flex-wrap gap-2 border-t border-slate-100 p-4">{footer}</div>}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function DetailStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
      <div className="text-[10px] font-bold text-slate-400">{label}</div>
      <div className="mt-1 text-sm font-extrabold text-slate-800">{value}</div>
    </div>
  );
}
