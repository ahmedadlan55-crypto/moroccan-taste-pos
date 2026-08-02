/**
 * Recipe detail · WHERE-USED tab — the blast radius of changing a component.
 *
 * Scoped to a component chosen from THIS recipe, because that is the question
 * being asked here ("if I re-price or re-unit this ingredient, what else moves?").
 * The server also folds in rows from the legacy flat `recipe` table, which is why
 * a row can carry `origin: legacy_recipe` and no version — that is real data, not
 * a defect, so it is labelled rather than filtered out.
 */
import { Badge } from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Field } from "@/shared/forms";
import { Select } from "@/shared/ui";
import { formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import { useWhereUsed, type WhereUsedRow } from "@/modules/menu/recipesApi";
import { bizName, originLabel, statusLabel, statusTone } from "./labels";
import type { DraftLine } from "./draft";

export interface WhereUsedTabProps {
  lines: DraftLine[];
  selectedItemId: string;
  onSelect: (itemId: string) => void;
}

export function WhereUsedTab({ lines, selectedItemId, onSelect }: WhereUsedTabProps) {
  const t = useT();
  const lang = useLang();
  const itemId = selectedItemId || lines[0]?.componentItemId || "";
  const query = useWhereUsed(itemId || null);
  const data = query.data ?? null;
  const dash = t("recipes.dash");

  const columns: ColumnDef<WhereUsedRow>[] = [
    {
      id: "product",
      header: t("recipes.detail.whereUsed.col.product"),
      accessor: (r) => r.productName,
      hideable: false,
      cell: (r) => <span className="font-extrabold text-slate-900">{bizName(lang, r.productName, r.productNameEn)}</span>,
    },
    {
      id: "nameEn",
      header: t("recipes.detail.whereUsed.col.nameEn"),
      accessor: (r) => r.productNameEn,
      cell: (r) =>
        r.productNameEn ? (
          <span dir="ltr" className="text-slate-700">
            {r.productNameEn}
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "version",
      header: t("recipes.detail.whereUsed.col.version"),
      numeric: true,
      accessor: (r) => r.version ?? -1,
      cell: (r) => (r.version == null ? dash : formatNumber(r.version)),
    },
    {
      id: "status",
      header: t("recipes.detail.whereUsed.col.status"),
      accessor: (r) => r.status,
      cell: (r) =>
        r.status === "legacy" ? (
          <Badge tone="neutral">{t("recipes.detail.whereUsed.statusLegacy")}</Badge>
        ) : (
          <Badge tone={statusTone(r.status)}>{statusLabel(t, r.status)}</Badge>
        ),
    },
    {
      id: "quantity",
      header: t("recipes.detail.whereUsed.col.quantity"),
      numeric: true,
      accessor: (r) => r.baseQuantity,
      cell: (r) => formatNumber(r.baseQuantity),
    },
    {
      id: "wastePct",
      header: t("recipes.detail.whereUsed.col.wastePct"),
      numeric: true,
      accessor: (r) => r.wastePct,
      cell: (r) => formatNumber(r.wastePct),
    },
    { id: "unit", header: t("recipes.detail.whereUsed.col.unit"), accessor: (r) => r.unit || dash },
    {
      id: "origin",
      header: t("recipes.detail.whereUsed.col.origin"),
      accessor: (r) => r.origin,
      cell: (r) => originLabel(t, r.origin),
    },
  ];

  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.whereUsed.title")}</h2>
        <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.whereUsed.subtitle")}</p>
      </header>

      {lines.length === 0 ? (
        <div data-state="empty" className="surface grid place-items-center p-10 text-center">
          <p className="text-sm font-semibold text-slate-500">{t("recipes.detail.whereUsed.needComponent")}</p>
        </div>
      ) : (
        <>
          <div className="surface grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
            <Field label={t("recipes.detail.whereUsed.pick")}>
              {({ id }) => (
                <Select id={id} className="h-11 w-full" value={itemId} onChange={(e) => onSelect(e.target.value)}>
                  {lines.map((l) => (
                    <option key={l.key} value={l.componentItemId}>
                      {bizName(lang, l.itemName, l.itemNameEn)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex flex-col justify-center gap-1">
              <span className="text-xs font-bold text-slate-500">{t("recipes.detail.whereUsed.activeCount")}</span>
              <span dir="ltr" className="text-xl font-extrabold tabular-nums text-slate-900">
                {formatNumber(data?.activeCount ?? 0)}
              </span>
            </div>
            <div className="flex flex-col justify-center gap-1">
              <span className="text-xs font-bold text-slate-500">{t("recipes.detail.whereUsed.totalCount")}</span>
              <span dir="ltr" className="text-xl font-extrabold tabular-nums text-slate-900">
                {formatNumber(data?.totalCount ?? 0)}
              </span>
            </div>
          </div>

          <DataTable<WhereUsedRow>
            columns={columns}
            rows={data?.usedIn ?? []}
            getRowId={(r) => `${r.bomId ?? "legacy"}:${r.productSource}:${r.productId}`}
            loading={query.isLoading}
            error={query.isError ? query.error : undefined}
            onRetry={() => query.refetch()}
            paginate={false}
            columnMenu={false}
            emptyTitle={t("recipes.detail.whereUsed.empty")}
            mobileTitle={(r) => bizName(lang, r.productName, r.productNameEn)}
          />
        </>
      )}
    </section>
  );
}
