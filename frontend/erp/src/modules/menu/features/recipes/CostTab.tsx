/**
 * Recipe detail · COST tab.
 *
 * Every figure here is the SERVER's, computed from component costs inside the
 * same read. The client never sends a cost and never derives the authoritative
 * one — the unsaved-edit preview below the cards is explicitly labelled as the
 * live draft, not as the stored cost.
 *
 * When cost is denied the panel says so. It does NOT render zeros: a fabricated
 * zero is indistinguishable from a real one, and someone will budget against it.
 */
import { Badge, MetricCard } from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { Coins, Percent, Receipt, TrendingUp } from "lucide-react";
import { formatCurrency, formatDateTime } from "@/shared/lib";
import { useT } from "@/i18n";
import type { RecipeCost } from "@/modules/menu/recipesApi";
import { anomalyLabel, formatPct } from "./labels";

export interface CostTabProps {
  cost: RecipeCost | null;
  canViewCost: boolean;
  hasRecipe: boolean;
  /** Live batch cost of the UNSAVED draft (null when a component has no cost). */
  draftBatchCost: number | null;
  draftUnitCost: number | null;
  dirty: boolean;
}

export function CostTab({ cost, canViewCost, hasRecipe, draftBatchCost, draftUnitCost, dirty }: CostTabProps) {
  const t = useT();

  if (!canViewCost) {
    return <HiddenPanel />;
  }

  return (
    <Can cap="menu.cost.view" fallback={<HiddenPanel />}>
      <section className="min-w-0 space-y-4">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.cost.title")}</h2>
          <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.cost.subtitle")}</p>
        </header>

        {!hasRecipe || !cost ? (
          <div data-state="empty" className="surface grid place-items-center p-10 text-center">
            <p className="text-sm font-semibold text-slate-500">{t("recipes.detail.cost.noRecipe")}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label={t("recipes.detail.cost.batchCost")}
                value={formatCurrency(cost.batchCost)}
                icon={Receipt}
                tone="blue"
              />
              <MetricCard
                label={t("recipes.detail.cost.unitCost")}
                value={formatCurrency(cost.unitCost)}
                icon={Coins}
                tone="teal"
              />
              <MetricCard
                label={t("recipes.detail.cost.foodCostPct")}
                value={formatPct(cost.foodCostPct)}
                icon={Percent}
                tone="amber"
              />
              <MetricCard
                label={t("recipes.detail.cost.marginPct")}
                value={formatPct(cost.marginPct)}
                icon={TrendingUp}
                tone={cost.marginPct != null && cost.marginPct < 0 ? "rose" : "teal"}
              />
            </div>

            <dl className="surface grid gap-4 p-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-bold text-slate-500">{t("recipes.detail.cost.sellingPrice")}</dt>
                <dd dir="ltr" className="mt-1 text-sm font-extrabold tabular-nums text-slate-800">
                  {cost.sellingPrice == null ? t("recipes.dash") : formatCurrency(cost.sellingPrice)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold text-slate-500">{t("recipes.detail.cost.computedAt")}</dt>
                <dd className="mt-1 text-sm font-semibold text-slate-800">{formatDateTime(cost.computedAt)}</dd>
              </div>
              {dirty && (
                <div>
                  <dt className="text-xs font-bold text-amber-700">{t("recipes.detail.dirty")}</dt>
                  <dd dir="ltr" className="mt-1 text-sm font-extrabold tabular-nums text-amber-700">
                    {draftBatchCost == null ? t("recipes.dash") : formatCurrency(draftBatchCost)}
                    {draftUnitCost != null && <span className="block">{formatCurrency(draftUnitCost)}</span>}
                  </dd>
                </div>
              )}
            </dl>

            <div className="surface space-y-2 p-4">
              <h3 className="text-sm font-extrabold text-slate-800">{t("recipes.detail.cost.anomalies")}</h3>
              {cost.anomalies.length === 0 ? (
                <p className="text-sm font-medium text-slate-500">{t("recipes.detail.cost.noAnomalies")}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {cost.anomalies.map((a) => (
                    <li key={a}>
                      <Badge tone="danger">{anomalyLabel(t, a)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
    </Can>
  );
}

function HiddenPanel() {
  const t = useT();
  return (
    <div data-state="permission-denied" className="surface grid place-items-center gap-2 p-10 text-center">
      <div className="text-base font-extrabold text-slate-800">{t("recipes.detail.cost.hidden")}</div>
      <p className="max-w-md text-sm font-medium text-slate-500">{t("recipes.detail.cost.hiddenBody")}</p>
    </div>
  );
}
