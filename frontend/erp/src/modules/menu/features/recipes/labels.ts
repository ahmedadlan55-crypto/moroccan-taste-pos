/**
 * Vocabulary helpers shared by the recipe catalog and the recipe detail page.
 *
 * The server speaks stable English CODES (`draft`, `semi_finished`, `ZERO_COST`,
 * `co_product`, …). Nothing in the UI may print a code: every one of them is
 * resolved through the `recipes.*` dictionary so it reads correctly in BOTH
 * languages. When a code is genuinely unknown (a server enum grew before the UI
 * did) we fall back to the code itself rather than to an empty cell — an
 * unlabelled value is confusing, a blank one is a lie.
 */
import type { TFunction } from "@/i18n";
import type { Lang } from "@/i18n";
import type { CatalogStatus } from "@/modules/menu/recipesApi";

const KNOWN_STATUSES = new Set(["none", "draft", "active", "archived"]);
const KNOWN_TYPES = new Set(["sold", "semi_finished", "combo", "stock_item"]);
const KNOWN_ANOMALIES = new Set([
  "ZERO_COST",
  "COMPONENT_WITHOUT_COST",
  "COST_EXCEEDS_PRICE",
  "FOOD_COST_HIGH",
  "COST_STALE",
]);
const KNOWN_OUTPUT_TYPES = new Set(["primary", "co_product", "by_product", "rework", "scrap"]);
const KNOWN_ALLOC = new Set(["fixed_pct", "standard_cost", "weight", "nrv"]);
const KNOWN_ORIGINS = new Set(["bom", "legacy_recipe"]);

export type Tone = "neutral" | "teal" | "success" | "warning" | "info" | "danger" | "purple";

export function statusLabel(t: TFunction, code: string | null | undefined): string {
  const c = code || "none";
  return KNOWN_STATUSES.has(c) ? t(`recipes.status.${c}`) : c;
}

/** Colour carries meaning ONLY alongside the label (WCAG 1.4.1). */
export function statusTone(code: string | null | undefined): Tone {
  switch (code) {
    case "active":
      return "success";
    case "draft":
      return "info";
    case "archived":
      return "neutral";
    default:
      return "warning"; // "none" — a product without a recipe is the thing to fix
  }
}

export function typeLabel(t: TFunction, code: string | null | undefined): string {
  const c = code || "";
  return KNOWN_TYPES.has(c) ? t(`recipes.type.${c}`) : c || t("recipes.dash");
}

export function anomalyLabel(t: TFunction, code: string): string {
  return KNOWN_ANOMALIES.has(code) ? t(`recipes.anomaly.${code}`) : code;
}

export function outputTypeLabel(t: TFunction, code: string | null | undefined): string {
  const c = code || "primary";
  return KNOWN_OUTPUT_TYPES.has(c) ? t(`recipes.detail.outputType.${c}`) : c;
}

export function allocMethodLabel(t: TFunction, code: string | null | undefined): string {
  const c = code || "";
  return KNOWN_ALLOC.has(c) ? t(`recipes.detail.allocMethod.${c}`) : c || t("recipes.dash");
}

export function originLabel(t: TFunction, code: string | null | undefined): string {
  const c = code || "";
  return KNOWN_ORIGINS.has(c) ? t(`recipes.detail.whereUsed.origin.${c}`) : c || t("recipes.dash");
}

/** Business data, not UI copy: show the English name in English mode when it exists. */
export function bizName(lang: Lang, name: string, nameEn: string | null | undefined): string {
  return lang === "en" ? nameEn || name : name;
}

/** "12.34%" with English digits (the app-wide numbering policy). */
export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value))}%`;
}

export function statusOf(row: { recipeStatus: CatalogStatus }): CatalogStatus {
  return row.recipeStatus || "none";
}
