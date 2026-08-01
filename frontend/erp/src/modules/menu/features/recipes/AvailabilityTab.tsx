/**
 * Recipe detail · WAREHOUSE AVAILABILITY tab.
 *
 * Answers the only question a kitchen actually asks: how many batches can I make
 * right now, and which component is stopping me. Availability is computed by the
 * server against a chosen warehouse (or global stock when none is chosen) —
 * never in the browser, which cannot see warehouse_stock.
 *
 * A recipe that was never saved has no bomId, so there is nothing to compute
 * against; that is stated, not rendered as an error.
 */
import { Boxes, PackageCheck, PackageX } from "lucide-react";
import { Badge, MetricCard, NumberInput, Select } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field } from "@/shared/forms";
import { formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import { useAvailability, type AvailabilityItem, type WarehouseOption } from "@/modules/menu/recipesApi";
import { bizName } from "./labels";

export interface AvailabilityTabProps {
  bomId: string | null;
  warehouses: WarehouseOption[];
  warehouseId: string;
  onWarehouseChange: (id: string) => void;
  batches: number;
  onBatchesChange: (n: number) => void;
}

export function AvailabilityTab(props: AvailabilityTabProps) {
  const { bomId, warehouses, warehouseId, onWarehouseChange, batches, onBatchesChange } = props;
  const t = useT();
  const lang = useLang();
  const query = useAvailability(bomId, warehouseId, batches);
  const data = query.data ?? null;

  const columns: ColumnDef<AvailabilityItem>[] = [
    {
      id: "item",
      header: t("recipes.detail.availability.col.item"),
      accessor: (r) => r.itemName,
      hideable: false,
      cell: (r) => <span className="font-extrabold text-slate-900">{bizName(lang, r.itemName, r.itemNameEn)}</span>,
    },
    {
      id: "nameEn",
      header: t("recipes.detail.availability.col.nameEn"),
      accessor: (r) => r.itemNameEn,
      cell: (r) =>
        r.itemNameEn ? (
          <span dir="ltr" className="text-slate-700">
            {r.itemNameEn}
          </span>
        ) : (
          t("recipes.dash")
        ),
    },
    { id: "unit", header: t("recipes.detail.availability.col.unit"), accessor: (r) => r.unit || t("recipes.dash") },
    {
      id: "required",
      header: t("recipes.detail.availability.col.required"),
      numeric: true,
      accessor: (r) => r.required,
      cell: (r) => formatNumber(r.required),
    },
    {
      id: "available",
      header: t("recipes.detail.availability.col.available"),
      numeric: true,
      accessor: (r) => r.available,
      cell: (r) => formatNumber(r.available),
    },
    {
      id: "delta",
      header: t("recipes.detail.availability.col.delta"),
      numeric: true,
      accessor: (r) => r.delta,
      cellTone: (r) => (r.delta < 0 ? "negative" : "positive"),
      cell: (r) => formatNumber(r.delta),
    },
    {
      id: "status",
      header: t("recipes.detail.availability.col.status"),
      hideable: false,
      accessor: (r) => r.status,
      cell: (r) => (
        <Badge tone={r.status === "ok" ? "success" : "danger"}>
          {r.status === "ok" ? t("recipes.detail.availability.ok") : t("recipes.detail.availability.short")}
        </Badge>
      ),
    },
  ];

  if (!bomId) {
    return (
      <div data-state="empty" className="surface grid place-items-center p-10 text-center">
        <p className="text-sm font-semibold text-slate-500">{t("recipes.detail.availability.needRecipe")}</p>
      </div>
    );
  }

  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.availability.title")}</h2>
        <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.availability.subtitle")}</p>
      </header>

      <div className="surface grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label={t("recipes.detail.availability.warehouse")}>
          {({ id }) => (
            <Select id={id} className="h-11 w-full" value={warehouseId} onChange={(e) => onWarehouseChange(e.target.value)}>
              <option value="">{t("recipes.detail.availability.globalStock")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("recipes.detail.availability.batches")}>
          {({ id }) => (
            <NumberInput
              id={id}
              className="h-11 w-full"
              min={0}
              value={batches}
              onChange={(v) => onBatchesChange(v && v > 0 ? v : 1)}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label={t("recipes.detail.availability.makeableBatches")}
          value={formatNumber(data?.summary.makeableBatches ?? 0)}
          icon={Boxes}
          tone="blue"
        />
        <MetricCard
          label={t("recipes.detail.availability.makeableQuantity")}
          value={formatNumber(data?.summary.makeableQuantity ?? 0)}
          icon={PackageCheck}
          tone="teal"
        />
        <MetricCard
          label={t("recipes.detail.availability.shortages")}
          value={formatNumber(data?.summary.shortageCount ?? 0)}
          note={data?.summary.allAvailable ? t("recipes.detail.availability.allAvailable") : undefined}
          icon={PackageX}
          tone={data?.summary.shortageCount ? "rose" : "teal"}
        />
      </div>

      <DataTable<AvailabilityItem>
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(r) => r.itemId}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("recipes.detail.availability.empty")}
        mobileTitle={(r) => bizName(lang, r.itemName, r.itemNameEn)}
      />
    </section>
  );
}
