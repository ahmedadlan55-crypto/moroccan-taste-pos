// useChartsRtl — direction-aware chart plumbing, bound to the app language and
// the centralized formatters. Charts read digits LTR even in Arabic (Latin
// digits policy), but the AXIS ORDER and tooltip direction flip with the UI
// language — this hook is the one place that mapping lives.
import { useMemo, type CSSProperties } from "react";
import { useLang, type Lang } from "@/i18n";
import { formatCurrency, formatNumber } from "@/shared/lib";

// recharts hands tick/tooltip values through as number | string | (number|string)[]
// (its ValueType). Coerce to a scalar before formatting — no `any` leak.
function toScalar(v: unknown): number {
  return Number(Array.isArray(v) ? v[0] : v);
}

/** Never-throwing useLang (mirrors useTx): "ar" outside an I18nProvider. */
function useOptionalLang(): Lang | null {
  // The hook call itself is UNCONDITIONAL (hook order stays stable — useLang is
  // just a useContext); only the provider-missing throw is absorbed, so shared
  // chart components keep working in tests rendered without an I18nProvider.
  try {
    return useLang();
  } catch {
    return null;
  }
}

export interface ChartsRtl {
  dir: "rtl" | "ltr";
  /** Pass to recharts <Tooltip contentStyle={...}> (token borders, RTL direction). */
  tooltipStyle: CSSProperties;
  /** Pass to <XAxis reversed={...}> so category axes read start→end in RTL. */
  xAxisReversed: boolean;
  /** tickFormatter / tooltip formatter bound to formatNumber (Latin digits). */
  tickFormatterNumber: (value: unknown) => string;
  /** tickFormatter / tooltip formatter bound to formatCurrency. */
  tickFormatterCurrency: (value: unknown) => string;
}

export function useChartsRtl(): ChartsRtl {
  const lang = useOptionalLang() ?? "ar";
  return useMemo<ChartsRtl>(() => {
    const dir = lang === "ar" ? "rtl" : "ltr";
    return {
      dir,
      xAxisReversed: dir === "rtl",
      tooltipStyle: {
        borderRadius: 12,
        border: "1px solid var(--mt-border)",
        fontSize: 12,
        fontWeight: 700,
        direction: dir,
      },
      tickFormatterNumber: (v) => formatNumber(toScalar(v)),
      tickFormatterCurrency: (v) => formatCurrency(toScalar(v)),
    };
  }, [lang]);
}
