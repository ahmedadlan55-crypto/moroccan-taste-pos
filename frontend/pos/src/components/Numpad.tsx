/**
 * Numpad — on-screen touch keypad for MONEY amounts (the payment screen).
 *
 * The edit rules live in the pure `applyNumpadKey` so the money grammar is
 * unit-testable without rendering: digits append, a single decimal point,
 * at most TWO decimal places (halalas), no leading-zero runs, a hard length
 * cap. The keypad COMPLEMENTS the system keyboard — it edits the same string
 * state the <input> is bound to, so every derived total (change due, split
 * sum) recomputes exactly as if typed.
 *
 * The pad is now PERMANENT on the payment screen (it used to appear only on
 * the cash tab and inside the split legs, so it jumped around under the
 * cashier's thumb). Two props exist purely to serve that:
 *   - `apply` swaps the key grammar without touching `applyNumpadKey`, because
 *     a card approval code is not money: its leading zeros are significant and
 *     it has no decimal point (see `applyReferenceKey`);
 *   - `disabled` renders the pad INERT rather than unmounting it, so a method
 *     with nothing to type keeps the pad in the same spot at the same size.
 */
import { Delete } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import { cn } from "./ui";

export type NumpadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "backspace" | "clear";

/** Hard cap: 999999.99 is far above any single receipt — 9 chars incl. the dot. */
const MAX_LEN = 9;

export function applyNumpadKey(value: string, key: NumpadKey): string {
  if (key === "clear") return "";
  if (key === "backspace") return value.slice(0, -1);
  if (key === ".") {
    if (value.includes(".")) return value; // one decimal point only
    return value === "" ? "0." : value + ".";
  }
  // digit
  if (value.length >= MAX_LEN) return value;
  const dot = value.indexOf(".");
  if (dot !== -1 && value.length - dot > 2) return value; // ≤ 2 decimals (money)
  if (value === "0") return key; // "0" then 5 → "5", never "05"
  return value + key;
}

/** Reference/approval codes run longer than money (a card RRN is 12 digits). */
const REF_MAX_LEN = 20;

/**
 * Reference/approval-code grammar — deliberately NOT the money grammar.
 *
 * A terminal approval number is a digit STRING: "0042" and "42" are different
 * codes, and there is no such thing as a decimal place in one. Running it
 * through `applyNumpadKey` would eat the leading zeros and cap it at 9 chars,
 * which silently mangles the very number the cashier is copying off the
 * terminal slip. Pure — unit-tested alongside applyNumpadKey.
 */
export function applyReferenceKey(value: string, key: NumpadKey): string {
  if (key === "clear") return "";
  if (key === "backspace") return value.slice(0, -1);
  if (key === ".") return value; // a reference has no decimal part
  if (value.length >= REF_MAX_LEN) return value;
  return value + key; // leading zeros are significant — no normalization
}

/** 4 digits — mirrors QTY_MAX (9999) in QtyPad. Not imported from there: QtyPad
 *  imports this module, and the cycle would be worse than the duplication. */
const QTY_MAX_LEN = 4;

/**
 * Whole-quantity grammar — digits only, no decimal point at ALL.
 *
 * The register sells in whole units, so "2.5" is not a quantity the cashier may
 * enter. Enforcing it in the GRAMMAR (rather than validating after the fact)
 * means the fractional value never exists to be mis-rounded downstream: the
 * card badge, the line total and the stock deduction all agree by construction.
 *
 * Leading zeros ARE normalized (unlike a reference code): "0" then 5 is the
 * quantity 5, never "05".
 */
export function applyIntegerKey(value: string, key: NumpadKey): string {
  if (key === "clear") return "";
  if (key === "backspace") return value.slice(0, -1);
  if (key === ".") return value; // a quantity has no decimal part
  if (value.length >= QTY_MAX_LEN) return value;
  if (value === "0") return key; // "0" then 5 → "5", never "05"
  return value + key;
}

const keyBtn =
  "btn-press flex min-h-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-lg font-extrabold text-ink shadow-sm transition hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:hover:bg-white";

export interface NumpadProps {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  /**
   * Key grammar. Defaults to the money grammar (`applyNumpadKey`); pass
   * `applyReferenceKey` when the pad is driving a reference/approval code, or
   * `applyIntegerKey` when it is driving a whole quantity.
   */
  apply?: (value: string, key: NumpadKey) => string;
  /**
   * Whether the «.» key is live. Set false alongside a grammar that ignores it
   * (integer quantities, reference codes) so the cashier sees a dead key rather
   * than tapping one that silently does nothing. The key is DISABLED, never
   * removed — the 3×4 grid must keep its shape so «0» and «⌫» stay under the
   * same thumb.
   */
  allowDecimal?: boolean;
  /**
   * Inert pad: every key is disabled and the grid dims, but the pad KEEPS its
   * place and its size. Used when the active payment method has nothing
   * numeric to type — the pad must never disappear or move between tabs.
   */
  disabled?: boolean;
}

/** 3×4 grid: 7 8 9 / 4 5 6 / 1 2 3 / . 0 ⌫ — plus a full-width clear row. */
export function Numpad({
  value,
  onChange,
  className,
  apply = applyNumpadKey,
  disabled = false,
  allowDecimal = true,
}: NumpadProps) {
  const t = useT();
  const press = (key: NumpadKey) => {
    if (disabled) return;
    onChange(apply(value, key));
  };
  return (
    <div
      data-testid="numpad"
      dir="ltr"
      aria-disabled={disabled || undefined}
      className={cn("select-none", disabled && "opacity-40", className)}
    >
      <div className="grid grid-cols-3 gap-1.5">
        {(["7", "8", "9", "4", "5", "6", "1", "2", "3"] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-label={t(`numpad.digits.${d}`)}
            disabled={disabled}
            onClick={() => press(d)}
            className={cn(keyBtn, "num")}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          aria-label={t("numpad.decimalPoint")}
          data-testid="numpad-decimal"
          disabled={disabled || !allowDecimal}
          onClick={() => press(".")}
          className={cn(keyBtn, !allowDecimal && "opacity-40")}
        >
          .
        </button>
        <button type="button" aria-label={t("numpad.digits.0")} disabled={disabled} onClick={() => press("0")} className={cn(keyBtn, "num")}>
          0
        </button>
        <button
          type="button"
          aria-label={t("numpad.deleteLast")}
          disabled={disabled}
          onClick={() => press("backspace")}
          className={cn(keyBtn, "text-slate-500 hover:text-red-600")}
        >
          <Delete className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        aria-label={t("numpad.clearAmount")}
        disabled={disabled}
        onClick={() => press("clear")}
        className={cn(keyBtn, "mt-1.5 w-full text-sm text-slate-500 hover:text-red-600")}
      >
        {t("numpad.clear")}
      </button>
    </div>
  );
}
