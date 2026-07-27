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
import { useLocalizedName, useT } from "@/i18n/I18nProvider";
import type { TFunction } from "@/i18n/types";
import type { ComboDef, ComboGroup, ComboOption } from "@/lib/types";

/** { [groupId]: [picked menuId, …] } — same shape the cart line freezes. */
export type ComboSelection = Record<string, string[]>;

/**
 * Is this option still sellable?
 *
 * The chooser used to render `g.options` verbatim. The server ships
 * `active:false` for an option whose menu row was deactivated and then REFUSES
 * the sale at sync with «الخيار "X" غير نشط» — so the cashier could build a cart
 * that was guaranteed to fail, minutes later, after the customer had paid
 * attention to the screen. Filtering here is display-only; the server stays the
 * authority.
 *
 * DEFENSIVE by design: an older server (or a cached catalog written before the
 * field existed) omits `active` entirely, and dropping every option in that case
 * would empty every combo. So ABSENT means active — only an explicit falsy
 * marker (false / 0 / "0" / "false") hides an option. The `active` property is
 * read through a local widening because the shared ComboOption type does not
 * declare it yet.
 */
export function isOptionActive(option: ComboOption): boolean {
  const raw = (option as ComboOption & { active?: unknown }).active;
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return v !== "0" && v !== "false" && v !== "";
  }
  return true;
}

/** The options a cashier may actually pick from a group. */
export function activeOptions(group: ComboGroup): ComboOption[] {
  return group.options.filter(isOptionActive);
}

/** Groups whose REMAINING (active) options can no longer reach their minimum.
 *  Any such group makes the whole combo unsellable — «أضف للسلة» must stay
 *  locked and say why, instead of letting the cashier build a cart the sync
 *  will reject. */
export function unsatisfiableGroups(combo: ComboDef | null): ComboGroup[] {
  return (combo?.groups ?? []).filter((g) => activeOptions(g).length < (g.min || 0));
}

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
function groupRule(g: ComboGroup, t: TFunction): string {
  const max = g.max || 1;
  const pick = max > 1 ? t("comboDialog.groupRule.chooseUpTo", { max }) : t("comboDialog.groupRule.chooseOne");
  return `${pick} ${g.min > 0 ? t("comboDialog.groupRule.required") : t("comboDialog.groupRule.optional")}`;
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
  const t = useT();
  const tn = useLocalizedName();
  const [selection, setSelection] = useState<ComboSelection>(() => emptySelection(combo));

  // A new combo (or a re-open) always starts from a clean selection.
  useEffect(() => {
    if (open) setSelection(emptySelection(combo));
  }, [open, combo]);

  const base = basePrice ?? combo?.price ?? 0;
  const price = base + selectionPriceDelta(combo, selection);
  // A group that can no longer reach its minimum from its ACTIVE options makes
  // the combo unsellable: the confirm stays locked no matter what is picked.
  const blockedGroups = useMemo(() => unsatisfiableGroups(combo), [combo]);
  const sellable = blockedGroups.length === 0;
  const ok = useMemo(() => gateSatisfied(combo, selection), [combo, selection]) && sellable;

  if (!combo) return null;

  const toggle = (g: ComboGroup, menuId: string) =>
    setSelection((sel) => ({ ...sel, [g.id]: toggleOption(g, sel[g.id] ?? [], menuId) }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${tn(combo.name, combo.nameEn)} — ${fmt2(price)} ${t("comboDialog.currency")}`}
      widthClass="max-w-xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("comboDialog.actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!ok}
            data-testid="combo-confirm"
            title={sellable ? undefined : t("comboDialog.unsellable")}
            onClick={() => {
              if (!gateSatisfied(combo, selection)) return; // belt-and-braces
              if (unsatisfiableGroups(combo).length > 0) return; // ditto
              onConfirm(finalizeCombo(combo, selection, base));
            }}
          >
            <ShoppingCart className="h-4 w-4" aria-hidden />
            {t("comboDialog.actions.addToCart")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!sellable ? (
          <p
            role="alert"
            data-testid="combo-unsellable"
            className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm font-extrabold text-amber-800"
          >
            {t("comboDialog.unsellable")}
          </p>
        ) : null}
        {combo.fixedComponents.length > 0 ? (
          <div
            data-testid="combo-fixed"
            className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-bold text-slate-600"
          >
            <Pin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <p>
              {t("comboDialog.fixed.alwaysIncludes")}{" "}
              <span className="font-extrabold text-ink">
                {combo.fixedComponents
                  .map((f) => (Number(f.qty) > 1 ? `${tn(f.name, f.nameEn)} ×${f.qty}` : tn(f.name, f.nameEn)))
                  .join(t("comboDialog.fixed.separator"))}
              </span>
            </p>
          </div>
        ) : null}

        {combo.groups.length === 0 ? (
          <p className="py-4 text-center text-sm font-bold text-slate-400">
            <Gift className="mx-auto mb-1 h-6 w-6 text-slate-300" aria-hidden />
            {t("comboDialog.emptyCombo")}
          </p>
        ) : (
          combo.groups.map((g) => {
            const picked = selection[g.id] ?? [];
            const atMax = picked.length >= (g.max || 1);
            // Inactive options are never rendered: they are unpickable server-
            // side, so offering them only builds a cart that fails at sync.
            const options = activeOptions(g);
            const groupBlocked = options.length < (g.min || 0);
            return (
              <fieldset key={g.id} data-testid={`combo-group-${g.id}`}>
                <legend className="mb-1.5 flex items-baseline gap-1.5 text-sm font-extrabold text-ink">
                  {g.name}
                  <span className="text-[11px] font-bold text-slate-400">({groupRule(g, t)})</span>
                </legend>
                {g.options.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs font-bold text-slate-400">
                    {t("comboDialog.group.noOptions")}
                  </p>
                ) : options.length === 0 ? (
                  <p
                    role="alert"
                    data-testid={`combo-group-inactive-${g.id}`}
                    className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800"
                  >
                    {t("comboDialog.group.allInactive")}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {groupBlocked ? (
                      <p
                        role="alert"
                        data-testid={`combo-group-short-${g.id}`}
                        className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 sm:col-span-2"
                      >
                        {t("comboDialog.group.cannotMeetMinimum", { min: g.min })}
                      </p>
                    ) : null}
                    {options.map((o) => {
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
                          <span className="min-w-0 flex-1 truncate">{tn(o.name, o.nameEn)}</span>
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
