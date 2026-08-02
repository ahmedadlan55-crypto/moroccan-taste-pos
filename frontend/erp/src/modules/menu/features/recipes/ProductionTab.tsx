/**
 * Recipe detail · PRODUCTION & WASTE tab.
 *
 * The ONE reason this tab exists as its own screen: "expected recipe loss" and
 * "actual production scrap" are two different numbers that people routinely
 * conflate, and conflating them corrupts both the standard cost and the variance
 * report. They are stated here side by side, each with its owner and its effect,
 * so a user cannot mistake one for the other.
 *
 * The rest of the tab is the joint-output picture (primary / co-product /
 * by-product / rework / scrap) and the consumption warehouse.
 */
import { AlertTriangle, Factory } from "lucide-react";
import { Badge, Select } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { TableShell, Td, Th, Thead, Tr } from "@/shared/tables";
import { formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import type { RecipeOutput, WarehouseOption } from "@/modules/menu/recipesApi";
import { allocMethodLabel, bizName, outputTypeLabel } from "./labels";
import { grossBaseQuantity, type DraftLine } from "./draft";

export interface ProductionTabProps {
  lines: DraftLine[];
  outputs: RecipeOutput[];
  consumptionWarehouseId: string;
  onWarehouseChange: (id: string) => void;
  warehouses: WarehouseOption[];
  canEdit: boolean;
}

export function ProductionTab({
  lines,
  outputs,
  consumptionWarehouseId,
  onWarehouseChange,
  warehouses,
  canEdit,
}: ProductionTabProps) {
  const t = useT();
  const lang = useLang();
  const dash = t("recipes.dash");

  const totalExpectedLoss = lines.reduce((sum, l) => {
    const net = (Number(l.quantity) || 0) * (Number(l.conversionFactor) || 1);
    return sum + (grossBaseQuantity(l) - net);
  }, 0);

  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.production.title")}</h2>
        <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.production.subtitle")}</p>
      </header>

      {/* The distinction, stated once and unmistakably. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <article className="surface space-y-2 p-4">
          <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <Factory className="h-4 w-4 text-teal-600" aria-hidden="true" />
            {t("recipes.detail.production.expectedLoss")}
          </h3>
          <p className="text-sm font-normal leading-6 text-slate-600">
            {t("recipes.detail.production.expectedLossBody")}
          </p>
          <p className="text-xs font-bold text-slate-500">
            {t("recipes.detail.production.totalExpectedLoss")}
            {": "}
            <span dir="ltr" className="tabular-nums">
              {formatNumber(totalExpectedLoss)}
            </span>
          </p>
        </article>
        <article className="surface space-y-2 p-4">
          <h3 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
            {t("recipes.detail.production.actualScrap")}
          </h3>
          <p className="text-sm font-normal leading-6 text-slate-600">
            {t("recipes.detail.production.actualScrapBody")}
          </p>
        </article>
      </div>

      <div className="surface p-4">
        <Field
          label={t("recipes.detail.production.consumptionWarehouse")}
          hint={t("recipes.detail.production.consumptionWarehouseHint")}
          className="max-w-md"
        >
          {({ id }) => (
            <Select
              id={id}
              className="h-11 w-full"
              value={consumptionWarehouseId}
              disabled={!canEdit}
              onChange={(e) => onWarehouseChange(e.target.value)}
            >
              <option value="">{t("recipes.detail.production.defaultWarehouse")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="surface overflow-hidden">
        <div className="flex flex-col gap-1 border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-bold text-slate-900">{t("recipes.detail.production.outputs")}</h3>
          <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.production.outputsHint")}</p>
        </div>
        {outputs.length === 0 ? (
          <div data-state="empty" className="grid place-items-center p-8 text-center">
            <p className="text-sm font-medium text-slate-500">{t("recipes.detail.production.noOutputs")}</p>
          </div>
        ) : (
          <TableShell>
            <Thead>
              <tr>
                <Th>{t("recipes.detail.production.outputType")}</Th>
                <Th>{t("recipes.detail.production.outputProduct")}</Th>
                <Th numeric>{t("recipes.detail.production.outputQty")}</Th>
                <Th>{t("recipes.detail.production.allocMethod")}</Th>
                <Th>{t("recipes.detail.production.warehouse")}</Th>
                <Th>{t("recipes.detail.production.requiresLot")}</Th>
              </tr>
            </Thead>
            <tbody>
              {outputs.map((o) => (
                <Tr key={o.id}>
                  <Td>
                    <Badge tone={o.outputType === "primary" ? "teal" : "neutral"}>{outputTypeLabel(t, o.outputType)}</Badge>
                  </Td>
                  <Td>{bizName(lang, o.productName, o.productNameEn) || o.productId}</Td>
                  <Td numeric>{formatNumber(o.quantity)}</Td>
                  <Td>{allocMethodLabel(t, o.allocMethod)}</Td>
                  <Td>{o.warehouseName || dash}</Td>
                  <Td>{o.requiresLot ? t("recipes.detail.production.yes") : t("recipes.detail.production.no")}</Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </div>
    </section>
  );
}
