import { Info } from "lucide-react";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { NumberInput } from "@/shared/ui";
import { formatCurrency, formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import type { BatchPreview } from "../../lib/batchApi";

export interface CostSplitRow {
  line: number;
  product: string;
  qty: number;
  unit: string;
  materials: number;
  labour: number;
  overhead: number;
  total: number;
  unitCost: number;
}

/**
 * Split the document's PLANNED conversion cost across its products in
 * proportion to each product's own material cost. A batch never pools cost —
 * this only distributes the two planning figures the user typed so each product
 * shows the cost it will actually carry. With no material cost anywhere the
 * split falls back to an equal share (never a divide-by-zero, never NaN).
 */
export function buildCostSplit(
  preview: BatchPreview | undefined,
  labour: number,
  overhead: number,
  describe: (line: number) => { product: string; unit: string },
): CostSplitRow[] {
  const products = preview?.products ?? [];
  if (products.length === 0) return [];
  const totalMaterials = products.reduce((s, p) => s + p.materialCost, 0);
  return products.map((p) => {
    const share = totalMaterials > 0 ? p.materialCost / totalMaterials : 1 / products.length;
    const lab = labour * share;
    const ovh = overhead * share;
    const total = p.materialCost + lab + ovh;
    const meta = describe(p.line);
    return {
      line: p.line,
      product: meta.product,
      qty: p.qtyPlanned,
      unit: meta.unit,
      materials: p.materialCost,
      labour: lab,
      overhead: ovh,
      total,
      unitCost: p.qtyPlanned > 0 ? total / p.qtyPlanned : 0,
    };
  });
}

/**
 * Materials + labour + overhead + WIP and the per-product cost split, shown
 * BEFORE approval. Labour/overhead are planning estimates: the batch create
 * endpoint does not store them — they are recorded per order when materials are
 * issued — and the note under the fields says exactly that.
 */
export function CostSummary({
  preview,
  labour,
  overhead,
  onLabourChange,
  onOverheadChange,
  describe,
}: {
  preview: BatchPreview | undefined;
  labour: number | null;
  overhead: number | null;
  onLabourChange: (v: number | null) => void;
  onOverheadChange: (v: number | null) => void;
  describe: (line: number) => { product: string; unit: string };
}) {
  const t = useT();
  const materials = preview?.summary.totalMaterialCost ?? 0;
  const lab = labour ?? 0;
  const ovh = overhead ?? 0;
  const wip = materials + lab + ovh;
  const rows = buildCostSplit(preview, lab, ovh, describe);

  const columns: ColumnDef<CostSplitRow>[] = [
    {
      id: "product",
      header: t("production.batch.create.costs.splitCol.product"),
      accessor: (r) => r.product,
      priority: 1,
    },
    {
      id: "qty",
      header: t("production.batch.create.costs.splitCol.qty"),
      accessor: (r) => r.qty,
      cell: (r) => formatQty(r.qty, r.unit),
      numeric: true,
      priority: 2,
    },
    {
      id: "materials",
      header: t("production.batch.create.costs.splitCol.materials"),
      accessor: (r) => r.materials,
      cell: (r) => formatCurrency(r.materials),
      numeric: true,
    },
    {
      id: "labour",
      header: t("production.batch.create.costs.splitCol.labour"),
      accessor: (r) => r.labour,
      cell: (r) => formatCurrency(r.labour),
      numeric: true,
    },
    {
      id: "overhead",
      header: t("production.batch.create.costs.splitCol.overhead"),
      accessor: (r) => r.overhead,
      cell: (r) => formatCurrency(r.overhead),
      numeric: true,
    },
    {
      id: "total",
      header: t("production.batch.create.costs.splitCol.total"),
      accessor: (r) => r.total,
      cell: (r) => formatCurrency(r.total),
      numeric: true,
      priority: 3,
    },
    {
      id: "unitCost",
      header: t("production.batch.create.costs.splitCol.unitCost"),
      accessor: (r) => r.unitCost,
      cell: (r) => formatCurrency(r.unitCost),
      numeric: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label={t("production.batch.create.costs.materials")} value={formatCurrency(materials)} />
        <label className="rounded-xl border border-slate-200 bg-white p-3">
          <span className="block text-[11px] font-bold text-slate-400">{t("production.batch.create.costs.labour")}</span>
          <NumberInput
            className="mt-1 w-full"
            min={0}
            step="any"
            value={labour}
            onChange={onLabourChange}
            aria-label={t("production.batch.create.costs.labourAria")}
          />
        </label>
        <label className="rounded-xl border border-slate-200 bg-white p-3">
          <span className="block text-[11px] font-bold text-slate-400">{t("production.batch.create.costs.overhead")}</span>
          <NumberInput
            className="mt-1 w-full"
            min={0}
            step="any"
            value={overhead}
            onChange={onOverheadChange}
            aria-label={t("production.batch.create.costs.overheadAria")}
          />
        </label>
        <Figure label={t("production.batch.create.costs.wip")} value={formatCurrency(wip)} strong />
      </div>

      <p className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs font-bold text-sky-800">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {t("production.batch.create.costs.plannedNote")}
      </p>

      <div>
        <h3 className="mb-2 text-sm font-extrabold text-slate-800">{t("production.batch.create.costs.splitHeading")}</h3>
        <p className="mb-2 text-xs font-medium text-slate-500">{t("production.batch.create.costs.splitNote")}</p>
        <DataTable<CostSplitRow>
          columns={columns}
          rows={rows}
          getRowId={(r) => String(r.line)}
          paginate={false}
          columnMenu={false}
          tableId="production-batch-cost-split"
          emptyTitle={t("production.batch.create.previewIdle")}
        />
      </div>
    </div>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${strong ? "border-teal-200 bg-teal-50" : "border-slate-200 bg-white"}`}>
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div
        className={`mt-1 text-lg font-extrabold tabular-nums ${strong ? "text-teal-800" : "text-slate-900"}`}
        dir="ltr"
      >
        {value}
      </div>
    </div>
  );
}
