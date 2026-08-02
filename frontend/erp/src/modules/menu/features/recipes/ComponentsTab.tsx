/**
 * Recipe detail · COMPONENTS tab — the editable component grid.
 *
 * Deliberately a hand-rolled table rather than <DataTable>: every row carries
 * live form controls, and the shared table renders BOTH a desktop table and a
 * mobile stack from the same column defs, which would duplicate every input (and
 * every label) into the DOM. The wide grid still scrolls inside its own
 * container (TableShell) so the page body never scrolls sideways.
 *
 * Two rules this tab exists to enforce:
 *   1. A line's unit is a SELECT of the component's REGISTERED units. Free text
 *      is gone — the server resolves and snapshots the conversion factor, so a
 *      typo can no longer silently restate a recipe.
 *   2. "Expected waste %" is the recipe's own planned loss. It is NOT the scrap
 *      a production order records. They are labelled apart here and explained in
 *      full on the production tab.
 */
import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge, IconButton, NumberInput, Select } from "@/shared/ui";
import { SearchableEntityCombobox } from "@/shared/ui";
import { TableShell, Td, Th, Thead, Tr } from "@/shared/tables";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import { fetchComponents, type ComponentOption, type ComponentUnit } from "@/modules/menu/recipesApi";
import { grossBaseQuantity, lineCost, newLineKey, unitOptionsFor, type DraftLine } from "./draft";
import { bizName } from "./labels";

export interface ComponentsTabProps {
  lines: DraftLine[];
  onChange: (lines: DraftLine[]) => void;
  /** Registered units per component id, loaded lazily for saved lines. */
  unitsByItem: Record<string, ComponentUnit[]>;
  /** Merge in the units that came with a freshly-picked component. */
  onUnitsDiscovered: (itemId: string, units: ComponentUnit[]) => void;
  /** Available base-unit stock per component (from the availability tab). */
  availabilityByItem: Record<string, number>;
  canEdit: boolean;
  canViewCost: boolean;
}

export function ComponentsTab(props: ComponentsTabProps) {
  const { lines, onChange, unitsByItem, onUnitsDiscovered, availabilityByItem, canEdit, canViewCost } = props;
  const t = useT();
  const lang = useLang();
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const dash = t("recipes.dash");

  const patchLine = (key: string, patch: Partial<DraftLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addComponent = (opt: ComponentOption | null) => {
    if (!opt) return;
    if (lines.some((l) => l.componentItemId === opt.itemId)) {
      setDuplicate(opt.itemId);
      return;
    }
    setDuplicate(null);
    if (opt.units?.length) onUnitsDiscovered(opt.itemId, opt.units);
    const base = opt.units?.find((u) => u.isBase) ?? opt.units?.[0] ?? null;
    onChange([
      ...lines,
      {
        key: newLineKey(),
        componentItemId: opt.itemId,
        itemName: opt.name,
        itemNameEn: opt.nameEn || "",
        baseUnit: opt.baseUnit || "",
        enteredUnitId: base ? base.id : null,
        enteredUnitCode: base ? base.code : opt.baseUnit || "",
        conversionFactor: base ? Number(base.conversionToBase) || 1 : 1,
        quantity: 1,
        wastePct: 0,
        unitCost: opt.unitCost,
        notes: null,
      },
    ]);
  };

  const totalExpectedLoss = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const net = (Number(l.quantity) || 0) * (Number(l.conversionFactor) || 1);
        return sum + (grossBaseQuantity(l) - net);
      }, 0),
    [lines],
  );

  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.components.title")}</h2>
        <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.components.subtitle")}</p>
      </header>

      {canEdit && (
        <div className="surface flex flex-col gap-2 p-3">
          <span className="text-xs font-bold text-slate-500">{t("recipes.detail.components.add")}</span>
          <div className="max-w-xl">
            <SearchableEntityCombobox<ComponentOption>
              value={null}
              onChange={addComponent}
              fetcher={fetchComponents}
              queryKey={["recipes", "component-picker"]}
              getKey={(c) => c.itemId}
              getLabel={(c) => bizName(lang, c.name, c.nameEn)}
              getSublabel={(c) => c.sku || c.baseUnit}
              placeholder={t("recipes.detail.components.addPlaceholder")}
              ariaLabel={t("recipes.detail.components.add")}
              searchOnEmpty
            />
          </div>
          {duplicate && (
            <p role="alert" className="text-xs font-bold text-amber-700">
              {t("recipes.detail.components.duplicate")}
            </p>
          )}
        </div>
      )}

      {lines.length === 0 ? (
        <div data-state="empty" className="surface grid place-items-center gap-2 p-10 text-center">
          <div className="text-base font-extrabold text-slate-800">{t("recipes.detail.components.empty")}</div>
          <p className="max-w-md text-sm font-medium text-slate-500">{t("recipes.detail.components.emptyBody")}</p>
        </div>
      ) : (
        <div className="surface overflow-hidden">
          <TableShell>
            <Thead>
              <tr>
                <Th>{t("recipes.detail.components.col.component")}</Th>
                <Th>{t("recipes.detail.components.col.nameAr")}</Th>
                <Th>{t("recipes.detail.components.col.nameEn")}</Th>
                <Th>{t("recipes.detail.components.col.enteredUnit")}</Th>
                <Th>{t("recipes.detail.components.col.baseUnit")}</Th>
                <Th numeric>{t("recipes.detail.components.col.conversion")}</Th>
                <Th numeric>{t("recipes.detail.components.col.netQuantity")}</Th>
                <Th numeric>{t("recipes.detail.components.col.wastePct")}</Th>
                <Th numeric>{t("recipes.detail.components.col.grossQuantity")}</Th>
                <Th numeric>{t("recipes.detail.components.col.unitCost")}</Th>
                <Th numeric>{t("recipes.detail.components.col.lineCost")}</Th>
                <Th numeric>{t("recipes.detail.components.col.availability")}</Th>
                {canEdit && <Th>{t("recipes.detail.components.col.actions")}</Th>}
              </tr>
            </Thead>
            <tbody>
              {lines.map((line) => {
                const units = unitOptionsFor(line, unitsByItem[line.componentItemId]);
                const selected = line.enteredUnitId == null ? line.enteredUnitCode : String(line.enteredUnitId);
                const gross = grossBaseQuantity(line);
                const cost = lineCost(line);
                const available = availabilityByItem[line.componentItemId];
                return (
                  <Tr key={line.key}>
                    <Td>
                      <span dir="ltr" className="font-mono text-xs text-slate-500">
                        {line.componentItemId}
                      </span>
                    </Td>
                    <Td>
                      <span className="font-extrabold text-slate-900">{line.itemName}</span>
                    </Td>
                    <Td>
                      {line.itemNameEn ? (
                        <span dir="ltr" className="text-slate-700">
                          {line.itemNameEn}
                        </span>
                      ) : (
                        <span className="text-slate-400">{dash}</span>
                      )}
                    </Td>
                    <Td>
                      {units.length === 0 ? (
                        <Badge tone="warning">{t("recipes.detail.components.noUnits")}</Badge>
                      ) : (
                        <Select
                          className="h-10 w-auto min-w-32"
                          aria-label={t("recipes.detail.components.unitLabel")}
                          value={selected}
                          disabled={!canEdit}
                          onChange={(e) => {
                            const picked = units.find((u) => String(u.id) === e.target.value || u.code === e.target.value);
                            if (!picked) return;
                            patchLine(line.key, {
                              enteredUnitId: picked.id,
                              enteredUnitCode: picked.code,
                              conversionFactor: Number(picked.conversionToBase) || 1,
                            });
                          }}
                        >
                          {units.map((u) => (
                            <option key={String(u.id)} value={String(u.id)}>
                              {u.name || u.code}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Td>
                    <Td>{line.baseUnit || dash}</Td>
                    <Td numeric>{formatNumber(line.conversionFactor)}</Td>
                    <Td numeric>
                      <NumberInput
                        className="h-10 w-28"
                        aria-label={t("recipes.detail.components.col.netQuantity")}
                        value={line.quantity}
                        min={0}
                        disabled={!canEdit}
                        onChange={(v) => patchLine(line.key, { quantity: v ?? 0 })}
                      />
                    </Td>
                    <Td numeric>
                      <NumberInput
                        className="h-10 w-24"
                        aria-label={t("recipes.detail.components.col.wastePct")}
                        value={line.wastePct}
                        min={0}
                        max={100}
                        disabled={!canEdit}
                        onChange={(v) => patchLine(line.key, { wastePct: v ?? 0 })}
                      />
                    </Td>
                    <Td numeric>{formatNumber(gross)}</Td>
                    <Td numeric>
                      {canViewCost && line.unitCost != null ? formatCurrency(line.unitCost) : dash}
                    </Td>
                    <Td numeric>{canViewCost && cost != null ? formatCurrency(cost) : dash}</Td>
                    <Td numeric>
                      {available == null ? (
                        <span className="text-xs font-medium text-slate-400">
                          {t("recipes.detail.components.availabilityUnknown")}
                        </span>
                      ) : (
                        formatNumber(available)
                      )}
                    </Td>
                    {canEdit && (
                      <Td>
                        <IconButton
                          size="sm"
                          variant="secondary"
                          aria-label={t("recipes.detail.components.remove")}
                          onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </tbody>
          </TableShell>
        </div>
      )}

      <div className="surface space-y-2 p-4">
        <p className="text-xs font-bold text-slate-500">{t("recipes.detail.components.conversionHint")}</p>
        <p className="text-xs font-bold text-slate-500">{t("recipes.detail.components.wasteHint")}</p>
        <p className="text-xs font-extrabold text-amber-700">{t("recipes.detail.components.wasteVsScrap")}</p>
        {lines.length > 0 && (
          <p className="text-xs font-bold text-slate-500">
            {t("recipes.detail.production.totalExpectedLoss")}
            {": "}
            <span dir="ltr" className="tabular-nums">
              {formatNumber(totalExpectedLoss)}
            </span>
          </p>
        )}
        {!canViewCost && <p className="text-xs font-bold text-slate-500">{t("recipes.detail.components.costHidden")}</p>}
        {!canEdit && <p className="text-xs font-bold text-slate-500">{t("recipes.detail.actions.readOnly")}</p>}
      </div>
    </section>
  );
}
