import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { formatNumber } from "@/shared/lib";
import { useTx } from "@/shared/ui/i18n";

export interface BulkActionBarProps {
  count: number;
  onClear: () => void;
  children?: ReactNode;
  /** Noun for the selected items, e.g. "عنصر" / "فاتورة". */
  itemNoun?: string;
}

/**
 * Floating action bar shown while rows are selected. Sticks to the bottom of the
 * viewport, announces the selection count, and hosts the bulk-action buttons.
 */
export function BulkActionBar({ count, onClear, children, itemNoun }: BulkActionBarProps) {
  const t = useTx();
  const noun = itemNoun ?? t("table.itemNoun");
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ type: "spring", damping: 26, stiffness: 320 }}
          role="region"
          aria-label={t("table.bulkActions")}
          className="fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-drawer mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-lift lg:bottom-4 lg:w-fit lg:flex-nowrap lg:gap-3 lg:px-4"
        >
          <button
            type="button"
            onClick={onClear}
            aria-label={t("table.clearSelection")}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            <X className="h-4 w-4" />
          </button>
          <span className="text-sm font-extrabold text-slate-800">
            <span dir="ltr" className="tabular-nums">
              {formatNumber(count)}
            </span>{" "}
            {noun} {t("table.selectedSuffix")}
          </span>
          <div className="ms-auto flex min-w-0 flex-wrap items-center gap-2">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
