/**
 * ComboDialog — chooser for العروض (combos). Parity with the legacy flow
 * (public/pos/app.js openComboChooser/_comboOpenModal/_comboFinalize):
 *   - opens when a combo card is tapped (the store intercepts addItem);
 *   - fixed components are shown READ-ONLY ("يشمل دائماً: …");
 *   - each choice group enforces min/max — toggling off is always allowed,
 *     max ≤ 1 replaces the pick, at max further picks are refused;
 *   - «أضف للسلة» stays LOCKED until every group satisfies its min;
 *   - the title shows name + live price (combo price + picked priceDeltas);
 *   - confirm freezes the picks into { [groupId]: menuId[] } plus a human
 *     summary for the line notes (cart panel + kitchen ticket read notes).
 * Pure helpers are exported so the store and tests share ONE finalize shape.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, Gift, Pin, ShoppingCart } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { Button, cn } from "@/components/ui";
import { fmt2 } from "@/lib/format";
import type { ComboDef, ComboGroup } from "@/lib/types";

/** { [groupId]: [picked menuId, …] } — same shape the cart line freezes. */
export type ComboSelection = Record<string, string[]>;

export interface ComboFinalizeResult {
  /** Frozen picks, exactly as the server validates them at submit. */
  comboChoices: ComboSelection;
  /** Human summary of the picks ("بيبسي + شاورما دجاج") — goes into line notes.
   *  null when the combo has no choice groups (nothing to summarise). */
  notesSummary: string | null;
  /** Sum of the picked options' priceDelta (0 when none). */
  priceDeltaTotal: number;
  /** basePrice + priceDeltaTotal — the unit price the cart line charges. */
  unitPrice: number;
}

/** Empty selection: every group present with zero picks. */
export function emptySelection(combo: ComboDef | null): ComboSelection {
  const sel: ComboSelection = {};
  for (const g of combo?.groups ?? []) sel[g.id] = [];
  return sel;
}

/** Legacy toggle semantics: off is always allowed; max ≤ 1 replaces; at max the
 *  extra pick is refused (returns the array unchanged). */
export function toggleOption(group: ComboGroup, current: string[], menuId: string): string[] {
  const at = current.indexOf(menuId);
  if (at >= 0) return current.filter((id) => id !== menuId); // toggle off
  const max = group.max || 1;
  if (max <= 1) return [menuId]; // single-select: replace
  if (current.length < max) return [...current, menuId];
  return current; // at max — refused
}

/** The confirm gate: every group must have at least `min` picks. */
export function gateSatisfied(combo: ComboDef | null, selection: ComboSelection): boolean {
  return (combo?.groups ?? []).every((g) => (selection[g.id] ?? []).length >= (g.min || 0));
}

/** Sum of the picked options' priceDelta across all groups. */
export function selectionPriceDelta(combo: ComboDef | null, selection: ComboSelection): number {
  let sum = 0;
  for (const g of combo?.groups ?? []) {
    for (const id of selection[g.id] ?? []) {
      const opt = g.options.find((o) => o.menuId === id);
      if (opt) sum += Number(opt.priceDelta) || 0;
    }
  }
  return sum;
}

/** Freeze a selection: comboChoices (only the picked groups' entries, in group
 *  order) + the human notes summary + the price. Shared by the dialog and the
 *  store so the finalize shape exists in exactly one place. */
export function finalizeCombo(combo: ComboDef, selection: ComboSelection, basePrice: number): ComboFinalizeResult {
  const comboChoices: ComboSelection = {};
  const labels: string[] = [];
  for (const g of combo.groups) {
    const picked = selection[g.id] ?? [];
    comboChoices[g.id] = [...picked];
    for (const id of picked) {
      const opt = g.options.find((o) => o.menuId === id);
      if (opt) labels.push(opt.name);
    }
  }
  const priceDeltaTotal = selectionPriceDelta(combo, selection);
  return {
    comboChoices,
    notesSummary: labels.length ? labels.join(" + ") : null,
    priceDeltaTotal,
    unitPrice: basePrice + priceDeltaTotal,
  };
}

/** Legacy rule line: "اختر حتى N / اختر واحداً · مطلوب / اختياري". */
function groupRule(g: ComboGroup): string {
  const max = g.max || 1;
  const pick = max > 1 ? `اختر حتى ${max}` : "اختر واحداً";
  return `${pick} ${g.min > 0 ? "· مطلوب" : "· اختياري"}`;
}

export interface ComboDialogProps {
  open: boolean;
  combo: ComboDef | null;
  /** Price the title/cart charge before deltas — the CatalogItem's price
   *  (falls back to the combo's own price when omitted). */
  basePrice?: number;
  onClose: () => void;
  onConfirm: (result: ComboFinalizeResult) => void;
}

export function ComboDialog({ open, combo, basePrice, onClose, onConfirm }: ComboDialogProps) {
  const [selection, setSelection] = useState<ComboSelection>(() => emptySelection(combo));

  // A new combo (or a re-open) always starts from a clean selection.
  useEffect(() => {
    if (open) setSelection(emptySelection(combo));
  }, [open, combo]);

  const base = basePrice ?? combo?.price ?? 0;
  const price = base + selectionPriceDelta(combo, selection);
  const ok = useMemo(() => gateSatisfied(combo, selection), [combo, selection]);

  if (!combo) return null;

  const toggle = (g: ComboGroup, menuId: string) =>
    setSelection((sel) => ({ ...sel, [g.id]: toggleOption(g, sel[g.id] ?? [], menuId) }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${combo.name} — ${fmt2(price)} ر.س`}
      widthClass="max-w-xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            variant="primary"
            disabled={!ok}
            data-testid="combo-confirm"
            onClick={() => {
              if (!gateSatisfied(combo, selection)) return; // belt-and-braces
              onConfirm(finalizeCombo(combo, selection, base));
            }}
          >
            <ShoppingCart className="h-4 w-4" aria-hidden />
            أضف للسلة
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {combo.fixedComponents.length > 0 ? (
          <div
            data-testid="combo-fixed"
            className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-bold text-slate-600"
          >
            <Pin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <p>
              يشمل دائماً:{" "}
              <span className="font-extrabold text-ink">
                {combo.fixedComponents
                  .map((f) => (Number(f.qty) > 1 ? `${f.name} ×${f.qty}` : f.name))
                  .join("، ")}
              </span>
            </p>
          </div>
        ) : null}

        {combo.groups.length === 0 ? (
          <p className="py-4 text-center text-sm font-bold text-slate-400">
            <Gift className="mx-auto mb-1 h-6 w-6 text-slate-300" aria-hidden />
            هذا العرض بلا خيارات
          </p>
        ) : (
          combo.groups.map((g) => {
            const picked = selection[g.id] ?? [];
            const atMax = picked.length >= (g.max || 1);
            return (
              <fieldset key={g.id} data-testid={`combo-group-${g.id}`}>
                <legend className="mb-1.5 flex items-baseline gap-1.5 text-sm font-extrabold text-ink">
                  {g.name}
                  <span className="text-[11px] font-bold text-slate-400">({groupRule(g)})</span>
                </legend>
                {g.options.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs font-bold text-slate-400">
                    لا خيارات متاحة
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {g.options.map((o) => {
                      const isPicked = picked.includes(o.menuId);
                      // Multi-select at max: unpicked options are disabled (the
                      // toggle itself refuses too). Single-select stays enabled —
                      // tapping another option REPLACES the pick (legacy).
                      const blocked = !isPicked && atMax && (g.max || 1) > 1;
                      return (
                        <button
                          key={o.menuId}
                          type="button"
                          onClick={() => toggle(g, o.menuId)}
                          disabled={blocked}
                          aria-pressed={isPicked}
                          className={cn(
                            "btn-press flex min-h-11 items-center gap-2 rounded-xl border px-3 text-start text-sm font-bold transition",
                            isPicked
                              ? "border-teal-500 bg-teal-50 text-teal-700"
                              : "border-slate-200 bg-white text-ink hover:border-teal-200 hover:bg-slate-50",
                            blocked && "opacity-45",
                          )}
                        >
                          {isPicked ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                          ) : (
                            <Circle className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1 truncate">{o.name}</span>
                          {Number(o.priceDelta) ? (
                            <span dir="ltr" className="num shrink-0 text-[11px] font-extrabold text-saffron-600">
                              {o.priceDelta > 0 ? "+" : ""}
                              {fmt2(o.priceDelta)}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
