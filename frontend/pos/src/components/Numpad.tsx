/**
 * Numpad — on-screen touch keypad for MONEY amounts (the payment screen).
 *
 * The edit rules live in the pure `applyNumpadKey` so the money grammar is
 * unit-testable without rendering: digits append, a single decimal point,
 * at most TWO decimal places (halalas), no leading-zero runs, a hard length
 * cap. The keypad COMPLEMENTS the system keyboard — it edits the same string
 * state the <input> is bound to, so every derived total (change due, split
 * sum) recomputes exactly as if typed.
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

const keyBtn =
  "btn-press flex min-h-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-lg font-extrabold text-ink shadow-sm transition hover:bg-slate-50 active:bg-slate-100";

export interface NumpadProps {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}

/** 3×4 grid: 7 8 9 / 4 5 6 / 1 2 3 / . 0 ⌫ — plus a full-width clear row. */
export function Numpad({ value, onChange, className }: NumpadProps) {
  const t = useT();
  const press = (key: NumpadKey) => onChange(applyNumpadKey(value, key));
  return (
    <div data-testid="numpad" dir="ltr" className={cn("select-none", className)}>
      <div className="grid grid-cols-3 gap-1.5">
        {(["7", "8", "9", "4", "5", "6", "1", "2", "3"] as const).map((d) => (
          <button key={d} type="button" aria-label={t(`numpad.digits.${d}`)} onClick={() => press(d)} className={cn(keyBtn, "num")}>
            {d}
          </button>
        ))}
        <button type="button" aria-label={t("numpad.decimalPoint")} onClick={() => press(".")} className={keyBtn}>
          .
        </button>
        <button type="button" aria-label={t("numpad.digits.0")} onClick={() => press("0")} className={cn(keyBtn, "num")}>
          0
        </button>
        <button type="button" aria-label={t("numpad.deleteLast")} onClick={() => press("backspace")} className={cn(keyBtn, "text-slate-500 hover:text-red-600")}>
          <Delete className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        aria-label={t("numpad.clearAmount")}
        onClick={() => press("clear")}
        className={cn(keyBtn, "mt-1.5 w-full text-sm text-slate-500 hover:text-red-600")}
      >
        {t("numpad.clear")}
      </button>
    </div>
  );
}
