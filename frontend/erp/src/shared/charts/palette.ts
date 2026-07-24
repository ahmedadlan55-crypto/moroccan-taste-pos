// Chart palette — the ONE way chart code obtains colors. recharts needs
// concrete color STRINGS (it writes fill/stroke attributes), and hex is
// forbidden in erp files, so we resolve the --mt-chart-* tokens from
// design-tokens.css at runtime via getComputedStyle — read once, cached.
// When a token can't be resolved (SSR, jsdom without the stylesheet) the
// var(--token) reference itself is returned: harmless in tests, and still
// correct if it ever reaches a real DOM.
import { useMemo } from "react";

const SERIES_TOKENS = [
  "--mt-chart-1",
  "--mt-chart-2",
  "--mt-chart-3",
  "--mt-chart-4",
  "--mt-chart-5",
  "--mt-chart-6",
  "--mt-chart-7",
  "--mt-chart-8",
] as const;

export interface ChartPalette {
  /** 8 categorical series colors (petrol/saffron-anchored, CVD-safe ordering). */
  series: string[];
  grid: string;
  axis: string;
  pos: string;
  neg: string;
  warn: string;
}

/**
 * Pure resolver — exported for tests. `read` returns a token's computed value
 * ("" when unavailable); empty reads fall back to the var() reference.
 */
export function resolveChartPalette(read: (token: string) => string): ChartPalette {
  const get = (token: string): string => {
    const v = read(token).trim();
    return v || `var(${token})`;
  };
  return {
    series: SERIES_TOKENS.map(get),
    grid: get("--mt-chart-grid"),
    axis: get("--mt-chart-axis"),
    pos: get("--mt-chart-pos"),
    neg: get("--mt-chart-neg"),
    warn: get("--mt-chart-warn"),
  };
}

let cache: ChartPalette | null = null;

/** Resolve the palette from the live document (memoized module-wide; SSR-safe). */
export function readChartPalette(): ChartPalette {
  if (cache) return cache;
  if (
    typeof window === "undefined" ||
    typeof window.getComputedStyle !== "function" ||
    typeof document === "undefined"
  ) {
    // No DOM (SSR): return var() references WITHOUT caching, so a later call in
    // a real browser still resolves concrete values.
    return resolveChartPalette(() => "");
  }
  const styles = window.getComputedStyle(document.documentElement);
  cache = resolveChartPalette((token) => styles.getPropertyValue(token));
  return cache;
}

/** TEST-ONLY: drop the module cache so a test can exercise re-resolution. */
export function __resetChartPaletteCacheForTests(): void {
  cache = null;
}

/** The palette as a stable per-component value. Light theme only — no need to re-read. */
export function useChartPalette(): ChartPalette {
  return useMemo(readChartPalette, []);
}
