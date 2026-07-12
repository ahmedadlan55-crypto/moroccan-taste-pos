import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/shared/lib";
import { IconButton } from "./icon-button";
import { useFocusTrap } from "./overlay";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZES: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** Hide the top-right close (X) button (e.g. force a decision). */
  hideClose?: boolean;
  /** Disable Escape / backdrop close (e.g. while a request is in flight). */
  dismissable?: boolean;
}

/**
 * Accessible modal dialog: portal to <body>, focus trap, Escape + backdrop
 * close, focus restore, scroll lock, aria-modal + labelled title/description.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose = false,
  dismissable = true,
}: DialogProps) {
  const panelRef = useFocusTrap<HTMLDivElement>({
    active: open,
    onClose,
    escClosable: dismissable,
  });
  const titleId = useId();
  const descId = useId();

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-modal">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-950/40"
            aria-hidden="true"
            onClick={() => dismissable && onClose()}
          />
          <div className="absolute inset-0 grid place-items-center p-4">
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: "spring", damping: 26, stiffness: 320 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title ? titleId : undefined}
              aria-describedby={description ? descId : undefined}
              tabIndex={-1}
              dir="rtl"
              className={cn(
                "w-full rounded-2xl border border-slate-200 bg-white shadow-2xl focus:outline-none",
                SIZES[size],
              )}
            >
              {(title || !hideClose) && (
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <div className="min-w-0">
                    {title && (
                      <h2 id={titleId} className="text-lg font-extrabold text-slate-900">
                        {title}
                      </h2>
                    )}
                    {description && (
                      <div id={descId} className="mt-1 text-sm font-medium text-slate-500">
                        {description}
                      </div>
                    )}
                  </div>
                  {!hideClose && (
                    <IconButton aria-label="إغلاق" size="sm" onClick={onClose}>
                      <X className="h-5 w-5" />
                    </IconButton>
                  )}
                </div>
              )}
              {children && <div className="px-5 py-4">{children}</div>}
              {footer && (
                <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-4">
                  {footer}
                </div>
              )}
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
