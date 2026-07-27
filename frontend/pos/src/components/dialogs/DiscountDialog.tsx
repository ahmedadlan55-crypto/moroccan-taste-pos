/**
 * DiscountDialog — order-level discount: نسبة (PERCENT) or مبلغ (FIXED) with a
 * discount name. Warns client-side above maxCashierDiscountPct (the server
 * enforces the ceiling at /submit regardless — hidden buttons are not RBAC).
 *
 * Two money defects fixed here:
 *   - The preview called cartTotals() with NO rate, so the whole "total after
 *     discount" block was computed at cartMath's 15% default while the cart
 *     footer used the server's settings.VATRate. On any tenant not on 15% the
 *     dialog contradicted the very total it was previewing. It now threads
 *     `vatRatePct` from the store, exactly like CartPanel does.
 *   - It was the last money-entry screen with no on-screen keypad, so the OS
 *     keyboard slid up over the live preview the cashier was reading.
 */
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/i18n/I18nProvider";
import { BadgePercent, KeyRound, Lock, Tag } from "lucide-react";
import { usePos } from "@/state/store";
import { cartTotals, orderDiscountPct, round2 } from "@/lib/cartMath";
import {
  presetCodeMatches,
  presetInvoiceFill,
  presetNeedsApproval,
  presetsForScope,
  useDiscountPresets,
  type DiscountPreset,
} from "@/lib/discountPresets";
import { fmt2 } from "@/lib/format";
import type { DiscountType } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Numpad } from "../Numpad";
import { Button, cn, Money } from "../ui";

export function DiscountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { cart, setDiscount, catalog, supervisor, posCan, vatRatePct, user } = usePos();
  const [type, setType] = useState<DiscountType>("PERCENT");
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  /** The preset waiting on its promo code + what has been typed. */
  const [codeFor, setCodeFor] = useState<DiscountPreset | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState(false);
  /** Set when a ceiling rewrote the fill, so the cashier is told why the card
   *  did not produce the headline percentage. */
  const [cappedBy, setCappedBy] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setType(cart.discountType ?? "PERCENT");
      setValue(cart.discountType ? String(cart.discountValue) : "");
      setName(cart.discountName ?? "");
      setCodeFor(null);
      setCode("");
      setCodeError(false);
      setCappedBy(null);
    }
  }, [open, cart.discountType, cart.discountValue, cart.discountName]);

  const preview = useMemo(
    // The SERVER's rate — not cartMath's 15% fallback. See the header note.
    () => cartTotals(cart.lines, Number(value) > 0 ? { type, value: Number(value) } : null, vatRatePct),
    [cart.lines, type, value, vatRatePct],
  );
  const pct = orderDiscountPct(preview);
  const ceiling = catalog?.maxCashierDiscountPct ?? 10;
  // Capability-aware: a non-supervisor with the granted capability also
  // bypasses the ceiling warning (broadening only — see lib/capabilities.ts).
  const canOverrideDiscountCeiling = supervisor || posCan("pos.discount.override");
  const overCeiling = !canOverrideDiscountCeiling && preview.discountAmount > 0 && pct > ceiling + 1e-9;

  // Preset cards (خصومات جاهزة) from the owner's discounts settings — a preset
  // click only FILLS the form (type/value/name) exactly like manual typing; the
  // apply button + ceiling logic stay the single path (close/w25-sell-ui).
  const presets = presetsForScope(useDiscountPresets(open), "invoice");
  const actorRole = String(user?.role ?? "");

  /** Fill the form from a preset, honouring maxAmount / maxPerInvoice. A
   *  percentage whose amount would break a ceiling lands as the FIXED ceiling
   *  — the form holds one type + one value, so that is the only faithful
   *  representation of "20% but never more than 50". */
  function applyPreset(p: DiscountPreset) {
    const fill = presetInvoiceFill(p, preview.subtotal);
    setType(fill.type);
    setValue(String(fill.value));
    setName(p.name);
    setCappedBy(fill.capped ? fmt2(fill.value) : null);
    setCodeFor(null);
    setCode("");
    setCodeError(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("discountDialog.title")} widthClass="max-w-md">
      {presets.length > 0 ? (
        <div className="mb-3">
          <p className="mb-1.5 text-[11px] font-extrabold text-slate-500">{t("discountDialog.presets.label")}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {presets.map((p) => {
              const belowMin = p.minOrder != null && preview.subtotal < p.minOrder;
              // requireApproval / minRole — an authority check, not a password
              // prompt; see presetNeedsApproval in lib/discountPresets.ts.
              const locked = presetNeedsApproval(p, actorRole) && !canOverrideDiscountCeiling;
              const disabled = belowMin || locked;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={disabled}
                  title={
                    belowMin
                      ? t("discountDialog.presets.minOrder", { amount: fmt2(p.minOrder!) })
                      : locked
                        ? t("discountDialog.presets.needsApproval")
                        : undefined
                  }
                  onClick={() => {
                    if (p.requireCode) {
                      setCodeFor(p);
                      setCode("");
                      setCodeError(false);
                      return;
                    }
                    applyPreset(p);
                  }}
                  className="btn-press flex min-h-11 items-center justify-between gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 transition hover:border-teal-200 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {locked ? (
                      <Lock className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                    ) : p.requireCode ? (
                      <KeyRound className="h-3.5 w-3.5 shrink-0 text-violet-600" aria-hidden />
                    ) : (
                      <Tag className="h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden />
                    )}
                    <span className="truncate">{p.name}</span>
                  </span>
                  <Money value={p.type === "PERCENT" ? `${fmt2(p.value)}%` : fmt2(p.value)} className="shrink-0 text-teal-700" />
                </button>
              );
            })}
          </div>
          {codeFor ? (
            <div className="mt-2 rounded-xl border border-violet-200 bg-violet-50 p-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-extrabold text-violet-700">
                  {t("discountDialog.presets.codeLabel", { name: codeFor.name })}
                </span>
                <input
                  type="text"
                  value={code}
                  autoFocus
                  onChange={(e) => {
                    setCode(e.target.value);
                    setCodeError(false);
                  }}
                  aria-label={t("discountDialog.presets.codeLabel", { name: codeFor.name })}
                  aria-invalid={codeError}
                  placeholder={t("discountDialog.presets.codePlaceholder")}
                  className={cn("field min-h-11", codeError && "border-red-400 text-red-700")}
                  maxLength={50}
                />
              </label>
              {codeError ? (
                <p role="alert" className="mt-1 text-[11px] font-bold text-red-600">
                  {t("discountDialog.presets.codeWrong")}
                </p>
              ) : null}
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  className="flex-1"
                  onClick={() => (presetCodeMatches(codeFor, code) ? applyPreset(codeFor) : setCodeError(true))}
                >
                  {t("discountDialog.presets.codeApply")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCodeFor(null)}>
                  {t("discountDialog.presets.codeCancel")}
                </Button>
              </div>
            </div>
          ) : null}
          {cappedBy ? (
            <p className="mt-1.5 text-[11px] font-bold text-slate-500">
              {t("discountDialog.presets.cappedNote", { amount: cappedBy })}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mb-3 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={t("discountDialog.type.aria")}>
        {(
          [
            { key: "PERCENT" as DiscountType, label: t("discountDialog.type.percent") },
            { key: "FIXED" as DiscountType, label: t("discountDialog.type.fixed") },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={type === key}
            onClick={() => setType(key)}
            className={cn(
              "btn-press min-h-11 rounded-xl border text-sm font-extrabold transition",
              type === key ? "border-ink bg-ink text-white" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
          {type === "PERCENT"
            ? t("discountDialog.value.percentLabel")
            : t("discountDialog.value.fixedLabel", { amount: fmt2(preview.subtotal) })}
        </span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={type === "PERCENT" ? 100 : undefined}
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={type === "PERCENT" ? "10" : "15.00"}
          className="field num text-lg"
          dir="ltr"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("discountDialog.name.label")}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("discountDialog.name.placeholder")}
          className="field"
          maxLength={100}
        />
      </label>

      <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
        <div className="flex justify-between font-bold text-slate-500">
          <span>{t("discountDialog.summary.discountValue")}</span>
          <Money value={`-${fmt2(preview.discountAmount)}`} className="text-saffron-600" />
        </div>
        <div className="mt-1 flex justify-between font-extrabold text-ink">
          <span>{t("discountDialog.summary.totalAfter")}</span>
          <Money value={fmt2(preview.total)} />
        </div>
      </div>

      {/* On-screen keypad — edits the same `value` state the input above is
          bound to, so the live preview updates as it is tapped and the OS
          keyboard never has to cover it. */}
      <p className="mt-3 text-[11px] font-bold text-slate-400">{t("discountDialog.value.keypadHint")}</p>
      <Numpad value={value} onChange={setValue} className="mt-1" />

      {overCeiling ? (
        <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
          <BadgePercent className="ms-1 inline h-3.5 w-3.5" aria-hidden />
          {t("discountDialog.overCeiling.before")} <Money value={fmt2(round2(pct))} />
          {t("discountDialog.overCeiling.between")}<Money value={fmt2(ceiling)} />
          {t("discountDialog.overCeiling.after")}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        {cart.discountType ? (
          <Button
            variant="danger"
            onClick={() => {
              setDiscount(null, 0, null);
              onClose();
            }}
          >
            {t("discountDialog.actions.remove")}
          </Button>
        ) : null}
        <Button
          variant="primary"
          className="flex-1"
          disabled={!(Number(value) > 0)}
          onClick={() => {
            setDiscount(type, Number(value), name.trim() || null);
            onClose();
          }}
        >
          {t("discountDialog.actions.apply")}
        </Button>
      </div>
    </Dialog>
  );
}
