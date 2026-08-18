/**
 * I18nProvider — Arabic/English for the employee portal.
 *
 * Persists to localStorage under "portal_lang" ("ar" | "en", default "ar" —
 * public/lang-init.js is the pre-paint sibling of that default and avoids an
 * RTL→LTR flash before the bundle evaluates). On mount and on every change it
 * flips <html lang/dir> and swaps <link rel="manifest"> between
 * manifest.webmanifest (ar) and manifest.en.webmanifest (en), so an installed
 * icon carries the right name and direction.
 *
 * t() takes a dotted path and optional `{var}` values. A missing key returns
 * the path itself — visible, not silent — but `dictionary.test.ts` asserts key
 * parity so a missing key fails CI rather than reaching an employee.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ar, en, type Dictionary } from "./dict";

export type Lang = "ar" | "en";
export type TVars = Record<string, string | number>;
export type TFunction = (key: string, vars?: TVars) => string;

const STORAGE_KEY = "portal_lang";
const DICTS: Record<Lang, Dictionary> = { ar, en: en as unknown as Dictionary };

function readInitialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    /* localStorage unavailable (private mode, disabled storage) — use default */
  }
  return "ar";
}

function lookup(dict: unknown, path: string): string | undefined {
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

export function makeT(lang: Lang): TFunction {
  return (key, vars) => {
    // Fall back to Arabic (the base language) before falling back to the key —
    // a key present only in `ar` should render Arabic text, not "profile.net".
    const hit = lookup(DICTS[lang], key) ?? lookup(ar, key);
    return hit === undefined ? key : interpolate(hit, vars);
  };
}

/** Swaps the manifest link's filename in place, preserving Vite's base path. */
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
 * Provider-less fallback. Component unit tests render a screen in isolation
 * without an ancestor provider; falling back to the BASE language keeps them
 * working instead of throwing. The real app always wraps in <I18nProvider>.
 */
const FALLBACK: I18nContextValue = { lang: "ar", setLang: () => {}, t: makeT("ar") };

function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK;
}

export function useT(): TFunction {
  return useI18n().t;
}

export function useLang(): Lang {
  return useI18n().lang;
}

export function useSetLang(): (lang: Lang) => void {
  return useI18n().setLang;
}

/** Localized status label with a safe passthrough for unknown server values. */
export function useStatusLabel(): (status: string | null | undefined) => string {
  const t = useT();
  return useCallback(
    (status) => {
      const s = String(status ?? "").trim();
      if (!s) return "—";
      const hit = t(`status.${s.toLowerCase()}`);
      // t() returns the path when the key is missing — show the server's own
      // word rather than "status.some_new_value" leaking into the UI.
      return hit === `status.${s.toLowerCase()}` ? s : hit;
    },
    [t],
  );
}
