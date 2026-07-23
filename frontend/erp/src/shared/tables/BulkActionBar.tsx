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
          className="fixed inset-x-0 bottom-4 z-drawer mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-lift"
        >
          <button
            type="button"
            onClick={onClear}
            aria-label={t("table.clearSelection")}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            <X className="h-4 w-4" />
          </button>
          <span className="text-sm font-extrabold text-slate-800">
            <span dir="ltr" className="tabular-nums">
              {formatNumber(count)}
            </span>{" "}
            {noun} {t("table.selectedSuffix")}
          </span>
          <div className="flex items-center gap-2">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
