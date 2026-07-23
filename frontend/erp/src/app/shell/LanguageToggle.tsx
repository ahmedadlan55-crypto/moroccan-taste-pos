import { Languages } from "lucide-react";
import { useLang, useSetLang, useT } from "@/i18n";
import { apiClient } from "@/shared/api";
import { cn } from "@/shared/lib";

/**
 * Min-44px interface-language toggle — switches ar↔en. The label always names
 * the language you'll switch TO, kept in its own script in both dictionaries
 * ("English" / "عربي") so the control stays recognisable regardless of the
 * current UI language (same convention as the POS Header toggle).
 *
 * On change it (1) flips the UI language via useSetLang() — the I18nProvider
 * persists the choice to localStorage (erp_lang) so it survives reloads and
 * pre-auth screens — and (2) best-effort persists it per-user to
 * PUT /api/user-preferences {language}, so a signed-in user's choice follows
 * them across devices. The PUT is fire-and-forget: pre-auth (no token) it simply
 * 401s and is ignored, and any failure leaves localStorage as the source.
 *
 * Uses the logical `min-w-11 min-h-11` touch target and neutral styling so it
 * drops into the login card, the user menu, or a toolbar unchanged.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const t = useT();
  const lang = useLang();
  const setLang = useSetLang();
  const next = lang === "ar" ? "en" : "ar";

  function toggle() {
    setLang(next);
    void apiClient.put("/user-preferences", { language: next }).catch(() => {
      /* best-effort per-user sync; localStorage remains the source of truth */
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={t("shell.languageToggle.ariaLabel")}
      aria-label={t("shell.languageToggle.ariaLabel")}
      className={cn(
        "btn-press flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 shadow-sm transition hover:bg-slate-50 hover:text-slate-800",
        className,
      )}
    >
      <Languages className="h-3.5 w-3.5" aria-hidden />
      {lang === "ar" ? t("shell.languageToggle.switchToEnglish") : t("shell.languageToggle.switchToArabic")}
    </button>
  );
}
