import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from "@/shared/ui";
import { useDebouncedValue } from "@/modules/inventory/lib/hooks/useDebouncedValue";
import { formatNumber, formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import type { BomPickOption } from "../../lib/batchApi";
import { useBomOptions } from "../../lib/useBatches";

/** Recipes rendered per page. The catalogue is NEVER dumped into the DOM at
 *  once — the query is debounced and only this window is mounted. */
const PAGE_SIZE = 8;
/** Server-side cap on GET /production-orders/boms (LIMIT 300). Surfaced so a
 *  truncated result reads as "narrow your search", not as "that is all". */
const SERVER_CAP = 300;

/**
 * Debounced, paged recipe (BOM) picker. Rendered INLINE as a panel — never a
 * drawer or side sheet — so the create screen stays one full page.
 */
export function BomPicker({
  onPick,
  onClose,
}: {
  onPick: (bom: BomPickOption) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebouncedValue(query, 250);

  // A new search term always restarts at page 1 — paging into a window that no
  // longer exists is how a picker silently shows nothing.
  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const boms = useBomOptions(debounced);
  const rows = useMemo(() => boms.data ?? [], [boms.data]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const window_ = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4" aria-label={t("production.batch.create.pickerHeading")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-extrabold text-slate-800">{t("production.batch.create.pickerHeading")}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" /> {t("production.batch.create.pickerClose")}
        </Button>
      </div>

      <label className="relative mb-3 block">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 start-3" aria-hidden="true" />
        <input
          className="field w-full ps-10"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("production.batch.create.pickerSearchPlaceholder")}
          aria-label={t("production.batch.create.pickerSearchAria")}
        />
      </label>

      {boms.isLoading ? (
        <LoadingState rows={2} />
      ) : boms.isError ? (
        <ErrorState error={boms.error} onRetry={() => void boms.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t("production.batch.create.pickerEmptyTitle")}
          body={t("production.batch.create.pickerEmptyBody")}
        />
      ) : (
        <>
          <ul className="grid gap-2 md:grid-cols-2">
            {window_.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => onPick(b)}
                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-start transition hover:border-teal-400 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                >
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate font-extrabold text-slate-900">{b.productName}</span>
                    {b.trackingMode !== "none" && (
                      <StatusBadge>
                        {b.trackingMode === "expiry" ? t("production.wizard.trackExpiry") : t("production.wizard.trackLot")}
                      </StatusBadge>
                    )}
                  </span>
                  <span className="mt-1 block text-xs font-medium text-slate-500">
                    {t("production.wizard.bomYields", {
                      yield: formatQty(b.yieldQuantity, b.yieldUnit || b.productUnit),
                      count: formatNumber(b.lineCount),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-500">
              {t("production.batch.create.pickerPageLabel", {
                page: formatNumber(safePage),
                pages: formatNumber(totalPages),
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("table.prevPage")}
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("table.nextPage")}
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {rows.length >= SERVER_CAP && (
            <p className="mt-2 text-xs font-medium text-amber-700">
              {t("production.batch.create.pickerCap", { count: formatNumber(SERVER_CAP) })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
