/**
 * The editable shape of a recipe, and the pure functions that map a server
 * payload into it and back.
 *
 * Kept out of the page component so the dirty check is a plain value comparison
 * (`serialize(draft) !== serialize(baseline)`) rather than a pile of per-field
 * flags — a form that lies about being dirty either nags on every navigation or,
 * worse, lets real edits leave without a prompt.
 */
import type { ComponentUnit, RecipeDetail, RecipeProduct, SaveLineInput, UnitId } from "@/modules/menu/recipesApi";

export interface DraftLine {
  /** Stable client-side key — a line has no server id until it is saved. */
  key: string;
  componentItemId: string;
  itemName: string;
  itemNameEn: string;
  baseUnit: string;
  enteredUnitId: UnitId | null;
  enteredUnitCode: string;
  /** Snapshotted factor (entered unit → base unit). Re-snapshotted server-side on save. */
  conversionFactor: number;
  /** NET quantity, in the ENTERED unit. */
  quantity: number;
  /** EXPECTED recipe loss. NOT production scrap — see the production tab. */
  wastePct: number;
  unitCost: number | null;
  notes: string | null;
}

export interface DraftHeader {
  yieldQuantity: number;
  yieldUnit: string;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
  needsReview: boolean;
  consumptionWarehouseId: string;
}

export interface RecipeDraft {
  header: DraftHeader;
  lines: DraftLine[];
}

let seq = 0;
export function newLineKey(): string {
  seq += 1;
  return `L${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `2026-07-31T21:00:00.000Z` → `2026-07-31` (the shared DatePicker contract). */
function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function draftFromRecipe(recipe: RecipeDetail | null, product: RecipeProduct | null): RecipeDraft {
  if (!recipe) {
    return {
      header: {
        yieldQuantity: 1,
        yieldUnit: product?.unit || "",
        effectiveFrom: "",
        effectiveTo: "",
        notes: "",
        needsReview: false,
        consumptionWarehouseId: "",
      },
      lines: [],
    };
  }
  return {
    header: {
      yieldQuantity: Number(recipe.yieldQuantity) || 0,
      yieldUnit: recipe.yieldUnit || product?.unit || "",
      effectiveFrom: dateOnly(recipe.effectiveFrom),
      effectiveTo: dateOnly(recipe.effectiveTo),
      notes: recipe.notes || "",
      needsReview: !!recipe.needsReview,
      consumptionWarehouseId: recipe.consumptionWarehouseId || "",
    },
    lines: (recipe.lines ?? []).map((l) => ({
      key: newLineKey(),
      componentItemId: l.componentItemId,
      itemName: l.itemName,
      itemNameEn: l.itemNameEn || "",
      baseUnit: l.baseUnit || "",
      enteredUnitId: l.enteredUnitId ?? null,
      enteredUnitCode: l.enteredUnitCode || "",
      conversionFactor: Number(l.conversionFactor) || 1,
      quantity: Number(l.quantity) || 0,
      wastePct: Number(l.wastePct) || 0,
      unitCost: l.unitCost,
      notes: l.notes,
    })),
  };
}

/** Value-identity of a draft, ignoring the client-only line keys. */
export function serializeDraft(d: RecipeDraft): string {
  return JSON.stringify({
    header: d.header,
    lines: d.lines.map((l) => [
      l.componentItemId,
      l.enteredUnitId ?? "",
      l.enteredUnitCode,
      l.quantity,
      l.wastePct,
      l.notes ?? "",
    ]),
  });
}

export function toSaveLines(lines: DraftLine[]): SaveLineInput[] {
  return lines.map((l) => ({
    componentItemId: l.componentItemId,
    quantity: Number(l.quantity) || 0,
    enteredUnitId: l.enteredUnitId,
    enteredUnitCode: l.enteredUnitCode,
    wastePct: Number(l.wastePct) || 0,
    notes: l.notes ?? null,
  }));
}

/** Gross quantity in the component's BASE unit — what production actually issues. */
export function grossBaseQuantity(line: DraftLine): number {
  const net = (Number(line.quantity) || 0) * (Number(line.conversionFactor) || 1);
  return net * (1 + (Number(line.wastePct) || 0) / 100);
}

export function lineCost(line: DraftLine): number | null {
  if (line.unitCost == null) return null;
  return grossBaseQuantity(line) * line.unitCost;
}

export function batchCost(lines: DraftLine[]): number | null {
  if (lines.some((l) => l.unitCost == null)) return null;
  return lines.reduce((sum, l) => sum + (lineCost(l) ?? 0), 0);
}

/**
 * The unit options a line may carry. Free text is gone: the choice is the
 * component's REGISTERED units (item_units, allow_production=1). The unit the
 * line was saved with is always kept in the list even if it is no longer
 * registered — otherwise opening an old recipe would silently re-point it.
 */
export function unitOptionsFor(line: DraftLine, registered: ComponentUnit[] | undefined): ComponentUnit[] {
  const list = [...(registered ?? [])];
  const savedId = line.enteredUnitId == null ? "" : String(line.enteredUnitId);
  const has = list.some((u) => String(u.id) === savedId || (!savedId && u.code === line.enteredUnitCode));
  if (!has && (line.enteredUnitCode || savedId)) {
    list.unshift({
      id: line.enteredUnitId ?? line.enteredUnitCode,
      name: line.enteredUnitCode || line.baseUnit,
      code: line.enteredUnitCode || line.baseUnit,
      isBase: false,
      conversionToBase: Number(line.conversionFactor) || 1,
      precision: 3,
    });
  }
  return list;
}
