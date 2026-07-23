// A never-throwing translator for the shared component kit.
//
// Shared components are rendered both inside the app (under an <I18nProvider>)
// AND by unit tests that call render() with no provider (see
// frontend/erp/src/shared/**/__tests__/* and many module tests we do NOT own).
// useT() throws without a provider, which would break those tests, so shared
// components use useTx(): the active-language translator when a provider is
// present, and an Arabic-dictionary-bound fallback when it isn't — so text stays
// Arabic (the app default, matching the pre-i18n hardcoded copy) instead of
// leaking a raw dotted key. Call sites read exactly like the POS: t("ns.key").
import { ar } from "@/i18n/dictionaries/ar";
import { format, useOptionalT } from "@/i18n";
import type { Dictionary, DictionaryLeaf, TFunction } from "@/i18n";

function resolveLeaf(dict: Dictionary, path: string): DictionaryLeaf | undefined {
  let cur: Dictionary | DictionaryLeaf | undefined = dict;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Dictionary)[part];
  }
  return typeof cur === "string" || typeof cur === "function" ? cur : undefined;
}

function pluralArg(vars?: Record<string, string | number>): number {
  if (!vars) return 0;
  for (const v of [vars.count, ...Object.values(vars)]) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return 0;
}

/** A TFunction bound to the Arabic dictionary — the no-provider fallback. It
 *  mirrors the provider's resolution: plural function leaves get the numeric arg,
 *  string leaves are {token}-interpolated, and a miss returns the path itself. */
export const arT: TFunction = (path, vars) => {
  const leaf = resolveLeaf(ar as unknown as Dictionary, path);
  if (typeof leaf === "function") return leaf(pluralArg(vars));
  if (typeof leaf === "string") return format(leaf, vars);
  return path;
};

/** useT() that never throws: active-language `t` under an I18nProvider, else the
 *  Arabic-bound fallback. */
export function useTx(): TFunction {
  return useOptionalT() ?? arT;
}
