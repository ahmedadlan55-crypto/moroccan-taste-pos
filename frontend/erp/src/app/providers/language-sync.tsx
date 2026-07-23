import { useEffect } from "react";
import { useSetLang } from "@/i18n";
import { apiClient } from "@/shared/api";
import { useAuth } from "./auth-provider";

/**
 * Per-user language hydration. On app boot, once a session exists, GET
 * /api/user-preferences and — if it carries { language: "ar" | "en" } — apply
 * it via setLang, so a user's saved interface language follows them across
 * devices. localStorage (erp_lang, read pre-auth by the I18nProvider) remains
 * the fallback and the pre-auth source.
 *
 * Deliberately defensive: it renders nothing, never blocks boot, and swallows
 * every failure (unreachable server, 401, 404 while the endpoint ships, a
 * non-language value) — a failed fetch just leaves the localStorage-backed
 * language in place. The fetch only runs when authenticated, so the public
 * login / change-password screens never touch it.
 */
export function LanguagePreferenceSync() {
  const { isAuthenticated } = useAuth();
  const setLang = useSetLang();

  useEffect(() => {
    if (!isAuthenticated) return;
    let alive = true;
    apiClient
      .get<{ language?: unknown }>("/user-preferences")
      .then((prefs) => {
        if (!alive) return;
        const lang = prefs?.language;
        if (lang === "ar" || lang === "en") setLang(lang);
      })
      .catch(() => {
        /* best-effort: localStorage remains the source of truth */
      });
    return () => {
      alive = false;
    };
  }, [isAuthenticated, setLang]);

  return null;
}
