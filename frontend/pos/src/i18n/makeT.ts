/**
 * The translator factory — dictionaries in, `t()` out. NO REACT.
 *
 * It lives in its own module rather than in I18nProvider.tsx on purpose. The
 * offline engine (lib/offline.ts) needs the same resolution the provider uses
 * for its own messages, and it runs OUTSIDE the React tree; importing the
 * provider from it would drag React and the whole component module graph into
 * a module that is loaded during boot and inside tests that mock the store.
 * That is not theoretical — doing exactly that measurably destabilised the
 * lazy-dialog timing suite.
 *
 * Consumers:
 *   I18nProvider  — per-language `t` (and its provider-less fallback)
 *   lib/offline.ts — base-language fallback for the engine's OWN strings
 */
import { ar } from "./dictionaries/ar";
import { en } from "./dictionaries/en";
import { format } from "./interpolate";
import type { Dictionary, DictionaryLeaf, TFunction } from "./types";

export type Lang = "ar" | "en";

export const DICTS: Record<Lang, Dictionary> = {
  ar: ar as unknown as Dictionary,
  en: en as unknown as Dictionary,
};

function resolveLeaf(dict: Dictionary, path: string): DictionaryLeaf | undefined {
  const parts = path.split(".");
  let cur: Dictionary | DictionaryLeaf | undefined = dict;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Dictionary)[part];
  }
  return typeof cur === "string" || typeof cur === "function" ? cur : undefined;
}

/** vars.count first; else the first numeric-looking value in vars; else 0. */
export function resolvePluralArg(vars?: Record<string, string | number>): number {
  if (!vars) return 0;
  if (typeof vars.count === "number") return vars.count;
  if (typeof vars.count === "string" && vars.count.trim() !== "" && !Number.isNaN(Number(vars.count))) {
    return Number(vars.count);
  }
  for (const v of Object.values(vars)) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
}

/**
 * Build a translator for one language.
 *
 * A FUNCTION leaf is called with a plain NUMBER — never the vars object. A leaf
 * written `(p: { count, who }) => …` therefore receives a number and renders
 * "undefined"; TypeScript cannot catch it because DictionaryLeaf is
 * `(n: number, ...rest: unknown[]) => string`, which such a function
 * structurally satisfies. Multi-variable strings must be TEMPLATES with
 * {placeholders}. Pinned by i18n/__tests__/dictionary.test.ts.
 */
export function makeT(lang: Lang): TFunction {
  const dict = DICTS[lang];
  return (path, vars) => {
    const leaf = resolveLeaf(dict, path);
    if (typeof leaf === "function") return leaf(resolvePluralArg(vars));
    if (typeof leaf === "string") return format(leaf, vars);
    // Missing key: return the dotted path itself (unchanged) — this is the
    // contract translateApiError() relies on to detect a lookup miss.
    return path;
  };
}
