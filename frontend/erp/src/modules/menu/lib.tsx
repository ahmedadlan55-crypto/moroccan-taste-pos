// Small domain adapters for the Menu screens — numeric cells (LTR tabular +
// English digits per the app numbering policy) and the shared brand-scope
// controls. No colours/hex live here; these compose the shared kit only.
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { formatCurrency, formatNumber, cn } from "@/shared/lib";
import { Select } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
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

// ── VAT breakdown — net / tax / gross ───────────────────────────────────────
// The owner reads prices as what the CUSTOMER PAYS, but menu rows are stored
// NET (is_tax_inclusive=0 on every current row). A screen that shows only the
// stored figure hides the number he actually cares about, and the register was
// showing 34.99 for an item whose ERP row said 30.4261 — the same product,
// two numbers, no way to connect them.
//
// THE ARITHMETIC IS A MIRROR, NOT A SECOND OPINION. These two branches are the
// same ones frontend/pos/src/lib/cartMath.ts uses (lineTotals → displayUnitPrice)
// for the cashier card. A separate formula here would drift from the till the
// first time the owner changed the VAT rate in settings — which is precisely
// the class of bug this work exists to remove.

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

/** Tax categories that actually carry VAT. Z (zero-rated), E (exempt) and
 *  O (out-of-scope) are always 0%, so their stored price IS the final one. */
const TAXED: Record<string, boolean> = { S: true, Z: false, E: false, O: false };

export interface PriceBreakdown {
  /** Price before VAT. */
  net: number;
  /** The VAT amount itself. 0 for Z/E/O. */
  tax: number;
  /** What the customer pays — the number on the cashier card. */
  gross: number;
  /** Whether `gross` is a whole riyal (no halalas). */
  grossIsWhole: boolean;
  /** The nearest whole riyal — what `gross` WOULD be after the rounding sweep. */
  wholeTarget: number;
  /** Effective VAT fraction used (0 for Z/E/O). */
  rate: number;
}

export function priceBreakdown(
  price: number,
  taxCategory: string | null | undefined,
  isTaxInclusive: boolean | null | undefined,
  vatRatePct: number,
): PriceBreakdown {
  const p = Number(price) || 0;
  const pct = Number(vatRatePct);
  const rate = TAXED[String(taxCategory ?? "S")] === false
    ? 0
    : (Number.isFinite(pct) && pct >= 0 ? pct : 15) / 100;

  let net: number, tax: number, gross: number;
  if (isTaxInclusive === true) {
    gross = round2(p);
    net = round4(gross / (1 + rate));
    tax = round2(gross - net);
  } else {
    net = round4(p);
    tax = round2(net * rate);
    gross = round2(net + tax);
  }

  return {
    net,
    tax,
    gross,
    grossIsWhole: Number.isInteger(gross),
    // Never propose 0 for a priced item — that would make it free.
    wholeTarget: Math.max(p > 0 ? 1 : 0, Math.round(gross)),
    rate,
  };
}

/** The stored (net) price that makes `gross` come out exactly, for a row with
 *  this tax treatment. The inverse of priceBreakdown — used by the price dialog
 *  so the owner can type what the customer pays and have the right net stored.
 *
 *  4 decimals is not cosmetic: at 2 decimals many whole-riyal targets are
 *  unreachable (11.00 @15% needs 9.5652 — 9.57 gives 11.01, 9.56 gives 10.99),
 *  which is why menu.price was widened in db/migrations/0023. */
export function netForGross(
  gross: number,
  taxCategory: string | null | undefined,
  isTaxInclusive: boolean | null | undefined,
  vatRatePct: number,
): number {
  const g = Number(gross) || 0;
  if (isTaxInclusive === true) return round2(g); // stored price IS the gross
  const pct = Number(vatRatePct);
  const rate = TAXED[String(taxCategory ?? "S")] === false
    ? 0
    : (Number.isFinite(pct) && pct >= 0 ? pct : 15) / 100;
  return round4(g / (1 + rate));
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
  allLabel,
  className,
  "aria-label": ariaLabel,
}: {
  brands: Brand[];
  value: string;
  onChange: (id: string) => void;
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const t = useTx();
  return (
    <Select
      className={cn("h-10", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel ?? t("menuRest.brandScope.filterByBrand")}
    >
      {allowAll && <option value="">{allLabel ?? t("menuRest.brandScope.allBrands")}</option>}
      {brands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}
