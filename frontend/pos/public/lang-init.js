/**
 * Pre-paint language bootstrap. Loaded as a same-origin <script src> (the
 * /pos CSP is script-src 'self', which blocks inline scripts but allows
 * this) from the very top of <head>, so it runs and sets <html lang/dir>
 * BEFORE the main bundle evaluates — avoiding an RTL→LTR (or LTR→RTL) flash
 * for a returning user who chose "en".
 *
 * Mirrors I18nProvider's default/storage-key contract exactly:
 *   localStorage key "pos_lang", values "ar" | "en", default "en".
 * Does not touch the manifest link — I18nProvider swaps that on mount,
 * which is fast enough that the app's installability metadata catching up a
 * beat after first paint is not user-visible.
 */
(function () {
  try {
    var lang = window.localStorage.getItem("pos_lang");
    if (lang !== "ar" && lang !== "en") lang = "en";
    var root = document.documentElement;
    root.lang = lang;
    root.dir = lang === "en" ? "ltr" : "rtl";
  } catch (e) {
    // localStorage unavailable (private mode / disabled storage) — the
    // hardcoded lang="en" dir="ltr" already on <html> stands as the default.
  }
})();
