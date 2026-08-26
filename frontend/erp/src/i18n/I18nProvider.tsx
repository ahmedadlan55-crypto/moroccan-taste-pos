/**
 * I18nProvider — Arabic/English UI language for the ERP (الإدارة الموحّدة).
 *
 * Ported from the proven POS provider (frontend/pos/src/i18n/I18nProvider.tsx)
 * with two ERP adaptations: the localStorage key is "erp_lang" (not "pos_lang"),
 * and the POS PWA-manifest-swap is dropped (the ERP ships no manifest) — only
 * the <html lang/dir> flip is kept.
 *
 * Exposes useT() / useOptionalT() / useLang() / useSetLang(). Persists the
 * choice to localStorage under "erp_lang" ("ar" | "en", default "ar" — see
 * public/lang-init.js for the pre-paint sibling of this default, which avoids
 * an RTL→LTR flash before the bundle evaluates). On mount and on every language
 * change this flips <html lang/dir>.
 *
 * Pluralization calling convention (leaf-is-a-function case): a plural leaf
 * is written `(n: number) => string`. t() resolves the numeric argument as
 * `vars.count` FIRST, falling back to the first numeric value found anywhere in
 * `vars` if `count` is absent — so both `t("x.plural", { count: n })` and
 * `t("x.plural", { n })` work, but implementers should prefer the `{count}`
 * form (it's the documented, unambiguous one). A leaf resolved with no vars at
 * all calls the function with 0.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ar } from "./dictionaries/ar";
import { en } from "./dictionaries/en";
import { format } from "./interpolate";
import type { Dictionary, DictionaryLeaf, TFunction } from "./types";

export type Lang = "ar" | "en";

const STORAGE_KEY = "erp_lang";

const DICTS: Record<Lang, Dictionary> = {
  ar: ar as unknown as Dictionary,
  en: en as unknown as Dictionary,
};

function readInitialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    /* localStorage unavailable (private mode, disabled storage) — use default */
  }
  return "ar";
}

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
function resolvePluralArg(vars?: Record<string, string | number>): number {
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

/** Flip <html lang/dir> to match the active language. ERP has no PWA manifest,
 *  so — unlike the POS provider — there is nothing else to swap here. */
function applyDocumentLangDir(lang: Lang) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);

  useEffect(() => {
    applyDocumentLangDir(lang);
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* persistence best-effort — UI still works for this session */
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);

  const t = useMemo<TFunction>(() => {
    const dict = DICTS[lang];
    return (path, vars) => {
      const leaf = resolveLeaf(dict, path);
      if (typeof leaf === "function") return leaf(resolvePluralArg(vars));
      if (typeof leaf === "string") return format(leaf, vars);
      // Missing key: return the dotted path itself (unchanged) — this is the
      // contract translateApiError() relies on to detect a lookup miss.
      return path;
    };
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT/useLang/useSetLang must be called within an I18nProvider");
  return ctx;
}

export function useT(): TFunction {
  return useI18nContext().t;
}

/**
 * Like useT(), but returns null outside an I18nProvider instead of throwing.
 * For cross-cutting singletons that live outside the React tree, and for tests
 * that render a consumer without an ancestor I18nProvider — those keep working,
 * just without translated text.
 */
export function useOptionalT(): TFunction | null {
  return useContext(I18nContext)?.t ?? null;
}

/** Active language when a provider exists, otherwise null. Shared design-system
 *  primitives use this instead of `useLang()` because they are also rendered in
 *  isolation by Storybook/tests. */
export function useOptionalLang(): Lang | null {
  return useContext(I18nContext)?.lang ?? null;
}

export function useLang(): Lang {
  return useI18nContext().lang;
}

export function useSetLang(): (lang: Lang) => void {
  return useI18nContext().setLang;
}
