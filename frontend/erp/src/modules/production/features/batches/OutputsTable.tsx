import type { ReactNode } from "react";
import { Package, Trash2, TriangleAlert } from "lucide-react";
import { Button, DatePicker, EmptyState, NumberInput, Select, StatusBadge } from "@/shared/ui";
import { formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import type { BatchLineError, BomPickOption } from "../../lib/batchApi";

/** ONE product the document will produce. `key` is a client-only stable id —
 *  the SERVER identifies a row by its zero-based index (`detail[].line`), which
 *  is why the array order is the single source of truth for error mapping. */
export interface OutputRow {
  key: string;
  bom: BomPickOption | null;
  qtyPlanned: number | null;
  /** "" → inherit the document's default output warehouse. */
  outputWarehouseId: string;
  batchNumber: string;
  /** Planning value only — see BatchItemInput.expiryDate. */
  expiryDate: string;
  /**
   * null → use the default scrap policy. 0 → ZERO scrap allowed (any waste is
   * gated behind a manager override with a recorded reason). An untouched field
   * must stay null; it must NEVER fall back to 0.
   */
  allowedScrapPct: number | null;
}

export interface WarehouseOption {
  id: string;
  name: string;
}

const GRID = "lg:grid lg:grid-cols-12 lg:items-start lg:gap-2";

/**
 * One field cell. The caption is a plain span (never a <label>): every control
 * below already carries its own product-qualified aria-label, and a second,
 * unassociated <label> would just add a dangling one. `min-w-0` is load-bearing
 * — a grid item defaults to min-width:auto, and an <input>'s intrinsic width
 * would push the row past the viewport at 1024px.
 */
function Cell({ label, span, children }: { label: string; span: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${span}`}>
      <span className="mb-1 block text-xs font-bold text-slate-500 lg:sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * The Outputs table: several INDEPENDENT products in one document. Renders as a
 * real column grid from `lg` up and as labelled stacked cards below it, so the
 * page never scrolls sideways at 390px.
 */
export function OutputsTable({
  rows,
  warehouses,
  defaultOutputWarehouseLabel,
  lineErrors,
  onPatch,
  onRemove,
  onPickProduct,
}: {
  rows: OutputRow[];
  warehouses: WarehouseOption[];
  defaultOutputWarehouseLabel: string;
  /** zero-based row index → the messages the SERVER rejected that row with. */
  lineErrors: Map<number, BatchLineError[]>;
  onPatch: (key: string, patch: Partial<OutputRow>) => void;
  onRemove: (key: string) => void;
  onPickProduct: (key: string) => void;
}) {
  const t = useT();

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Package className="h-6 w-6" />}
        title={t("production.batch.create.noRowsTitle")}
        body={t("production.batch.create.noRowsBody")}
      />
    );
  }

  return (
    <div>
      {/* Column headers — only where the grid is actually a table. */}
      <div className={`hidden ${GRID} border-b border-slate-200 pb-2 text-xs font-extrabold text-slate-500`}>
        <span className="lg:col-span-3">{t("production.batch.create.col.product")}</span>
        <span className="lg:col-span-1">{t("production.batch.create.col.version")}</span>
        <span className="lg:col-span-1">{t("production.batch.create.col.qty")}</span>
        <span className="lg:col-span-1">{t("production.batch.create.col.unit")}</span>
        <span className="lg:col-span-2">{t("production.batch.create.col.outputWarehouse")}</span>
        <span className="lg:col-span-1">{t("production.batch.create.col.lot")}</span>
        <span className="lg:col-span-1">{t("production.batch.create.col.expiry")}</span>
        <span className="lg:col-span-1">{t("production.batch.create.col.scrap")}</span>
        <span className="lg:col-span-1 lg:text-end">{t("production.batch.create.col.remove")}</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {rows.map((row, index) => {
          const errs = lineErrors.get(index) ?? [];
          const tracked = !!row.bom && row.bom.trackingMode !== "none";
          const expiryTracked = row.bom?.trackingMode === "expiry";
          const unit = row.bom?.yieldUnit || row.bom?.productUnit || "";
          return (
            <li
              key={row.key}
              data-row-index={index}
              aria-label={t("production.batch.create.rowAria", { line: formatNumber(index + 1) })}
              className={`grid gap-3 py-4 ${GRID} ${errs.length ? "bg-rose-50/60" : ""}`}
            >
              <Cell span="lg:col-span-3" label={t("production.batch.create.col.product")}>
                <button
                  type="button"
                  onClick={() => onPickProduct(row.key)}
                  className="w-full rounded-xl border border-slate-200 bg-white p-2.5 text-start transition hover:border-teal-400 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                >
                  <span className="block truncate text-sm font-extrabold text-slate-900">
                    {row.bom ? row.bom.productName : t("production.batch.create.validation.bomRequired")}
                  </span>
                  <span className="mt-0.5 block text-[11px] font-bold text-teal-700">
                    {row.bom ? t("production.batch.create.changeProduct") : t("production.batch.create.addProduct")}
                  </span>
                </button>
              </Cell>

              <Cell span="lg:col-span-1" label={t("production.batch.create.col.version")}>
                <div className="min-h-11 rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-bold tabular-nums text-slate-700">
                  {row.bom?.version != null ? `v${formatNumber(row.bom.version)}` : "—"}
                </div>
              </Cell>

              <Cell span="lg:col-span-1" label={t("production.batch.create.col.qty")}>
                <NumberInput
                  className="w-full"
                  min={0}
                  step="any"
                  value={row.qtyPlanned}
                  onChange={(v) => onPatch(row.key, { qtyPlanned: v })}
                  aria-label={`${t("production.batch.create.col.qty")} — ${row.bom?.productName ?? formatNumber(index + 1)}`}
                />
              </Cell>

              <Cell span="lg:col-span-1" label={t("production.batch.create.col.unit")}>
                <div className="min-h-11 rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-bold text-slate-700">
                  {unit || t("production.batch.create.unitFallback")}
                </div>
              </Cell>

              <Cell span="lg:col-span-2" label={t("production.batch.create.col.outputWarehouse")}>
                <Select
                  className="w-full"
                  value={row.outputWarehouseId}
                  onChange={(e) => onPatch(row.key, { outputWarehouseId: e.target.value })}
                  aria-label={`${t("production.batch.create.col.outputWarehouse")} — ${row.bom?.productName ?? formatNumber(index + 1)}`}
                >
                  <option value="">{defaultOutputWarehouseLabel}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Cell>

              <Cell span="lg:col-span-1" label={t("production.batch.create.col.lot")}>
                {tracked ? (
                  <input
                    className="field w-full py-2"
                    value={row.batchNumber}
                    onChange={(e) => onPatch(row.key, { batchNumber: e.target.value })}
                    aria-label={`${t("production.batch.create.col.lot")} — ${row.bom?.productName ?? formatNumber(index + 1)}`}
                  />
                ) : (
                  <div className="min-h-11 rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-400">
                    {t("production.batch.create.notTracked")}
                  </div>
                )}
              </Cell>

              <Cell span="lg:col-span-1" label={t("production.batch.create.col.expiry")}>
                {expiryTracked ? (
                  <DatePicker
                    value={row.expiryDate}
                    onChange={(v) => onPatch(row.key, { expiryDate: v })}
                    aria-label={`${t("production.batch.create.col.expiry")} — ${row.bom?.productName ?? formatNumber(index + 1)}`}
                    title={t("production.batch.create.expiryHint")}
                  />
                ) : (
                  <div className="min-h-11 rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-400">
                    {t("production.batch.create.notTracked")}
                  </div>
                )}
              </Cell>

              <Cell span="lg:col-span-1" label={t("production.batch.create.col.scrap")}>
                <NumberInput
                  className="w-full"
                  min={0}
                  max={100}
                  step="any"
                  value={row.allowedScrapPct}
                  onChange={(v) => onPatch(row.key, { allowedScrapPct: v })}
                  aria-label={`${t("production.batch.create.col.scrap")} — ${row.bom?.productName ?? formatNumber(index + 1)}`}
                />
                <span className="mt-1 block">
                  <StatusBadge>
                    {row.allowedScrapPct === null
                      ? t("production.batch.create.scrapDefaultBadge")
                      : row.allowedScrapPct === 0
                        ? t("production.batch.create.scrapZeroBadge")
                        : `${formatNumber(row.allowedScrapPct)}%`}
                  </StatusBadge>
                </span>
              </Cell>

              <div className="min-w-0 lg:col-span-1 lg:text-end">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-rose-600 hover:bg-rose-50"
                  onClick={() => onRemove(row.key)}
                  aria-label={t("production.batch.create.removeRow", { line: formatNumber(index + 1) })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>

              {errs.length > 0 && (
                <div className="lg:col-span-12">
                  <p className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                    <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="rounded-md bg-rose-100 px-1.5 py-0.5">
                      {t("production.batch.create.lineBadge", { line: formatNumber(index + 1) })}
                    </span>
                    {errs.map((e, i) => (
                      <span key={`${e.code}-${i}`}>{e.message}</span>
                    ))}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
