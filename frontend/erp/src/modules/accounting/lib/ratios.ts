// Financial ratios — the math, kept pure so it is unit-testable.
//
// Ported from the legacy `erpLoadFinRatios`, with its two fabrications REMOVED:
//
//   cogs        = sum(51xx) || (totalExpense * 0.6)
//   currentAssets = sum(11xx) || totalAssets
//
// Those `||` fallbacks fire exactly when the figure CANNOT be determined from the
// chart of accounts — and then print a gross margin derived from a 60% guess, or
// a current ratio computed from every asset the company owns. A number that looks
// like a measurement but is an assumption is worse than no number, so an
// indeterminable input yields `null` here and renders as "—" with a reason.

export type RatioGroup = "liquidity" | "profit" | "solvency" | "efficiency";

export interface AccountRow {
  code?: string;
  balance?: number;
}

export interface RatioInputs {
  totalAssets: number;
  currentAssets: number | null;
  inventory: number | null;
  totalLiabilities: number;
  currentLiabilities: number | null;
  equity: number;
  revenue: number;
  cogs: number | null;
  netIncome: number;
}

export interface Ratio {
  key: string;
  group: RatioGroup;
  name: string;
  formula: string;
  /** null = an input could not be determined; render "—", never a guess. */
  value: number | null;
  suffix: "×" | "%";
  bench: string;
  explanation: string;
  /** Why the value is null — shown so the gap is actionable, not mysterious. */
  unavailableReason?: string;
}

export const GROUP_LABEL: Record<RatioGroup, string> = {
  liquidity: "السيولة",
  profit: "الربحية",
  solvency: "الملاءة",
  efficiency: "الكفاءة",
};

/** Sum balances of accounts whose code starts with any of `prefixes`.
 *  Returns null when NO account matches — the caller must not substitute a
 *  different figure for one that doesn't exist. */
export function sumByPrefix(rows: AccountRow[] | undefined, prefixes: string[]): number | null {
  const matched = (rows ?? []).filter((r) => prefixes.some((p) => String(r.code ?? "").startsWith(p)));
  if (matched.length === 0) return null;
  return matched.reduce((s, r) => s + Number(r.balance ?? 0), 0);
}

/** a/b, or null when the denominator is zero/absent — dividing by zero is not 0. */
function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !b) return null;
  return a / b;
}

const NO_COGS = "لا توجد حسابات تكلفة بضاعة مباعة (51xx) في دليل الحسابات.";
const NO_CURRENT_ASSETS = "لا توجد حسابات أصول متداولة (11xx) في دليل الحسابات.";
const NO_CURRENT_LIAB = "لا توجد حسابات التزامات متداولة (21xx) في دليل الحسابات.";
const NO_INVENTORY = "لا توجد حسابات مخزون (112x) في دليل الحسابات.";
const NO_REVENUE = "لا توجد إيرادات في الفترة المحددة.";

export function computeRatios(i: RatioInputs): Ratio[] {
  const pct = (v: number | null) => (v === null ? null : v * 100);
  const revenueOrNull = i.revenue ? i.revenue : null;

  return [
    {
      key: "current", group: "liquidity", name: "النسبة الجارية",
      formula: "الأصول المتداولة ÷ الالتزامات المتداولة",
      value: div(i.currentAssets, i.currentLiabilities), suffix: "×",
      bench: "> 2 ممتاز · 1.5–2 جيد · 1–1.5 مقبول · < 1 خطر",
      explanation: "تقيس قدرة المنشأة على سداد التزاماتها قصيرة الأجل من أصولها المتداولة.",
      unavailableReason: i.currentAssets === null ? NO_CURRENT_ASSETS : i.currentLiabilities === null ? NO_CURRENT_LIAB : undefined,
    },
    {
      key: "quick", group: "liquidity", name: "النسبة السريعة",
      formula: "(الأصول المتداولة − المخزون) ÷ الالتزامات المتداولة",
      value: div(i.currentAssets === null ? null : i.currentAssets - (i.inventory ?? 0), i.currentLiabilities), suffix: "×",
      bench: "> 1 آمن · < 1 يحتاج مراقبة",
      explanation: "مثل النسبة الجارية لكن تستثني المخزون (الأصل الأقل سيولة).",
      unavailableReason: i.currentAssets === null ? NO_CURRENT_ASSETS : i.currentLiabilities === null ? NO_CURRENT_LIAB : undefined,
    },
    {
      key: "gross-margin", group: "profit", name: "هامش الربح الإجمالي",
      formula: "(الإيرادات − تكلفة البضاعة) ÷ الإيرادات × 100",
      value: pct(div(i.cogs === null || revenueOrNull === null ? null : i.revenue - i.cogs, revenueOrNull)), suffix: "%",
      bench: "مطاعم: > 60% ممتاز · 50–60% جيد · < 50% منخفض",
      explanation: "الربح بعد تكلفة المنتج المباشرة وقبل المصاريف الإدارية.",
      unavailableReason: i.cogs === null ? NO_COGS : revenueOrNull === null ? NO_REVENUE : undefined,
    },
    {
      key: "net-margin", group: "profit", name: "هامش صافي الربح",
      formula: "صافي الدخل ÷ الإيرادات × 100",
      value: pct(div(i.netIncome, revenueOrNull)), suffix: "%",
      bench: "> 15% ممتاز · 10–15% جيد · 5–10% مقبول · < 5% منخفض",
      explanation: "ما يتبقّى من كل ريال مبيعات بعد كل المصاريف.",
      unavailableReason: revenueOrNull === null ? NO_REVENUE : undefined,
    },
    {
      key: "roa", group: "profit", name: "العائد على الأصول (ROA)",
      formula: "صافي الدخل ÷ إجمالي الأصول × 100",
      value: pct(div(i.netIncome, i.totalAssets || null)), suffix: "%",
      bench: "> 10% ممتاز · 5–10% جيد",
      explanation: "كفاءة توليد الأرباح من الأصول.",
    },
    {
      key: "roe", group: "profit", name: "العائد على حقوق الملكية (ROE)",
      formula: "صافي الدخل ÷ حقوق الملكية × 100",
      value: pct(div(i.netIncome, i.equity || null)), suffix: "%",
      bench: "> 15% ممتاز · 10–15% جيد",
      explanation: "العائد على أموال الملّاك.",
    },
    {
      key: "debt-ratio", group: "solvency", name: "نسبة المديونية",
      formula: "إجمالي الالتزامات ÷ إجمالي الأصول × 100",
      value: pct(div(i.totalLiabilities, i.totalAssets || null)), suffix: "%",
      bench: "< 40% آمن · 40–60% مقبول · > 60% مرتفع",
      explanation: "نسبة الأصول المموّلة بالدين.",
    },
    {
      key: "debt-equity", group: "solvency", name: "الدين إلى حقوق الملكية",
      formula: "الالتزامات ÷ حقوق الملكية",
      value: div(i.totalLiabilities, i.equity || null), suffix: "×",
      bench: "< 1 متحفّظ · 1–2 مقبول · > 2 مرتفع",
      explanation: "التوازن بين تمويل الدين وتمويل الملّاك.",
    },
    {
      key: "asset-turnover", group: "efficiency", name: "دوران الأصول",
      formula: "الإيرادات ÷ إجمالي الأصول",
      value: div(i.revenue, i.totalAssets || null), suffix: "×",
      bench: "> 1 جيد",
      explanation: "حجم المبيعات المتولّد من كل ريال أصول.",
    },
    {
      key: "inventory-turnover", group: "efficiency", name: "دوران المخزون",
      formula: "تكلفة البضاعة ÷ المخزون",
      value: div(i.cogs, i.inventory || null), suffix: "×",
      bench: "مطاعم: مرتفع أفضل (مخزون سريع التلف)",
      explanation: "عدد مرات تصريف المخزون خلال الفترة.",
      unavailableReason: i.cogs === null ? NO_COGS : i.inventory === null ? NO_INVENTORY : undefined,
    },
  ];
}

/** Map the balance-sheet + P&L API payloads onto the ratio inputs. */
export function extractInputs(
  bs: { totals?: { assets?: number; liabilities?: number; equity?: number }; assets?: AccountRow[]; liabilities?: AccountRow[] } | undefined,
  pnl: { summary?: { totalRevenue?: number; totalExpense?: number; netProfit?: number }; expenses?: AccountRow[] } | undefined,
): RatioInputs {
  const bst = bs?.totals ?? {};
  const psum = pnl?.summary ?? {};
  const revenue = Number(psum.totalRevenue ?? 0);
  const totalExpense = Number(psum.totalExpense ?? 0);
  return {
    totalAssets: Number(bst.assets ?? 0),
    currentAssets: sumByPrefix(bs?.assets, ["11"]),
    inventory: sumByPrefix(bs?.assets, ["112"]),
    totalLiabilities: Number(bst.liabilities ?? 0),
    currentLiabilities: sumByPrefix(bs?.liabilities, ["21"]),
    equity: Number(bst.equity ?? 0),
    revenue,
    cogs: sumByPrefix(pnl?.expenses, ["51"]),
    netIncome: Number(psum.netProfit ?? revenue - totalExpense),
  };
}
