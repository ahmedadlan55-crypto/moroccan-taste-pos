/**
 * Recipe detail · OVERVIEW tab — the recipe HEADER (yield, effective period,
 * notes, review flag) plus the read-only audit stamps.
 *
 * Yield is a hard business input, not decoration: the server divides the batch
 * cost by it, so a zeroed yield is rejected rather than silently coerced to 1
 * (which is exactly what the two legacy writers used to do).
 */
import { Checkbox, DatePicker, Input, NumberInput } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { formatCurrency, formatDateTime, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import type { RecipeDetail, RecipeProduct } from "@/modules/menu/recipesApi";
import type { DraftHeader } from "./draft";

export interface OverviewTabProps {
  header: DraftHeader;
  onChange: (patch: Partial<DraftHeader>) => void;
  recipe: RecipeDetail | null;
  product: RecipeProduct | null;
  lineCount: number;
  canEdit: boolean;
  canViewCost: boolean;
}

export function OverviewTab({ header, onChange, recipe, product, lineCount, canEdit, canViewCost }: OverviewTabProps) {
  const t = useT();
  const dash = t("recipes.dash");

  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.overview.title")}</h2>
        <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.overview.subtitle")}</p>
      </header>

      <div className="surface grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label={t("recipes.detail.overview.yieldQuantity")} required>
          {({ id }) => (
            <NumberInput
              id={id}
              className="h-11 w-full"
              value={header.yieldQuantity}
              min={0}
              disabled={!canEdit}
              onChange={(v) => onChange({ yieldQuantity: v ?? 0 })}
            />
          )}
        </Field>
        <Field label={t("recipes.detail.overview.yieldUnit")}>
          {({ id }) => (
            <Input
              id={id}
              className="h-11 w-full"
              value={header.yieldUnit}
              disabled={!canEdit}
              onChange={(e) => onChange({ yieldUnit: e.target.value })}
            />
          )}
        </Field>
        <Field label={t("recipes.detail.overview.lineCount")}>
          <div dir="ltr" className="field flex h-11 items-center bg-slate-50 tabular-nums text-slate-600">
            {formatNumber(lineCount)}
          </div>
        </Field>
        <Field label={t("recipes.detail.overview.effectiveFrom")}>
          {({ id }) => (
            <DatePicker
              id={id}
              className="h-11 w-full"
              value={header.effectiveFrom}
              disabled={!canEdit}
              onChange={(v) => onChange({ effectiveFrom: v })}
            />
          )}
        </Field>
        <Field label={t("recipes.detail.overview.effectiveTo")}>
          {({ id }) => (
            <DatePicker
              id={id}
              className="h-11 w-full"
              value={header.effectiveTo}
              disabled={!canEdit}
              onChange={(v) => onChange({ effectiveTo: v })}
            />
          )}
        </Field>
        <Field label={t("recipes.detail.overview.productUnit")}>
          <div className="field flex h-11 items-center bg-slate-50 text-slate-600">{product?.unit || dash}</div>
        </Field>
        {canViewCost && (
          <Field label={t("recipes.detail.overview.sellingPrice")}>
            <div dir="ltr" className="field flex h-11 items-center bg-slate-50 tabular-nums text-slate-600">
              {product?.sellingPrice == null ? dash : formatCurrency(product.sellingPrice)}
            </div>
          </Field>
        )}
        <Field label={t("recipes.detail.overview.notes")} className="sm:col-span-2 xl:col-span-3">
          {({ id }) => (
            <textarea
              id={id}
              className="field min-h-24 w-full py-2"
              rows={3}
              value={header.notes}
              disabled={!canEdit}
              placeholder={t("recipes.detail.overview.notesPlaceholder")}
              onChange={(e) => onChange({ notes: e.target.value })}
            />
          )}
        </Field>
        <div className="sm:col-span-2 xl:col-span-3">
          <Checkbox
            checked={header.needsReview}
            disabled={!canEdit}
            onChange={(e) => onChange({ needsReview: e.target.checked })}
            label={t("recipes.detail.overview.needsReview")}
          />
          <p className="mt-1 text-xs font-normal leading-5 text-slate-500">
            {t("recipes.detail.overview.needsReviewHint")}
          </p>
        </div>
      </div>

      {recipe && (
        <dl className="surface grid gap-4 p-4 text-sm sm:grid-cols-3">
          <Stamp
            label={t("recipes.detail.overview.createdBy")}
            who={recipe.createdBy}
            when={recipe.createdAt}
            atLabel={t("recipes.detail.overview.at")}
            unknown={t("recipes.detail.overview.unknown")}
          />
          <Stamp
            label={t("recipes.detail.overview.updatedBy")}
            who={recipe.updatedBy}
            when={recipe.updatedAt}
            atLabel={t("recipes.detail.overview.at")}
            unknown={t("recipes.detail.overview.unknown")}
          />
          <Stamp
            label={t("recipes.detail.overview.approvedBy")}
            who={recipe.approvedBy}
            when={recipe.approvedAt}
            atLabel={t("recipes.detail.overview.at")}
            unknown={t("recipes.detail.overview.unknown")}
          />
        </dl>
      )}
    </section>
  );
}

function Stamp({
  label,
  who,
  when,
  atLabel,
  unknown,
}: {
  label: string;
  who: string | null;
  when: string | null;
  atLabel: string;
  unknown: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-slate-800">
        {who || unknown}
        {when && (
          <span className="block text-xs font-medium text-slate-400">
            {atLabel} {formatDateTime(when)}
          </span>
        )}
      </dd>
    </div>
  );
}
