import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib";
import { useOptionalLang } from "@/i18n";
import { useFocusTrap } from "./overlay";
import { useTx } from "./i18n";

export type FullPageFlowSize = "sm" | "md" | "lg" | "xl";

const CONTENT_WIDTH: Record<FullPageFlowSize, string> = {
  sm: "max-w-3xl",
  md: "max-w-5xl",
  lg: "max-w-6xl",
  xl: "max-w-[88rem]",
};

export interface FullPageFlowProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
  eyebrow?: string;
  icon?: LucideIcon;
  children?: ReactNode;
  footer?: ReactNode;
  size?: FullPageFlowSize;
  hideClose?: boolean;
  dismissable?: boolean;
  layer?: "modal" | "drawer";
}

/**
 * Full-viewport work area for create, edit and record-detail flows.
 * The previous screen is fully replaced, while the header and action bar stay
 * visible and only the form body scrolls. Short confirmations remain compact.
 */
export function FullPageFlow({
  open,
  onClose,
  title,
  description,
  eyebrow,
  icon: Icon,
  children,
  footer,
  size = "md",
  hideClose = false,
  dismissable = true,
  layer = "modal",
}: FullPageFlowProps) {
  const t = useTx();
  const lang = useOptionalLang() ?? "ar";
  const BackIcon = lang === "ar" ? ArrowRight : ArrowLeft;
  const pageRef = useFocusTrap<HTMLDivElement>({
    active: open,
    onClose,
    escClosable: dismissable,
  });
  const titleId = useId();
  const descId = useId();

  if (typeof document === "undefined") return null;

  const width = CONTENT_WIDTH[size];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={pageRef}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className={cn(
            "fixed inset-0 flex h-[100dvh] w-full flex-col overflow-hidden bg-canvas text-slate-800 focus:outline-none",
            layer === "drawer" ? "z-drawer" : "z-modal",
          )}
          role="region"
          aria-label={!title ? t("sharedUi.fullPageFlow.workspace") : undefined}
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          dir={lang === "ar" ? "rtl" : "ltr"}
          data-presentation="full-page"
        >
          <header className="shrink-0 border-b border-slate-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur sm:px-6 lg:px-8">
            <div className={cn("mx-auto flex min-w-0 items-center gap-3 sm:gap-4", width)}>
              {!hideClose && (
                <button
                  type="button"
                  onClick={onClose}
                  disabled={!dismissable}
                  className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                  aria-label={t("sharedUi.fullPageFlow.backAria")}
                >
                  <BackIcon className="h-5 w-5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t("sharedUi.fullPageFlow.back")}</span>
                </button>
              )}

              {Icon && (
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-100">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
              )}

              <div className="min-w-0 flex-1">
                {eyebrow && <div className="mb-0.5 text-xs font-semibold tracking-wide text-teal-700">{eyebrow}</div>}
                {title && (
                  <h1 id={titleId} className="break-words text-xl font-bold leading-tight tracking-tight text-slate-950 sm:text-2xl">
                    {title}
                  </h1>
                )}
                {description && (
                  <div id={descId} className="mt-1 max-w-4xl text-sm font-normal leading-6 text-slate-600 sm:text-[15px]">
                    {description}
                  </div>
                )}
              </div>
            </div>
          </header>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            <main className={cn("full-page-flow-content mx-auto w-full", width)}>{children}</main>
          </div>

          {footer && (
            <footer className="shrink-0 border-t border-slate-200 bg-white/95 px-4 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(15,23,42,0.05)] backdrop-blur sm:px-6 lg:px-8">
              <div
                className={cn(
                  "mx-auto grid w-full grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end [&>a]:w-full [&>button]:w-full sm:[&>a]:w-auto sm:[&>button]:w-auto",
                  width,
                )}
              >
                {footer}
              </div>
            </footer>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
