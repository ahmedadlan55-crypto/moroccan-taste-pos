import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { IconButton } from "./icon-button";
import { useFocusTrap } from "./overlay";

// Accessible right-side drawer (RTL: enters from the right edge). role=dialog /
// aria-modal, focus trap on open, Escape closes, focus restored to trigger on
// close, body scroll locked while open.
interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  icon?: LucideIcon;
  children: ReactNode;
  footer?: ReactNode;
  /** Responsive panel width. Mobile always uses the full viewport. */
  size?: "sm" | "md" | "lg" | "xl";
}

const DRAWER_SIZE = {
  sm: "sm:max-w-md",
  md: "sm:max-w-xl",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
} as const;

export function Drawer({ open, onClose, title, eyebrow = "عرض سريع", icon: Icon, children, footer, size = "md" }: DrawerProps) {
  const panelRef = useFocusTrap<HTMLDivElement>({ active: open, onClose });

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-drawer">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-950/35"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 280 }}
            className={`absolute inset-y-0 right-0 flex h-[100dvh] w-full flex-col border-l border-slate-200 bg-white shadow-2xl focus:outline-none ${DRAWER_SIZE[size]}`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            dir="rtl"
          >
            <div className="flex items-start gap-3 border-b border-slate-100 p-4 sm:p-5">
              {Icon && (
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                  <Icon className="h-5 w-5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-extrabold text-teal-700">{eyebrow}</div>
                <h2 className="truncate text-lg font-extrabold text-slate-900">{title}</h2>
              </div>
              <IconButton aria-label="إغلاق" onClick={onClose}>
                <X className="h-5 w-5" />
              </IconButton>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
            {footer && (
              <div className="grid grid-cols-1 gap-2 border-t border-slate-100 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex sm:flex-wrap sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
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
