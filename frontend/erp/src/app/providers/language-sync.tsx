import { useEffect } from "react";
import { useSetLang } from "@/i18n";
import { apiClient } from "@/shared/api";
import { useAuth } from "./auth-provider";
import { isPosOnlyRole } from "./require-auth";

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
  const { isAuthenticated, user } = useAuth();
  const setLang = useSetLang();

  useEffect(() => {
    if (!isAuthenticated) return;
    // PORTAL ISOLATION. This provider sits ABOVE the router, so it mounts and
    // fires before RequireAuth can eject a POS-only role out of /app. The
    // server-side boundary (middleware/posPortalScope.js) correctly refuses
    // /api/user-preferences for a cashier, so the call was a guaranteed 403 on
    // every cashier who so much as touched an /app URL — a real 403 in the
    // network log for a request the product should never have made. A role
    // that is being sent back to the till has no back-office preferences to
    // hydrate; don't ask for them.
    if (isPosOnlyRole(user?.role)) return;
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
  }, [isAuthenticated, user?.role, setLang]);

  return null;
}
