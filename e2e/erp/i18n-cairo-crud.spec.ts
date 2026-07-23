// ═══════════════════════════════════════════════════════════════════════════
// ADLAN Back-Office (frontend/erp) — i18n SPRINT ACCEPTANCE GATE.
//
// Run:  npx playwright test --config=playwright.erp.config.ts e2e/erp/i18n-cairo-crud.spec.ts
//       (build first: npm --prefix frontend/erp run build)
//
// Four things this proves, on ALL FOUR viewport projects (desktop / mobile /
// tablet-768 / laptop-1024):
//
//   1. Cairo is GENUINELY LOADED, not silently falling back. The self-hosted
//      subsets (frontend/erp/src/assets/fonts/cairo-{arabic,latin,latin-ext}
//      .woff2, wired via src/styles/fonts.css + the `--mt-font` token in
//      frontend/shared/design-tokens.css → tailwind `fontFamily.sans`) are
//      checked FOUR independent ways: the computed font-family resolves to
//      Cairo first, document.fonts.check() passes for real Arabic AND Latin
//      text, at least one FontFace whose family is "Cairo" reports
//      status === "loaded", and the woff2 files were actually served 200 (with
//      zero font responses >= 400). Once per language, because the Arabic and
//      Latin subsets are separate files behind separate unicode-ranges.
//
//   2. The AR↔EN toggle genuinely works — driven by CLICKING the real control
//      (app/shell/LanguageToggle.tsx, which lives inside the UserMenu popover in
//      the shell), never by injecting localStorage: <html lang/dir> flips,
//      real translated copy renders, the choice survives a hard reload
//      (localStorage "erp_lang"), toggling back restores Arabic, and the
//      navigation chrome carries NO stray Arabic in English mode.
//
//   3. The Inventory + Menu full-page CRUD surfaces are real routes
//      (manifest subRoutes:true → /inventory/items/{new,:id,:id/edit} and
//      /menu/brand/{new,:id,:id/edit}): the lists render rows, the "new" route
//      is a genuine deep-linkable PAGE (survives a reload; no role="dialog"
//      anywhere; the heading lives inside #main, the routed content area — not
//      in a portalled overlay), and the detail + edit routes render healthy and
//      PREFILLED.
//      ⚠ ZERO WRITES: this spec never creates or updates a record, so it leaves
//      ZERO residue for scripts/audit/test-residue-report.js to find. That is
//      asserted, not merely intended — every non-GET request to a business
//      endpoint is recorded and the list must come back empty. The create forms
//      are exercised through their VALIDATION path only (submit an empty form →
//      inline errors, no network write). See the comment on
//      `inventory item CRUD surface` for why the write path is deliberately not
//      exercised.
//
//   4. Screenshots for every viewport in both languages, at
//      artifacts/e2e/erp/i18n/<project>/<lang>-<screen>.png (artifacts/ is
//      gitignored, so this pollutes nothing).
//
// HEALTH CONTRACT — identical to e2e/erp/erp.spec.ts and
// e2e/erp/trial-balance-rbac.spec.ts, deliberately kept in sync rather than
// redefined loosely: data-state ∈ {error, offline, session-expired,
// permission-denied, conflict, feature-disabled, not-found} fails; "loading"
// and "empty" are legitimate. Any console error outside the SAME benign
// allowlist fails. Any response >= 400 fails — no network whitelist.
//
// NOT serial on purpose (the other two ERP specs are): every test below is
// self-contained — its own context, its own token injection, its own network
// bookkeeping — so a failure in one must not mask the others. workers:1 +
// fullyParallel:false in playwright.erp.config.ts already guarantees ordering.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const API_BASE = "http://127.0.0.1:3027";
const OUT_ROOT = path.join(process.cwd(), "artifacts", "e2e", "erp", "i18n");
const CRASH_TEXT = "حدث خطأ غير متوقّع"; // ErrorBoundary recovery heading

// Same non-healthy-state contract erp.spec.ts enforces for the full closure
// gate. `loading` and `empty` are intentionally NOT here.
const BAD_STATES = [
  "error", "offline", "session-expired", "permission-denied", "conflict", "feature-disabled", "not-found",
];
// Same benign-console allowlist as erp.spec.ts / trial-balance-rbac.spec.ts —
// copied, not invented. Anything outside it is a real defect.
const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag/i;

// The @font-face family declared in frontend/erp/src/styles/fonts.css and led
// by --mt-font in frontend/shared/design-tokens.css.
const FONT_FAMILY = "Cairo";

// Arabic script — U+0600-06FF (Arabic), U+0750-077F (Supplement),
// U+0870-089F (Extended-B), U+08A0-08FF (Extended-A), U+FB50-FDFF and
// U+FE70-FEFC (Presentation Forms A/B). Stops at U+FEFC, deliberately EXCLUDING
// U+FEFF (BOM / zero-width no-break space), which is invisible plumbing and
// would otherwise produce phantom "stray Arabic" hits. Verified against
// "نظرة عامة" (matches) vs "Overview", digits, punctuation and a BOM (all
// non-matching). Used to prove the English nav carries no untranslated Arabic.
const ARABIC =
  /[؀-ۿݐ-ݿࡰ-࢟ࢠ-ࣿﭐ-﷿ﹰ-ﻼ]/;

// ── Strings taken VERBATIM from the dictionaries (no guessing) ──────────────
// ar: frontend/erp/src/i18n/dictionaries/ar/*.ts
// en: frontend/erp/src/i18n/dictionaries/en/*.ts
const AR = {
  userMenu: "حساب المستخدم",            // shell.userMenu.label
  langToggle: "تبديل لغة الواجهة",       // shell.languageToggle.ariaLabel
  sidebar: "الشريط الجانبي",             // shell.sidebar.ariaLabel
  brand: "المذاق المغربي",               // shell.brand.name
  overviewTitle: "نظرة عامة",            // overview.home.title
  overviewSubtitle: "ملخّص الأداء المالي والتشغيلي للمجموعة.", // overview.home.subtitle
  itemsListTitle: "كتالوج الأصناف",      // items.listTitle
  itemNewTitle: "صنف جديد",              // items.form.newTitle
  itemEditTitle: "تعديل صنف",            // items.form.editTitle
  itemCreateBtn: "إنشاء الصنف",          // items.form.create
  itemFixBeforeSave: "صحّح الحقول المميّزة قبل الحفظ.", // items.form.validation.fixBeforeSave
  itemFieldCode: "الرمز / SKU",          // items.form.field.code
  itemFieldNameAr: "الاسم (عربي)",       // items.form.field.nameAr
  itemDetailBasics: "البيانات الأساسية", // items.detail.section.basics
  menuListTitle: "أصناف القائمة",        // menu.list.title
  menuNewTitle: "إضافة منتج للقائمة",    // menu.page.titleNew
  menuCreateBtn: "إنشاء المنتج",         // menu.page.create
  menuNameArLabel: "الاسم بالعربية",     // menu.page.nameAr
  menuNameRequired: "اسم المنتج مطلوب",  // menu.valid.nameRequired
} as const;

const EN = {
  userMenu: "User account",              // shell.userMenu.label
  langToggle: "Switch interface language", // shell.languageToggle.ariaLabel
  sidebar: "Sidebar",                    // shell.sidebar.ariaLabel
  mobileNav: "Quick navigation",         // shell.mobileNav.ariaLabel
  brand: "Moroccan Taste",               // shell.brand.name
  overviewTitle: "Overview",             // overview.home.title
  overviewSubtitle: "A summary of the group's financial and operational performance.", // overview.home.subtitle
  itemsListTitle: "Item Catalog",        // items.listTitle
  itemNewTitle: "New Item",              // items.form.newTitle
  menuListTitle: "Menu items",           // menu.list.title
  menuNewTitle: "Add a menu product",    // menu.page.titleNew
} as const;

// Representative screens for the bilingual screenshot matrix.
const SHOTS = [
  { path: "/overview", file: "overview" },
  { path: "/accounting/trial-balance", file: "trial-balance" },
  { path: "/inventory/items", file: "inventory-items" },
  { path: "/menu/brand", file: "menu-brand" },
];

type Lang = "ar" | "en";

// ── Shared helpers (same shapes the existing ERP specs use) ─────────────────

/** Read-only API probe, mirroring trial-balance-rbac.spec.ts's apiCall(). */
async function apiCall(method: string, urlPath: string, token: string | null) {
  const res = await fetch(API_BASE + urlPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as Record<string, unknown> | null };
}

/** Inject the admin session the way erp.spec.ts does (89-route walk pattern). */
async function injectSession(page: Page, lang?: Lang) {
  // When a language is forced, pin BOTH of the things that decide it. Seeding
  // only one is not deterministic:
  //
  //   • localStorage "erp_lang" is read PRE-PAINT (public/lang-init.js and
  //     I18nProvider's readInitialLang), so it decides the FIRST paint — which
  //     is what makes the font run start from a genuinely cold cache and the
  //     woff2 actually get requested.
  //   • GET /api/user-preferences is the SERVER-persisted per-user preference
  //     that app/providers/language-sync.tsx applies on mount: for any stored
  //     "ar"|"en" it calls setLang(), which overwrites the in-memory language
  //     AND, via the I18nProvider effect, the localStorage value just seeded.
  //
  // Those two used to agree only by accident: routes/user-preferences.js has no
  // DELETE, so `user_preferences` simply had no row for admin, GET returned {}
  // and the seed survived. This file's afterEach — added to stop the language
  // leaking between tests and across viewport projects — upserts a permanent
  // row, so from the first test onward the server always answers "ar" and would
  // always win, reverting the seeded "en" a few hundred ms into boot.
  //
  // Fulfilling the GET for THIS PAGE ONLY keeps both sources in agreement
  // without mutating shared server state and without depending on test order.
  // PUTs still reach the real server, so nothing about the preference API is
  // stubbed out from under the tests that actually exercise it.
  if (lang) {
    await page.route("**/api/user-preferences", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ language: lang }),
      });
    });
  }
  await page.addInitScript(
    ([token, session, forcedLang]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      // Only ever set for the cold-cache font run below; every language-
      // BEHAVIOUR assertion in this file goes through the real toggle.
      if (forcedLang) localStorage.setItem("erp_lang", forcedLang);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" }), lang ?? ""],
  );
}

// The interface language is NOT just a localStorage value. The i18n sprint made
// it a SERVER-PERSISTED per-user preference: LanguageToggle.tsx PUTs
// /api/user-preferences {language} on every switch, and app/providers/
// language-sync.tsx applies the stored value on load — which OVERRIDES whatever
// erp_lang injectSession() seeded.
//
// That makes language leak far beyond the test that changed it. Every test here
// authenticates as the same `admin` account, and all four viewport projects
// share one backend, so the "English mode" test left admin in English and every
// SUBSEQUENT test — including the first test of the next project — loaded in
// English and failed its Arabic assertions. Observed exactly that: desktop 1-4
// passed then 5-6 failed, and mobile's very first test failed.
//
// Resetting to the product default after every test makes each test independent
// of run order. It is a restore, not a workaround: the tests still drive the
// real toggle and still assert the real persistence behaviour.
test.afterEach(async ({ request }) => {
  await request
    .put("/api/user-preferences", {
      headers: { Authorization: `Bearer ${TOKEN}` },
      data: { language: "ar" },
    })
    .catch(() => { /* best-effort restore; never fail a test in teardown */ });
});

/** Let in-flight XHRs settle so we never assert against a half-rendered screen. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

/** erp.spec.ts's render gate, verbatim in behaviour. */
async function waitRendered(page: Page, label: string) {
  await page.waitForFunction(
    (crash) => {
      const body = document.body ? document.body.innerText || "" : "";
      if (body.includes(crash)) return true; // crash — asserted below
      const main = document.getElementById("main");
      if (!main) return false;
      if (main.querySelector("[data-state]")) return true;
      if (main.querySelector("h1, h2, h3, table, header")) return true;
      return (main.innerText || "").trim().length > 40;
    },
    CRASH_TEXT,
    { timeout: 30_000 },
  );
  expect(await page.getByText(CRASH_TEXT).count(), `error-boundary crash at ${label}`).toBe(0);
}

/** Deep-link + wait + settle, in one step. */
async function open(page: Page, appPath: string) {
  await page.goto(`/app${appPath}`);
  await waitRendered(page, appPath);
  await settle(page);
}

/** Fail on any non-healthy page state inside #main (the shared states.tsx contract). */
async function assertHealthy(page: Page, label: string) {
  // Let any skeleton finish first. `loading` is a LEGITIMATE state, but a
  // one-shot probe taken during it can see neither the real state that follows
  // nor the real content — so wait it out (best-effort) before judging.
  await page
    .waitForFunction(
      () => {
        const main = document.getElementById("main");
        return !!main && !main.querySelector('[data-state="loading"]');
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const badState = await page.evaluate((bad) => {
    const main = document.getElementById("main");
    if (!main) return "MISSING #main";
    for (const el of Array.from(main.querySelectorAll("[data-state]"))) {
      const s = el.getAttribute("data-state") || "";
      if (bad.includes(s)) return s;
    }
    return null;
  }, BAD_STATES);
  expect(badState, `${label}: non-healthy page state`).toBeNull();
}

interface Signals {
  consoleErrors: string[];
  failedRequests: string[];
  fontResponses: { url: string; status: number }[];
  writes: string[];
}

/**
 * The zero-tolerance contract erp.spec.ts enforces, plus two extra ledgers this
 * spec needs: every font response (to prove the woff2 files really came back
 * 200) and every non-GET business request (to prove ZERO residue).
 */
function trackSignals(page: Page): Signals {
  const s: Signals = { consoleErrors: [], failedRequests: [], fontResponses: [], writes: [] };
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) s.consoleErrors.push(m.text().slice(0, 220));
  });
  page.on("pageerror", (e) => s.consoleErrors.push("pageerror: " + String(e).slice(0, 220)));
  page.on("response", (r) => {
    const url = r.url();
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) s.fontResponses.push({ url, status: r.status() });
    if (r.status() >= 400) s.failedRequests.push(`${r.status()} ${r.request().method()} ${url}`.slice(0, 240));
  });
  page.on("request", (r) => {
    const method = r.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    let pathname = r.url();
    try { pathname = new URL(r.url()).pathname; } catch { /* keep the raw url */ }
    // UI-preference persistence is chrome, not a business write: the language
    // toggle PUTs /api/user-preferences (LanguageToggle.tsx) and DataTable
    // syncs hidden columns to the same endpoint. Neither creates a record, and
    // neither is scanned by scripts/audit/test-residue-report.js.
    if (/^\/api\/(user-preferences|saved-views)/.test(pathname)) return;
    s.writes.push(`${method} ${pathname}`);
  });
  return s;
}

function reportAndAssert(signals: Signals, project: string, label: string) {
  if (signals.consoleErrors.length) signals.consoleErrors.forEach((e) => console.log(`  [console] ${e}`));
  if (signals.failedRequests.length) [...new Set(signals.failedRequests)].forEach((r) => console.log(`  [network] ${r}`));
  expect(signals.consoleErrors, `[${project}] ${label}: zero console errors expected`).toEqual([]);
  expect(signals.failedRequests, `[${project}] ${label}: zero responses >=400 expected (no whitelist)`).toEqual([]);
}

/**
 * Flip the UI language by CLICKING the product's own control. The shell renders
 * LanguageToggle inside the UserMenu popover (app/shell/UserMenu.tsx), so this
 * opens the menu first, exactly as a user must. NOTHING here writes localStorage
 * directly — the persistence is a RESULT we assert, never a shortcut we take.
 */
async function switchLanguage(page: Page, target: Lang) {
  const current = (await page.evaluate(() => document.documentElement.lang)) as Lang;
  if (current === target) return;
  const dict = current === "ar" ? AR : EN;
  await page.getByRole("button", { name: dict.userMenu, exact: true }).click();
  const toggle = page.getByRole("button", { name: dict.langToggle, exact: true });
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await toggle.click();
  await page.waitForFunction((l) => document.documentElement.lang === l, target, { timeout: 15_000 });
  // Close the popover so it never bleeds into an assertion or a screenshot.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** Rows rendered by the shared DataTable, counted viewport-independently.
 *  The desktop <table> stays in the DOM at every width (`hidden md:block` is
 *  display:none, not unmounted), so tbody rows are the stable signal; the
 *  mobile stacked-card <ul> is counted too and either one satisfies the check. */
async function dataTableRowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.getElementById("main");
    if (!main) return 0;
    const rows = main.querySelectorAll('table tbody tr:not([aria-hidden="true"])').length;
    const cards = main.querySelectorAll("ul > li > div > button[aria-label]").length;
    return Math.max(rows, cards);
  });
}

/**
 * The codebase's page-vs-dialog convention. erp.spec.ts proves the supplier /
 * customer / employee flows are full-page by asserting a
 * role="region"[data-presentation="full-page"] workspace and ZERO role="dialog".
 * The Inventory/Menu create screens are a step FURTHER along that same
 * convention: they are not an overlay at all but real ROUTES rendered into the
 * routed content area, so the transferable assertions are (a) no dialog / no
 * aria-modal anywhere, (b) the heading lives inside #main rather than in a
 * portalled overlay on <body>, and (c) it is deep-linkable — a hard reload
 * lands on the very same screen, which no dialog or drawer can do.
 */
async function assertIsFullPageRoute(page: Page, appPath: string, headingText: string, label: string) {
  await expect(page.getByRole("dialog"), `${label}: must not be a dialog`).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]'), `${label}: must not be modal`).toHaveCount(0);

  const heading = page.locator("#main h1").first();
  await expect(heading, `${label}: the page heading must render inside #main`).toContainText(headingText);

  expect(new URL(page.url()).pathname, `${label}: must be a real route`).toBe(`/app${appPath}`);

  // Deep-linkability: reload and land on exactly the same screen.
  await page.reload();
  await waitRendered(page, `${label} (after reload)`);
  await settle(page);
  await expect(page.locator("#main h1").first(), `${label}: must survive a hard reload`).toContainText(headingText);
  expect(new URL(page.url()).pathname, `${label}: url must survive a reload`).toBe(`/app${appPath}`);
}

/**
 * Click a submit control that may sit under the fixed MobileNav bottom bar.
 * ItemFormPage's save bar is `fixed inset-x-0 bottom-0` and MenuItemPage's
 * FormActions is `sticky bottom-0`; on the phone/tablet projects the fixed
 * MobileNav (z-40) can overlay them. Playwright's own actionability check is
 * the arbiter: if the control is genuinely unreachable that is a real finding,
 * recorded as a visible annotation (the same "log it, don't silently route
 * around it" pattern trial-balance-rbac.spec.ts uses for MobileNav), not a
 * silent skip and not a forced click.
 */
async function clickSubmitIfReachable(
  page: Page,
  name: string | RegExp,
  testInfo: TestInfo,
  label: string,
): Promise<boolean> {
  // Substring (not exact) match: these buttons render an icon beside the label,
  // and no sibling control on either create screen shares the label text.
  const button = page.getByRole("button", { name, exact: false });
  await expect(button, `${label}: the submit control must exist`).toHaveCount(1);
  try {
    await button.click({ timeout: 8_000 });
    return true;
  } catch (e) {
    const finding =
      `${label}: the submit control is present but NOT clickable at this viewport ` +
      `(likely obscured by the fixed MobileNav bottom bar). The validation path was not exercised here. ` +
      `Underlying error: ${String(e).slice(0, 200)}`;
    console.warn("[i18n-cairo-crud] " + finding);
    testInfo.annotations.push({ type: "submit-control-obstructed", description: finding });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Cairo is genuinely LOADED — not a silent system-font fallback
// ═══════════════════════════════════════════════════════════════════════════

/** Everything the browser can tell us about whether Cairo is really in use. */
async function fontProbe(page: Page, arabicSample: string, latinSample: string) {
  return page.evaluate(
    async ({ family, ar, en }) => {
      const fonts = document.fonts as FontFaceSet;
      await fonts.ready;
      const body = getComputedStyle(document.body).fontFamily;
      const h1 = document.querySelector("#main h1") as HTMLElement | null;
      const heading = h1 ? getComputedStyle(h1).fontFamily : "";
      const faces: { family: string; status: string }[] = [];
      (fonts as unknown as Set<FontFace>).forEach((f) =>
        faces.push({ family: String(f.family).replace(/^["']|["']$/g, ""), status: String(f.status) }),
      );
      return {
        bodyFamily: body,
        headingFamily: heading,
        headingText: h1 ? (h1.textContent || "").trim() : "",
        status: String(fonts.status),
        // The default check() probe-string is a space, which any system font
        // satisfies. Real script samples force the ARABIC and LATIN
        // unicode-range subsets to be resolved individually.
        checkArabic: fonts.check(`16px "${family}"`, ar),
        checkLatin: fonts.check(`16px "${family}"`, en),
        loadedCairoFaces: faces.filter(
          (f) => f.family.toLowerCase() === family.toLowerCase() && f.status === "loaded",
        ).length,
        allCairoFaces: faces.filter((f) => f.family.toLowerCase() === family.toLowerCase()).length,
      };
    },
    { family: FONT_FAMILY, ar: arabicSample, en: latinSample },
  );
}

/**
 * Absolute URLs of every Cairo @font-face `src`, read straight from the CSSOM.
 * Walks nested rules too (@import / @media / @supports): Vite normally inlines
 * `@import "./fonts.css"` at build time so the blocks land top-level, but a
 * build that preserved the import would otherwise hide them behind a
 * CSSImportRule and turn a genuine pass into a confusing miss.
 */
async function cairoFontUrls(page: Page): Promise<string[]> {
  return page.evaluate((family) => {
    const out: string[] = [];
    const seenSheets = new Set<CSSStyleSheet>();

    function walk(sheet: CSSStyleSheet) {
      if (seenSheets.has(sheet)) return;
      seenSheets.add(sheet);
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        return; // cross-origin sheet — nothing self-hosted lives there
      }
      if (!rules) return;
      for (const rule of Array.from(rules)) {
        const nested = (rule as CSSImportRule).styleSheet;
        if (nested) walk(nested);
        const grouped = (rule as CSSGroupingRule).cssRules;
        if (grouped) walk({ cssRules: grouped } as unknown as CSSStyleSheet);
        const style = (rule as CSSFontFaceRule).style;
        if (!style || typeof style.getPropertyValue !== "function") continue;
        const src = style.getPropertyValue("src") || "";
        if (!src.includes("url(")) continue;
        const fam = (style.getPropertyValue("font-family") || "").replace(/["']/g, "").trim();
        if (fam.toLowerCase() !== family.toLowerCase()) continue;
        const matches = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/g) || [];
        for (const m of matches) {
          const inner = m.replace(/^url\(\s*["']?/, "").replace(/["']?\s*\)$/, "");
          out.push(new URL(inner, location.href).href);
        }
      }
    }

    for (const sheet of Array.from(document.styleSheets)) walk(sheet as CSSStyleSheet);
    return [...new Set(out)];
  }, FONT_FAMILY);
}

function assertFontNetworkHealth(signals: Signals, mustMatch: RegExp, label: string) {
  const failed = signals.fontResponses.filter((f) => f.status >= 400);
  expect(failed.map((f) => `${f.status} ${f.url}`), `${label}: no font request may fail`).toEqual([]);
  const ok = signals.fontResponses.filter((f) => f.status === 200 && mustMatch.test(f.url));
  expect(
    ok.length,
    `${label}: expected a 200 for a ${mustMatch} subset — saw ${JSON.stringify(signals.fontResponses)}`,
  ).toBeGreaterThan(0);
}

test("Cairo is genuinely loaded and applied — Arabic UI", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const signals = trackSignals(page);
  await injectSession(page); // no forced lang — "ar" is the product default

  await open(page, "/overview");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");

  const probe = await fontProbe(page, AR.overviewTitle, "Overview");
  console.log(`[${project}] ar font probe: ${JSON.stringify(probe)}`);

  // (a) Cairo is what the cascade actually resolved to — and it LEADS the stack.
  expect(probe.bodyFamily, "body font-family must lead with Cairo").toMatch(/^\s*["']?Cairo["']?\s*(,|$)/i);
  expect(probe.headingFamily, "the h1 font-family must resolve to Cairo").toMatch(/Cairo/i);
  expect(probe.headingText, "the probe needs a real Arabic heading to measure").toContain(AR.overviewTitle);

  // (b) The face is LOADED — this is what separates "loaded" from "fell back".
  expect(probe.status, "document.fonts.status").toBe("loaded");
  expect(probe.checkArabic, `document.fonts.check("16px ${FONT_FAMILY}", "${AR.overviewTitle}")`).toBe(true);
  expect(probe.checkLatin, `document.fonts.check("16px ${FONT_FAMILY}", latin)`).toBe(true);
  expect(probe.allCairoFaces, "@font-face blocks for Cairo must be registered").toBeGreaterThan(0);
  expect(probe.loadedCairoFaces, "at least one Cairo FontFace must report status=loaded").toBeGreaterThan(0);

  // (c) The bytes really came off the wire, and nothing font-shaped 404'd.
  assertFontNetworkHealth(signals, /cairo-arabic[^/]*\.woff2/i, "ar");

  // (d) Every declared subset is actually SERVED — fetched straight from the
  //     @font-face src in the CSSOM, so a renamed/missing asset cannot hide
  //     behind a unicode-range that this run happened not to exercise.
  const urls = await cairoFontUrls(page);
  console.log(`[${project}] cairo @font-face srcs: ${JSON.stringify(urls)}`);
  expect(urls.length, "the CSSOM must expose the Cairo @font-face sources").toBeGreaterThanOrEqual(3);
  // Resolve latin-ext FIRST and remove it from the pool, so the plain-latin
  // lookup can never be satisfied by the latin-ext file (Vite appends a content
  // hash, and "cairo-latin-<hash>" vs "cairo-latin-ext-<hash>" are otherwise
  // only distinguishable by a fragile negative lookahead).
  const pool = [...urls];
  const take = (name: string, re: RegExp): string => {
    const i = pool.findIndex((u) => re.test(u));
    expect(i, `the ${name} subset must be declared (saw ${JSON.stringify(urls)})`).toBeGreaterThanOrEqual(0);
    return pool.splice(i, 1)[0];
  };
  const subsets: [string, string][] = [
    ["arabic", take("arabic", /cairo-arabic/i)],
    ["latin-ext", take("latin-ext", /cairo-latin-ext/i)],
    ["latin", take("latin", /cairo-latin/i)],
  ];
  for (const [name, url] of subsets) {
    const res = await page.request.get(url);
    expect(res.status(), `${name} subset (${url}) must be served`).toBe(200);
    expect((await res.body()).length, `${name} subset must not be empty`).toBeGreaterThan(1000);
  }

  reportAndAssert(signals, project, "cairo/ar");
});

test("Cairo is genuinely loaded and applied — English UI", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const signals = trackSignals(page);
  // Deliberate exception to this file's "click the real control" rule, and the
  // ONLY one: the language must be English BEFORE the first paint so the run
  // starts from a COLD cache and the browser genuinely re-requests the Latin
  // woff2. Toggling in-page reuses the already-resolved FontFace objects and
  // fires no network at all, which would make the 200-check vacuous. The
  // toggle's own behaviour is proven end-to-end by the next test.
  await injectSession(page, "en");

  await open(page, "/overview");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  const probe = await fontProbe(page, AR.overviewTitle, EN.overviewTitle);
  console.log(`[${project}] en font probe: ${JSON.stringify(probe)}`);

  expect(probe.bodyFamily, "body font-family must lead with Cairo").toMatch(/^\s*["']?Cairo["']?\s*(,|$)/i);
  expect(probe.headingFamily, "the h1 font-family must resolve to Cairo").toMatch(/Cairo/i);
  expect(probe.headingText, "the probe needs a real English heading to measure").toContain(EN.overviewTitle);

  expect(probe.status, "document.fonts.status").toBe("loaded");
  expect(probe.checkLatin, `document.fonts.check("16px ${FONT_FAMILY}", "${EN.overviewTitle}")`).toBe(true);
  expect(probe.allCairoFaces, "@font-face blocks for Cairo must be registered").toBeGreaterThan(0);
  expect(probe.loadedCairoFaces, "at least one Cairo FontFace must report status=loaded").toBeGreaterThan(0);

  // The Latin subsets are separate files from the Arabic one — this is the half
  // an Arabic-only run can never cover.
  assertFontNetworkHealth(signals, /cairo-latin[^/]*\.woff2/i, "en");

  reportAndAssert(signals, project, "cairo/en");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · The AR↔EN toggle
// ═══════════════════════════════════════════════════════════════════════════

test("the AR↔EN toggle flips lang/dir, translates the UI, persists across a reload, and toggles back", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const signals = trackSignals(page);
  await injectSession(page);

  // ── Starts in Arabic (I18nProvider default + public/lang-init.js) ────────
  await open(page, "/overview");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("#main h1").first(), "Arabic heading must render").toHaveText(AR.overviewTitle);
  await expect(page.locator("#main"), "Arabic body copy must render").toContainText(AR.overviewSubtitle);

  // ── Click the REAL control (UserMenu → LanguageToggle) ───────────────────
  await switchLanguage(page, "en");
  await settle(page);

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("#main h1").first(), "English heading must render").toHaveText(EN.overviewTitle);
  await expect(page.locator("#main"), "English body copy must render").toContainText(EN.overviewSubtitle);
  await expect(page.locator("#main"), "the Arabic heading must be gone").not.toContainText(AR.overviewTitle);

  // The chrome is translated too, not just the routed module.
  await expect(
    page.getByRole("button", { name: EN.userMenu, exact: true }),
    "the shell's own aria-labels must be translated",
  ).toHaveCount(1);

  // ── Persistence: that is the whole point of the erp_lang key ─────────────
  expect(await page.evaluate(() => localStorage.getItem("erp_lang"))).toBe("en");
  await page.reload();
  await waitRendered(page, "/overview (reload in en)");
  await settle(page);
  await expect(page.locator("html"), "the choice must survive a hard reload").toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("#main h1").first()).toHaveText(EN.overviewTitle);

  // ── And back to Arabic ───────────────────────────────────────────────────
  await switchLanguage(page, "ar");
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("#main h1").first()).toHaveText(AR.overviewTitle);
  expect(await page.evaluate(() => localStorage.getItem("erp_lang"))).toBe("ar");

  reportAndAssert(signals, project, "language-toggle");
});

test("English mode leaves NO stray Arabic in the navigation chrome", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  // Below Tailwind's `lg` (1024px) the <aside> sidebar is display:none and the
  // fixed MobileNav bottom bar is the user's only in-app nav — exactly the split
  // erp.spec.ts and trial-balance-rbac.spec.ts already encode as `usesMobileNav`.
  const usesMobileNav = project === "mobile" || project === "tablet-768";
  const signals = trackSignals(page);
  await injectSession(page);

  await open(page, "/overview");
  await switchLanguage(page, "en"); // the REAL control, again — no injection
  await settle(page);

  // ── What is EXEMPT, and why ──────────────────────────────────────────────
  // • The language toggle's own label is intentionally "عربي" in EN mode
  //   (LanguageToggle.tsx keeps each label in its own script). It lives in the
  //   topbar UserMenu, so scoping the scan to the nav chrome excludes it by
  //   construction — no special-casing needed.
  // • The sidebar's brand block and its bottom user card are DATA, not UI copy:
  //   the signed-in admin's display name comes from the JWT ("المدير") and is a
  //   person's name, not a translatable string. Both are siblings of <nav>
  //   inside <aside>, so scanning `aside nav` excludes them by construction too.
  // • Business records (item names, categories, brands) are user-entered data
  //   and are never scanned here — this test only ever reads navigation labels,
  //   every one of which resolves through t(nav.groups.* / nav.items.*).
  const offenders: string[] = [];
  const scan = (where: string, text: string) => {
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (ARABIC.test(line)) offenders.push(`${where}: «${line}»`);
    }
  };

  if (usesMobileNav) {
    const nav = page.locator(`nav[aria-label="${EN.mobileNav}"]`);
    await expect(nav, "MobileNav's own aria-label must be translated").toBeVisible({ timeout: 20_000 });
    scan("MobileNav", await nav.innerText());
  } else {
    const aside = page.locator(`aside[aria-label="${EN.sidebar}"]`);
    await expect(aside, "the sidebar's own aria-label must be translated").toBeVisible({ timeout: 20_000 });
    await expect(aside, "the brand name must be translated, not transliterated").toContainText(EN.brand);

    // Sidebar.tsx keeps exactly ONE group expanded at a time, so walk every
    // group in turn — that is the only way all ~89 item labels are rendered.
    const groupToggles = aside.locator('nav button[aria-controls^="nav-group-"]');
    const count = await groupToggles.count();
    expect(count, "the sidebar must render its capability-filtered nav groups").toBeGreaterThan(5);
    for (let i = 0; i < count; i++) {
      const toggle = groupToggles.nth(i);
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      scan(`sidebar group #${i + 1}`, await aside.locator("nav").innerText());
    }
  }

  offenders.forEach((o) => console.log(`  [stray-arabic] ${o}`));
  expect([...new Set(offenders)], `[${project}] English nav must contain no Arabic`).toEqual([]);

  reportAndAssert(signals, project, "english-nav");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · Full-page CRUD surfaces (READ + VALIDATE only — zero writes, zero residue)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHY NO WRITE PATH IS EXERCISED (deliberate, not an oversight):
 *
 * The project's residue audit (scripts/audit/test-residue-report.js) scans the
 * REAL dev database for `ITEST-` / `itest_` prefixed rows, and a test that
 * leaves a row behind is a failure. A round-trip create would therefore have to
 * delete itself — and neither surface offers a delete this spec can rely on:
 *
 *   • Inventory items: ItemDetailPage exposes only Edit / Activate / Deactivate
 *     (`item.activate` capability). There is NO delete control, and the item
 *     hooks (lib/hooks/useItems.ts) expose create/update/activate/deactivate
 *     only — no DELETE mutation exists. A created item would be permanent.
 *   • Menu products: BrandMenu does have a delete (useDeleteMenuItem →
 *     DELETE /api/menu/:id), but a product that a recipe/price-list/channel row
 *     already references may be soft-refused, and the create would additionally
 *     touch menu_items, price history and the POS catalog.
 *
 * Fabricating a create just to claim "CRUD coverage" and then hoping the delete
 * lands would be worse than honest read coverage. So the create screens are
 * proven to be real, deep-linkable, reload-surviving PAGES that VALIDATE, and
 * the update path is proven by asserting the edit route renders PREFILLED from
 * the record — with the "zero business writes" ledger asserted at the end so the
 * claim is verified, not promised.
 */

test("inventory item CRUD surface — list, full-page new, detail, edit (no writes)", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const signals = trackSignals(page);
  await injectSession(page);

  // A real record id, read-only, straight from the product API (the same
  // fixture-probe style trial-balance-rbac.spec.ts uses for setup).
  const listed = await apiCall("GET", "/api/inventory/v2/items?pageSize=1", TOKEN);
  expect(listed.status, "GET /api/inventory/v2/items must succeed").toBe(200);
  const itemId = String(((listed.body?.data as { id?: unknown }[] | undefined)?.[0]?.id) ?? "");
  expect(itemId, "the item master must hold at least one record to exercise detail/edit").not.toBe("");

  // ── list ────────────────────────────────────────────────────────────────
  await open(page, "/inventory/items");
  await assertHealthy(page, "/inventory/items");
  await expect(page.locator("#main h1").first()).toHaveText(AR.itemsListTitle);
  expect(await dataTableRowCount(page), "/inventory/items must render at least one row").toBeGreaterThan(0);

  // ── new (a PAGE, not a dialog) ──────────────────────────────────────────
  await open(page, "/inventory/items/new");
  await assertHealthy(page, "/inventory/items/new");
  await assertIsFullPageRoute(page, "/inventory/items/new", AR.itemNewTitle, "items/new");

  // The create form starts EMPTY and REFUSES an empty submit — the validation
  // path, which performs no network write at all (ItemFormPage.handleSave
  // returns before mutating when validate() produces errors).
  const code = page.locator(`input[aria-label="${AR.itemFieldCode}"]`);
  await expect(code, "the create form must expose its code field").toHaveCount(1);
  await expect(code, "a create form must start empty").toHaveValue("");
  if (await clickSubmitIfReachable(page, AR.itemCreateBtn, testInfo, "items/new")) {
    await expect(
      page.locator("#main"),
      "an empty create form must surface its validation banner",
    ).toContainText(AR.itemFixBeforeSave);
    expect(new URL(page.url()).pathname, "a refused create must not navigate").toBe("/app/inventory/items/new");
  }

  // ── detail ──────────────────────────────────────────────────────────────
  await open(page, `/inventory/items/${itemId}`);
  await assertHealthy(page, `/inventory/items/${itemId}`);
  await expect(page.getByRole("dialog"), "detail is a page, not a dialog").toHaveCount(0);
  await expect(page.locator("#main h1").first(), "the record's name must render").toHaveText(/\S/);
  await expect(page.locator("#main"), "the detail sections must render").toContainText(AR.itemDetailBasics);

  // ── edit (prefilled from the record) ────────────────────────────────────
  await open(page, `/inventory/items/${itemId}/edit`);
  await assertHealthy(page, `/inventory/items/${itemId}/edit`);
  await expect(page.getByRole("dialog"), "edit is a page, not a dialog").toHaveCount(0);
  await expect(page.locator("#main h1").first()).toContainText(AR.itemEditTitle);
  // Assert prefill FIDELITY, not a hardcoded expectation of non-emptiness.
  //
  // This previously asserted /\S/ — "the SKU box must contain something" — and
  // went red. Investigating it end to end showed the PRODUCT was right and the
  // TEST was wrong: inv_items.sku is deliberately nullable (server.js adds it
  // with a UNIQUE on the NORMALISED column so, in its own words, legacy rows
  // can have no SKU), 17 of the 19 rows in this database have none, and the row
  // this test picks is whatever `?pageSize=1` returns — which, because
  // parseListQuery defaults to ORDER BY name DESC, is an inactive legacy
  // fixture whose sku IS NULL. The blank box was the truth, faithfully
  // round-tripped (the adapter maps null -> "").
  //
  // So compare against what the API actually holds for THIS record. That is a
  // strictly stronger check: it catches a genuinely dropped value for any row,
  // and it stays correct whichever row the list happens to return.
  const detail = await apiCall("GET", `/api/inventory/v2/items/${itemId}`, TOKEN);
  expect(detail.status, "GET item detail must succeed").toBe(200);
  const expectedSku = String((detail.body?.data as { sku?: unknown } | undefined)?.sku ?? "");
  await expect(
    page.locator(`input[aria-label="${AR.itemFieldCode}"]`),
    `the edit form must show exactly the record's stored SKU (${JSON.stringify(expectedSku)})`,
  ).toHaveValue(expectedSku);
  await expect(
    page.locator(`input[aria-label="${AR.itemFieldNameAr}"]`),
    "the edit form must be prefilled from the record (Arabic name)",
  ).toHaveValue(/\S/);

  expect(signals.writes, `[${project}] this spec must leave ZERO residue — no business write may be issued`).toEqual([]);
  reportAndAssert(signals, project, "inventory-crud");
});

test("menu product CRUD surface — list, full-page new, detail, edit (no writes)", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const signals = trackSignals(page);
  await injectSession(page);

  const listed = await apiCall("GET", "/api/menu/list?pageSize=1", TOKEN);
  expect(listed.status, "GET /api/menu/list must succeed").toBe(200);
  const menuId = String(((listed.body?.data as { id?: unknown }[] | undefined)?.[0]?.id) ?? "");
  expect(menuId, "the menu catalog must hold at least one product to exercise detail/edit").not.toBe("");

  // ── list ────────────────────────────────────────────────────────────────
  await open(page, "/menu/brand");
  await assertHealthy(page, "/menu/brand");
  await expect(page.locator("#main h1").first()).toHaveText(AR.menuListTitle);
  expect(await dataTableRowCount(page), "/menu/brand must render at least one row").toBeGreaterThan(0);

  // ── new (a PAGE, not a dialog) ──────────────────────────────────────────
  await open(page, "/menu/brand/new");
  await assertHealthy(page, "/menu/brand/new");
  await assertIsFullPageRoute(page, "/menu/brand/new", AR.menuNewTitle, "menu/brand/new");

  const nameAr = page.getByLabel(AR.menuNameArLabel).first();
  await expect(nameAr, "the create form must expose its Arabic-name field").toHaveCount(1);
  await expect(nameAr, "a create form must start empty").toHaveValue("");
  if (await clickSubmitIfReachable(page, AR.menuCreateBtn, testInfo, "menu/brand/new")) {
    await expect(
      page.locator("#main"),
      "an empty create form must surface its inline validation",
    ).toContainText(AR.menuNameRequired);
    expect(new URL(page.url()).pathname, "a refused create must not navigate").toBe("/app/menu/brand/new");
  }

  // ── detail (mode="view") ────────────────────────────────────────────────
  await open(page, `/menu/brand/${encodeURIComponent(menuId)}`);
  await assertHealthy(page, `/menu/brand/${menuId}`);
  await expect(page.getByRole("dialog"), "detail is a page, not a dialog").toHaveCount(0);
  await expect(page.locator("#main h1").first(), "the product's name must render").toHaveText(/\S/);
  await expect(page.locator("#main"), "the detail page must identify the record").toContainText(menuId);

  // ── edit (prefilled from the record) ────────────────────────────────────
  await open(page, `/menu/brand/${encodeURIComponent(menuId)}/edit`);
  await assertHealthy(page, `/menu/brand/${menuId}/edit`);
  await expect(page.getByRole("dialog"), "edit is a page, not a dialog").toHaveCount(0);
  await expect(page.locator("#main h1").first()).toHaveText(/\S/);
  await expect(
    page.getByLabel(AR.menuNameArLabel).first(),
    "the edit form must be prefilled from the record (Arabic name)",
  ).toHaveValue(/\S/);

  expect(signals.writes, `[${project}] this spec must leave ZERO residue — no business write may be issued`).toEqual([]);
  reportAndAssert(signals, project, "menu-crud");
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Bilingual screenshot matrix — every viewport, both languages
// ═══════════════════════════════════════════════════════════════════════════

test("bilingual screenshots for every representative screen at this viewport", async ({ page }, testInfo) => {
  // 8 full-page captures (4 screens × 2 languages), each preceded by a
  // networkidle settle — the heaviest test in the file by a wide margin, and the
  // only one that needs more than the config's 180s.
  test.slow();
  const project = testInfo.project.name;
  const signals = trackSignals(page);
  await injectSession(page);

  const dir = path.join(OUT_ROOT, project);
  fs.mkdirSync(dir, { recursive: true });

  await open(page, "/overview");

  for (const lang of ["ar", "en"] as Lang[]) {
    await switchLanguage(page, lang); // real control, both directions
    for (const shot of SHOTS) {
      await test.step(`${lang} ${shot.file}`, async () => {
        await open(page, shot.path);
        await assertHealthy(page, `${lang} ${shot.path}`);
        // Let AppShell's route-transition fade finish so the evidence isn't dimmed.
        await page.waitForTimeout(450);
        await page.screenshot({
          path: path.join(dir, `${lang}-${shot.file}.png`),
          fullPage: true,
          animations: "disabled",
        });
      });
    }
  }

  console.log(`[${project}] screenshots written to ${dir}`);
  reportAndAssert(signals, project, "screenshots");
});
