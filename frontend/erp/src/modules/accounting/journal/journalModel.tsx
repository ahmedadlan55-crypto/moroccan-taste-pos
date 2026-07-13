// ── Journal shared model helpers ────────────────────────────────────────────
// Small, dependency-free utilities shared by the journal list, editor, line row
// and read-only detail. Keeps the screen files lean: money cell, totals math,
// the four E1 save-validation rules, status labels and error mapping live here.

import { cn } from "@/shared/lib";
import { PNL_TYPES, type JournalLine, type JournalStatus } from "../api";

// English-digit, 2-decimal grouping — matches the app-wide numbering policy
// (English numerals inside the RTL layout, LTR + tabular for alignment).
const MONEY_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export function fmtMoney(value: number | null | undefined): string {
  return MONEY_FMT.format(Number(value) || 0);
}

/** A money cell: LTR + tabular, ~0 → dash. */
export function MoneyText({
  value,
  strong = false,
  dash = true,
  className,
}: {
  value: number | null | undefined;
  strong?: boolean;
  dash?: boolean;
  className?: string;
}) {
  const n = Number(value) || 0;
  if (dash && Math.abs(n) < 0.005) {
    return (
      <span dir="ltr" className={cn("tabular-nums text-slate-300", className)}>
        —
      </span>
    );
  }
  return (
    <span
      dir="ltr"
      className={cn(
        "tabular-nums",
        strong ? "font-extrabold text-slate-900" : "font-semibold text-slate-700",
        className,
      )}
    >
      {fmtMoney(n)}
    </span>
  );
}

// ── status ──────────────────────────────────────────────────────────────────
// StatusBadge auto-maps these Arabic words (مسودة/معتمد/مُرحّل/معكوس) to tones.
export const STATUS_LABEL: Record<JournalStatus, string> = {
  draft: "مسودة",
  approved: "معتمد",
  posted: "مُرحّل",
};

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الحالات" },
  { value: "draft", label: "مسودة" },
  { value: "approved", label: "معتمد" },
  { value: "posted", label: "مُرحّل" },
];

// referenceType filter options (legacy journal sources).
export const REFERENCE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "كل الأنواع" },
  { value: "manual", label: "يدوي" },
  { value: "opening", label: "افتتاحي" },
  { value: "sale", label: "مبيعات" },
  { value: "purchase", label: "مشتريات" },
  { value: "custody", label: "عهدة" },
  { value: "payroll", label: "رواتب" },
  { value: "depreciation", label: "إهلاك" },
  { value: "reversal", label: "عكسي" },
];

// ── lines ─────────────────────────────────────────────────────────────────--
export function emptyLine(): JournalLine {
  return {
    accountId: null,
    accountCode: "",
    accountName: "",
    accountType: "",
    debit: 0,
    credit: 0,
    description: "",
    costCenterId: null,
    costCenterName: "",
  };
}

/** A line pointing at a selected account. */
export function lineHasAccount(l: JournalLine): boolean {
  return !!l.accountId;
}

/** A line the user has touched (an account, an amount, or a description). */
export function lineIsPopulated(l: JournalLine): boolean {
  return (
    !!l.accountId ||
    (Number(l.debit) || 0) > 0 ||
    (Number(l.credit) || 0) > 0 ||
    !!(l.description && l.description.trim())
  );
}

/** Revenue/expense lines require a cost center (line-level or inherited header). */
export function isPnl(type: string | null | undefined): boolean {
  return !!type && (PNL_TYPES as string[]).includes(type);
}

export interface JournalTotals {
  totalDebit: number;
  totalCredit: number;
  diff: number;
  balanced: boolean;
}
export function computeTotals(lines: JournalLine[]): JournalTotals {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += Number(l.debit) || 0;
    totalCredit += Number(l.credit) || 0;
  }
  const diff = Math.abs(totalDebit - totalCredit);
  return { totalDebit, totalCredit, diff, balanced: diff < 0.01 };
}

// ── RULE 3 — save validation (returns the FIRST Arabic error, or null) ───────
export function validateJournal(args: {
  description: string;
  lines: JournalLine[];
  headerCostCenterId: string | null;
}): string | null {
  const { description, lines, headerCostCenterId } = args;

  // 1) description required
  if (!description.trim()) return "الوصف مطلوب";

  // 2) at least two lines that have an account
  const withAccount = lines.filter(lineHasAccount);
  if (withAccount.length < 2) return "يجب إدخال بندين على الأقل";

  // 3) every populated line has a selected account
  const populated = lines.filter(lineIsPopulated);
  if (populated.some((l) => !l.accountId)) return "اختر حسابًا لكل سطر";

  // 4) balanced
  const { diff, balanced } = computeTotals(lines);
  if (!balanced) return `القيد غير متوازن — الفرق: ${fmtMoney(diff)}`;

  // 5) RULE 4 — mandatory cost center for P&L lines (line or inherited header)
  const missingCc = withAccount.some(
    (l) => isPnl(l.accountType) && !(l.costCenterId || headerCostCenterId),
  );
  if (missingCc) return "مركز التكلفة إلزامي لسطور الإيراد/المصروف";

  return null;
}

// Legacy endpoints answer HTTP 200 with { success:false, error } — map to Arabic.
export function mapJournalError(raw: string | undefined): string {
  const s = raw ?? "";
  if (/unbalanced|not.?balanced|balance/i.test(s)) return "القيد غير متوازن.";
  if (/already.?reversed|reversed/i.test(s)) return "القيد معكوس مسبقًا.";
  if (/already.?posted|posted/i.test(s)) return "القيد مُرحَّل بالفعل — أنشئ قيدًا عكسيًا للتصحيح.";
  if (/cost.?cent/i.test(s)) return "مركز التكلفة إلزامي لسطور الإيراد/المصروف.";
  if (/account/i.test(s) && /(required|missing|invalid)/i.test(s)) return "اختر حسابًا صحيحًا لكل سطر.";
  if (/not.?found/i.test(s)) return "القيد غير موجود.";
  if (/permission|forbidden|denied/i.test(s)) return "لا تملك صلاحية لهذه العملية.";
  return s || "تعذّرت العملية. أعد المحاولة.";
}
