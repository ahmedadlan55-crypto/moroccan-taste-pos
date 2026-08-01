/**
 * I18nProvider — Arabic/English UI language for the POS.
 *
 * Exposes useT() / useLang() / useSetLang(). Persists the choice to
 * localStorage under "pos_lang" ("ar" | "en", default "ar" — see
 * public/lang-init.js for the pre-paint sibling of this default, which
 * avoids an RTL→LTR flash before the bundle evaluates). On mount and on
 * every language change this also flips <html lang/dir> and swaps the
 * <link rel="manifest"> href between manifest.webmanifest (ar) and
 * manifest.en.webmanifest (en).
 *
 * Pluralization calling convention (leaf-is-a-function case): a plural leaf
 * is written `(n: number) => string` (e.g. header.staleAge). t() resolves
 * the numeric argument as `vars.count` FIRST, falling back to the first
 * numeric value found anywhere in `vars` if `count` is absent — so both
 * `t("header.staleAge", { count: hours })` and `t("header.staleAge", { h:
 * hours })` work, but implementers should prefer the `{count}` form (it's
 * the documented, unambiguous one). A leaf resolved with no vars at all
 * calls the function with 0.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { makeT, type Lang } from "./makeT";
export type { Lang };
import type { TFunction } from "./types";

const STORAGE_KEY = "pos_lang";

/**
 * Baseline language when nothing is persisted. Owner default: ENGLISH (the
 * cashier UI is English-first, with the Arabic toggle in the Header). Under
 * vitest the parity suite asserts the Arabic strings, so default to Arabic in
 * test mode — `import.meta.env.MODE` is 'test' only under vitest, never in a
 * build. (The provider-less fallback context is already Arabic.)
 */
function defaultLang(): Lang {
  try {
    if (import.meta.env?.MODE === "test") return "ar";
  } catch {
    /* import.meta.env unavailable — fall through to the owner default */
  }
  return "en";
}

function readInitialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    /* localStorage unavailable (private mode, disabled storage) — use default */
  }
  return defaultLang();
}

/** Swaps the manifest link's filename in place, preserving whatever base
 *  path Vite resolved %BASE_URL% to (e.g. "/pos/manifest.webmanifest"). */
function applyDocumentLangDir(lang: Lang) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifestLink) {
    const href = manifestLink.getAttribute("href") || "";
    const base = href.replace(/manifest(?:\.en)?\.webmanifest(?:[?#].*)?$/, "");
    const file = lang === "en" ? "manifest.en.webmanifest" : "manifest.webmanifest";
    const nextHref = base + file;
    if (nextHref !== href) manifestLink.setAttribute("href", nextHref);
  }
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

  const t = useMemo<TFunction>(() => makeT(lang), [lang]);

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Provider-less fallback context. As the i18n rollout reached most screens,
 * many long-standing component unit tests render an i18n'd component in
 * isolation WITHOUT an ancestor I18nProvider (the same valid case useOptionalT
 * already exists for). Rather than make every such test wrap in a provider,
 * useT()/useLang()/useLocalizedName() fall back to the BASE language (ar) —
 * the parity baseline the suite asserts. The real app ALWAYS wraps in
 * <I18nProvider> (main.tsx), so this fallback never triggers in production;
 * useOptionalT() still returns null for the out-of-tree singleton case.
 */
const FALLBACK_T: TFunction = makeT("ar");
const FALLBACK_CTX: I18nContextValue = { lang: "ar", setLang: () => {}, t: FALLBACK_T };

function useI18nContext(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK_CTX;
}

export function useT(): TFunction {
  return useI18nContext().t;
}

/**
 * Like useT(), but returns null outside an I18nProvider instead of throwing.
 * For cross-cutting singletons that live outside the React tree (e.g.
 * lib/offline.ts's OfflineEngine, constructed once via getEngine() and only
 * OPTIONALLY handed a live translator by whichever component mounts first)
 * and for tests that render a provider's consumer (e.g. PosProvider) without
 * an ancestor I18nProvider — those must keep working, just without
 * translated toast text.
 */
export function useOptionalT(): TFunction | null {
  return useContext(I18nContext)?.t ?? null;
}

export function useLang(): Lang {
  return useI18nContext().lang;
}

export function useSetLang(): (lang: Lang) => void {
  return useI18nContext().setLang;
}

/**
 * Localized display name for menu items / combos / units: the English name when
 * the UI is English AND an English name exists, otherwise the Arabic/base value.
 * Menu data carries `name` (Arabic) + optional `nameEn` (served by the catalog).
 * NEVER use this for the receipt — receipts print the Arabic `name` for ZATCA.
 */
export function useLocalizedName(): (base: string, en?: string | null) => string {
  const { lang } = useI18nContext();
  return useCallback((base: string, en?: string | null) => (lang === "en" && en ? en : base), [lang]);
}
