/**
 * Pre-paint language bootstrap. Loaded as a same-origin <script src> from the
 * very top of <head>, so it runs and sets <html lang/dir> BEFORE the main
 * bundle evaluates — avoiding an RTL→LTR (or LTR→RTL) flash for a returning
 * user who chose "en".
 *
 * Mirrors I18nProvider's default/storage-key contract exactly:
 *   localStorage key "erp_lang", values "ar" | "en", default "ar".
 * The ERP has no PWA manifest, so — unlike the POS version — there is nothing
 * else to touch here.
 */
(function () {
  try {
    var lang = window.localStorage.getItem("erp_lang");
    if (lang !== "ar" && lang !== "en") lang = "ar";
    var root = document.documentElement;
    root.lang = lang;
    root.dir = lang === "en" ? "ltr" : "rtl";
  } catch (e) {
    // localStorage unavailable (private mode / disabled storage) — the
    // hardcoded lang="ar" dir="rtl" already on <html> stands as the default.
  }
})();
