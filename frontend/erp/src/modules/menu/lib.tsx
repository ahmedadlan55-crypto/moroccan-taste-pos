// Small domain adapters for the Menu screens — numeric cells (LTR tabular +
// English digits per the app numbering policy) and the shared brand-scope
// controls. No colours/hex live here; these compose the shared kit only.
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { formatCurrency, formatNumber, cn } from "@/shared/lib";
import { Select } from "@/shared/ui";
import { useLang, formatCurrency as fmtCurrencyLang, formatNumber as fmtNumberLang, type Lang } from "@/i18n";
import type { Brand } from "./api";

/** Money cell — English digits, LTR, tabular; Arabic currency label. */
export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span dir="ltr" className={cn("tabular-nums", className)}>{formatCurrency(value)}</span>;
}

/** Plain number — English digits, LTR, tabular. */
export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span dir="ltr" className={cn("tabular-nums", className)}>{formatNumber(value)}</span>;
}

/** Margin % from price/cost, rendered as a coloured chip via caller. */
export function marginPct(price: number, cost: number): number {
  return price > 0 ? Math.round(((price - cost) / price) * 10000) / 100 : 0;
}

// ── Bilingual helpers (Sprint 3 · D2) ────────────────────────────────────────

/** Business-data name policy: render the English name when the UI language is
 *  English AND an English name exists, otherwise the Arabic name. */
export function pickName(nameAr: string, nameEn: string | null | undefined, lang: Lang): string {
  if (lang === "en" && nameEn && nameEn.trim()) return nameEn;
  return nameAr;
}

/** Language-aware currency/number formatters bound to the active UI language.
 *  Digits stay Latin in both languages (app numbering policy); only the currency
 *  label/position follows the locale ("SAR 1,234.50" vs "1,234.50 ر.س."). */
export function useFmt() {
  const lang = useLang();
  return {
    lang,
    money: (v: number | null | undefined) => fmtCurrencyLang(Number(v) || 0, lang),
    num: (v: number | null | undefined) => fmtNumberLang(Number(v) || 0, lang),
  };
}

/** Language-aware money cell — LTR tabular, label follows the active language. */
export function MoneyI18n({ value, className }: { value: number | null | undefined; className?: string }) {
  const { money } = useFmt();
  return <span dir="ltr" className={cn("tabular-nums", className)}>{money(value)}</span>;
}

// ── URL-addressable brand scope (?brandId=) shared by every menu section ──
// The router registers one exact route per section (no `/:id`); the selected
// brand lives in the query string so back/forward + refresh keep the scope.
export function useBrandScope() {
  const [sp, setSearchParams] = useSearchParams();
  const brandId = sp.get("brandId") || "";
  const setBrandId = useCallback(
    (id: string) =>
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (id) n.set("brandId", id);
          else n.delete("brandId");
          return n;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  return { brandId, setBrandId };
}

/** URL-addressable single-item selection (?item=) for the recipe editor. */
export function useItemScope() {
  const [sp, setSearchParams] = useSearchParams();
  const itemId = sp.get("item") || "";
  const setItemId = useCallback(
    (id: string) =>
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (id) n.set("item", id);
          else n.delete("item");
          return n;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  return { itemId, setItemId };
}

/** Native brand <select> — short fixed list, best mobile + a11y behaviour. */
export function BrandSelect({
  brands,
  value,
  onChange,
  allowAll = true,
  allLabel = "كل العلامات",
  className,
  "aria-label": ariaLabel = "تصفية بالعلامة التجارية",
}: {
  brands: Brand[];
  value: string;
  onChange: (id: string) => void;
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Select
      className={cn("h-10", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    >
      {allowAll && <option value="">{allLabel}</option>}
      {brands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}
