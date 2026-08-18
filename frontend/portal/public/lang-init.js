/**
 * Pre-paint language bootstrap. Loaded as a same-origin <script src> (the
 * /employee CSP is script-src 'self', which blocks inline scripts but allows
 * this) from the very top of <head>, so it runs and sets <html lang/dir>
 * BEFORE the main bundle evaluates — avoiding an RTL→LTR flash for a returning
 * employee who chose "en".
 *
 * Mirrors I18nProvider's default/storage-key contract exactly:
 *   localStorage key "portal_lang", values "ar" | "en", default "ar".
 *
 * The portal defaults to ARABIC (unlike the cashier, which the owner set to
 * English): its users are floor staff, and the PWA this replaces was
 * Arabic-only.
 */
(function () {
  try {
    var lang = window.localStorage.getItem("portal_lang");
    if (lang !== "ar" && lang !== "en") lang = "ar";
    var root = document.documentElement;
    root.lang = lang;
    root.dir = lang === "en" ? "ltr" : "rtl";
  } catch (e) {
    // localStorage unavailable (private mode / disabled storage) — the
    // hardcoded lang="ar" dir="rtl" already on <html> stands as the default.
  }
})();
