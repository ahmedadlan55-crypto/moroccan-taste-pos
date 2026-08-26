import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/shared/lib";
import { useOptionalLang } from "@/i18n";
import { IconButton } from "./icon-button";
import { useFocusTrap } from "./overlay";
import { FullPageFlow } from "./full-page-flow";
import { useTx } from "./i18n";

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
  /** Full-page is the default for data entry. Compact is reserved for short confirmations. */
  presentation?: "workspace" | "compact";
}

/**
 * Accessible modal dialog: portal to <body>, focus trap, Escape + backdrop
 * close, focus restore, scroll lock, aria-modal + labelled title/description.
 */
export function Dialog({ presentation = "workspace", size = "md", ...props }: DialogProps) {
  if (presentation === "workspace") {
    return (
      <FullPageFlow
        open={props.open}
        onClose={props.onClose}
        title={props.title}
        description={props.description}
        footer={props.footer}
        size={size}
        hideClose={props.hideClose}
        dismissable={props.dismissable}
      >
        {props.children}
      </FullPageFlow>
    );
  }

  return <CompactDialog {...props} size={size} presentation="compact" />;
}

function CompactDialog({
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
  const t = useTx();
  const lang = useOptionalLang() ?? "ar";
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
          <div className="absolute inset-0 grid place-items-center p-0 sm:p-4">
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
              dir={lang === "ar" ? "rtl" : "ltr"}
              className={cn(
                "flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl focus:outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl",
                SIZES[size],
              )}
            >
              {(title || !hideClose) && (
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
                  <div className="min-w-0">
                    {title && (
                      <h2 id={titleId} className="text-lg font-bold text-slate-900">
                        {title}
                      </h2>
                    )}
                    {description && (
                      <div id={descId} className="mt-1 text-sm font-normal leading-6 text-slate-600">
                        {description}
                      </div>
                    )}
                  </div>
                  {!hideClose && (
                    <IconButton aria-label={t("common.close")} size="sm" onClick={onClose}>
                      <X className="h-5 w-5" />
                    </IconButton>
                  )}
                </div>
              )}
              {children && <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>}
              {footer && (
                <div className="grid shrink-0 grid-cols-1 gap-2 border-t border-slate-100 bg-white px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex sm:flex-wrap sm:justify-end sm:px-5 [&>a]:w-full [&>button]:w-full sm:[&>a]:w-auto sm:[&>button]:w-auto">
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
