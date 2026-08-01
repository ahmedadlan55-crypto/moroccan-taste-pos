import { Check, TriangleAlert } from "lucide-react";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { StatusBadge } from "@/shared/ui";
import { useLotList } from "@/modules/inventory/lib/hooks/useLots";
import { formatCurrency, formatDate, formatNumber, formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import type { BatchPreview, PreviewMaterial } from "../../lib/batchApi";

/** FEFO suggestions shown per tracked material. */
const LOT_SUGGESTIONS = 3;

/**
 * FEFO lot suggestions for ONE tracked material. Mounted only for tracked rows,
 * so an untracked plan issues no lot queries at all. The lots endpoint already
 * orders by expiry (FEFO), so the first page IS the suggestion.
 */
function SuggestedLots({ itemId, warehouseId }: { itemId: string; warehouseId: string }) {
  const t = useT();
  const lots = useLotList({ itemId, warehouseId, pageSize: LOT_SUGGESTIONS });
  if (lots.isLoading || lots.isError) return null;
  const rows = lots.data?.rows ?? [];
  return (
    <div className="mt-1.5 rounded-lg bg-slate-50 px-2 py-1.5">
      <div className="text-[10px] font-extrabold text-slate-400">{t("production.batch.create.suggestedLotsHeading")}</div>
      {rows.length === 0 ? (
        <div className="text-[11px] font-medium text-slate-400">{t("production.batch.create.suggestedLotsEmpty")}</div>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {rows.map((l) => (
            <li key={l.id} className="text-[11px] font-bold text-slate-600">
              {t("production.batch.create.suggestedLotLine", {
                lot: l.lotNumber || l.id,
                qty: formatQty(l.totalQty),
                expiry: formatDate(l.expiryDate),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The consolidated material demand: each material ONCE, with its total
 * requirement AND the per-product attribution the backend computed. A shortage
 * WARNS — it never blocks the draft (same contract as the single-order flow).
 */
export function MaterialsPreview({
  preview,
  loading,
  error,
  onRetry,
  productLabel,
  idleMessage,
}: {
  preview: BatchPreview | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** zero-based row index → the product name the user typed it as. */
  productLabel: (line: number) => string;
  /** Set only while there is nothing to preview yet (no complete row). */
  idleMessage?: string;
}) {
  const t = useT();

  // IDLE is not "an empty result" — nothing was asked for yet. Rendering the
  // table's EmptyState here would claim the server answered with no materials.
  if (idleMessage) {
    return (
      <div className="surface p-6 text-center text-sm font-medium text-slate-500" data-state="idle">
        {idleMessage}
      </div>
    );
  }

  const columns: ColumnDef<PreviewMaterial>[] = [
    {
      id: "material",
      header: t("production.batch.create.materialsCol.material"),
      accessor: (r) => r.itemName,
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-extrabold text-slate-800">{r.itemName}</span>
            {r.trackingMode !== "none" && <StatusBadge>{t("production.batch.create.trackedBadge")}</StatusBadge>}
          </div>
          {r.trackingMode !== "none" && <SuggestedLots itemId={r.itemId} warehouseId={r.warehouseId} />}
        </div>
      ),
      priority: 1,
    },
    {
      id: "required",
      header: t("production.batch.create.materialsCol.required"),
      accessor: (r) => r.required,
      cell: (r) => formatQty(r.required, r.unit),
      numeric: true,
      sortable: true,
      priority: 2,
    },
    {
      id: "available",
      header: t("production.batch.create.materialsCol.available"),
      accessor: (r) => r.available,
      cell: (r) => formatQty(r.available),
      numeric: true,
      sortable: true,
      priority: 3,
    },
    {
      id: "delta",
      header: t("production.batch.create.materialsCol.delta"),
      accessor: (r) => r.delta,
      cell: (r) => `${r.delta > 0 ? "+" : ""}${formatQty(r.delta)}`,
      cellTone: (r) => (r.status === "short" ? "negative" : "positive"),
      numeric: true,
      sortable: true,
      priority: 4,
    },
    {
      id: "unitCost",
      header: t("production.batch.create.materialsCol.unitCost"),
      accessor: (r) => r.unitCost,
      cell: (r) => formatCurrency(r.unitCost),
      numeric: true,
      defaultHidden: true,
    },
    {
      id: "lineCost",
      header: t("production.batch.create.materialsCol.lineCost"),
      accessor: (r) => r.lineCost,
      cell: (r) => formatCurrency(r.lineCost),
      numeric: true,
      sortable: true,
    },
    {
      id: "attribution",
      header: t("production.batch.create.materialsCol.attribution"),
      // Exported/searchable as a flat string; rendered as one line per product.
      accessor: (r) =>
        r.attribution.map((a) => `${productLabel(a.line)}: ${formatQty(a.qty)}`).join(" · "),
      cell: (r) => (
        <ul className="space-y-0.5">
          {r.attribution.map((a, i) => (
            <li key={`${a.bomId}-${a.line}-${i}`} className="text-xs font-bold text-slate-600">
              {t("production.batch.create.attributionLine", {
                product: productLabel(a.line),
                qty: formatQty(a.qty, r.unit),
              })}
            </li>
          ))}
        </ul>
      ),
    },
  ];

  const summary = preview?.summary;

  return (
    <div className="space-y-3">
      {summary && (
        <div
          className={`flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm font-bold ${
            summary.allAvailable
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
          data-shortage={summary.allAvailable ? "none" : String(summary.shortageCount)}
        >
          {summary.allAvailable ? (
            <>
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("production.batch.create.previewAllAvailable", {
                value: formatCurrency(summary.totalMaterialCost),
              })}
            </>
          ) : (
            <>
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("production.batch.create.previewShortage", { count: formatNumber(summary.shortageCount) })}
            </>
          )}
          <span className="text-xs font-medium">
            {t("production.batch.create.previewCounts", {
              products: formatNumber(summary.productCount),
              materials: formatNumber(summary.materialCount),
            })}
          </span>
        </div>
      )}

      <DataTable<PreviewMaterial>
        columns={columns}
        rows={preview?.materials ?? []}
        getRowId={(r) => `${r.itemId}|${r.warehouseId}`}
        loading={loading}
        error={error}
        onRetry={onRetry}
        paginate={false}
        columnMenu={false}
        tableId="production-batch-preview"
        mobileTitle={(r) => r.itemName}
        emptyTitle={t("production.batch.create.previewIdle")}
      />
    </div>
  );
}
