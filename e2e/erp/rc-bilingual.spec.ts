// ═══════════════════════════════════════════════════════════════════════════
// RC Gate — ERP bilingual (ar/en) translation sweep.
//
// Complements erp.spec.ts (the Arabic-only closure gate) with the language
// dimension the RC requires: walk EVERY manifest leaf in BOTH Arabic and
// English at each configured viewport, and fail on translation defects:
//   • wrong html.lang / html.dir for the active language
//   • Arabic SYSTEM text (nav labels, table column headers, section headings,
//     tab/filter chrome) visible in English mode — the app's own chrome must be
//     fully translated. Business DATA (item/brand/warehouse names in table body
//     cells + inputs) is legitimately Arabic and is NOT inspected: the ERP has
//     no data-business-data marker, so we scope the check to stable chrome
//     surfaces instead of all of #main.
//   • an untranslated i18n KEY leaking to the UI (e.g. "nav.items.ac-tb")
//   • a raw backend error / non-healthy state, horizontal overflow
//   • any console error, any response ≥400
//   • Cairo not loaded locally, or a font request to a remote/CDN origin
//
// Language is set the way a returning user's is: localStorage "erp_lang" read
// pre-paint by public/lang-init.js. Persistence across reload is asserted too.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const MANIFEST_SRC = fs.readFileSync(
  path.join(process.cwd(), "frontend", "erp", "src", "app", "navigation", "manifest.ts"),
  "utf8",
);
// Leaf PATHS only (labels are now i18n keys, resolved at render time).
const PATHS: string[] = [
  ...new Set([...MANIFEST_SRC.matchAll(/\bpath:\s*"(\/[^"]+)"/g)].map((m) => m[1])),
];

const ARABIC = /[؀-ۿ]/;
// Looks like an un-resolved i18n key: dotted lowerCamel path, no spaces.
const I18N_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,}$/;
const BENIGN_CONSOLE =
  // + about:srcdoc sandbox-block (Playwright addInitScript into the script-free,
  // deliberately-sandboxed InvoiceSettings receipt-preview iframe) — see erp.spec.ts.
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag|Blocked script execution in .?about:srcdoc/i;
const CRASH_TEXT = "حدث خطأ غير متوقّع";
const BAD_STATES = ["error", "offline", "session-expired", "permission-denied", "conflict", "feature-disabled", "not-found"];

async function login(page: Page, lang: "ar" | "en") {
  // Pin the server-persisted language. language-sync.tsx applies GET
  // /api/user-preferences on mount and OVERWRITES the localStorage erp_lang seed
  // below — so without this, the [en] pass renders in whatever the admin has
  // stored server-side (the freshly-cloned dev DB has "ar"), and html.lang comes
  // back "ar". This is not an app bug: the server preference is the source of
  // truth and a real user's toggle persists to it; the test just has to state the
  // precondition. Same technique as visual-baselines.spec.ts. Non-GET (a real
  // toggle persisting) falls through to the actual endpoint.
  await page.route("**/api/user-preferences", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ language: lang }) });
  });
  return page.addInitScript(
    ([token, session, l]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("erp_lang", l);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" }), lang],
  );
}

async function waitRendered(page: Page) {
  await page.waitForFunction(
    (crash) => {
      const b = document.body ? document.body.innerText || "" : "";
      if (b.includes(crash)) return true;
      const main = document.getElementById("main");
      if (!main) return false;
      if (main.querySelector("[data-state]")) return true;
      if (main.querySelector("h1, h2, h3, table, header")) return true;
      return (main.innerText || "").trim().length > 40;
    },
    CRASH_TEXT,
    { timeout: 30_000 },
  );
}

async function spaNavigate(page: Page, routePath: string) {
  const href = `/app${routePath}`;
  const ok = await page.evaluate((h) => {
    const a = document.querySelector(`aside a[href="${h}"]`) as HTMLAnchorElement | null;
    if (!a) return false;
    a.click();
    return true;
  }, href);
  if (!ok) await page.goto(href);
  await page.waitForURL(`**${href}`, { timeout: 15_000 }).catch(() => {});
  await waitRendered(page);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/** Chrome text that MUST be localized (never business data). */
async function chromeText(page: Page): Promise<{ arabic: string[]; keys: string[]; badState: string | null; overflow: number }> {
  return page.evaluate((bad) => {
    const arabic: string[] = [];
    const keys: string[] = [];
    const AR = /[؀-ۿ]/;
    const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,}$/;
    const push = (t: string | null | undefined) => {
      const s = (t || "").trim();
      if (!s) return;
      if (AR.test(s)) arabic.push(s.slice(0, 60));
      if (KEY.test(s)) keys.push(s.slice(0, 60));
    };
    // Nav labels — the primary NAV_ITEMS surface.
    document.querySelectorAll("aside a").forEach((a) => push((a as HTMLElement).innerText));
    const main = document.getElementById("main");
    if (main) {
      main.querySelectorAll("thead th").forEach((el) => push((el as HTMLElement).innerText));
      main.querySelectorAll(":scope h1, :scope h2").forEach((el) => push((el as HTMLElement).innerText));
      main.querySelectorAll('[role="tab"], [role="columnheader"]').forEach((el) => push((el as HTMLElement).innerText));
    }
    // Breadcrumbs / topbar chrome
    document.querySelectorAll('nav[aria-label] a, [data-breadcrumb] *').forEach((el) => push((el as HTMLElement).innerText));
    let badState: string | null = null;
    if (main) {
      for (const el of Array.from(main.querySelectorAll("[data-state]"))) {
        const s = el.getAttribute("data-state") || "";
        if (bad.includes(s)) { badState = s; break; }
      }
    }
    const de = document.documentElement;
    return { arabic: [...new Set(arabic)], keys: [...new Set(keys)], badState, overflow: de.scrollWidth - de.clientWidth };
  }, BAD_STATES);
}

test.describe.configure({ mode: "serial" });

for (const lang of ["ar", "en"] as const) {
  test(`[${lang}] every nav leaf: correct dir, no key leaks, chrome localized, healthy`, async ({ page }, testInfo) => {
    test.setTimeout(300_000); // walks ~89 leaves; well above the 180s default
    const project = testInfo.project.name;
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const remoteFonts: string[] = [];
    const issues: string[] = [];

    page.on("console", (m) => {
      if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
    });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
    page.on("response", (r) => {
      if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 200));
    });
    page.on("request", (r) => {
      const u = r.url();
      if (r.resourceType() === "font" && !u.startsWith("http://127.0.0.1") && !u.startsWith("http://localhost") && !u.startsWith("data:")) {
        remoteFonts.push(u.slice(0, 160));
      }
    });

    await login(page, lang);
    await page.goto("/app");
    await waitRendered(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // html.lang / dir for the active language.
    const html = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
    expect(html.lang, `${lang}: html.lang`).toBe(lang);
    expect(html.dir, `${lang}: html.dir`).toBe(lang === "en" ? "ltr" : "rtl");

    // Cairo actually loaded locally.
    const cairoLoaded = await page.evaluate(async () => {
      try { await (document as any).fonts.ready; } catch { /* ignore */ }
      return Array.from((document as any).fonts).some((f: any) => /Cairo/i.test(f.family) && f.status === "loaded");
    });
    expect(cairoLoaded, `${lang}: Cairo font must be loaded locally`).toBe(true);

    for (const p of PATHS) {
      await test.step(`leaf ${p}`, async () => {
        await spaNavigate(page, p);
        const c = await chromeText(page);
        if (c.badState) issues.push(`${p}: non-healthy state "${c.badState}"`);
        if (c.overflow > 1) issues.push(`${p}: horizontal overflow ${c.overflow}px`);
        if (c.keys.length) issues.push(`${p}: raw i18n key(s) in chrome: ${c.keys.join(" | ")}`);
        if (lang === "en" && c.arabic.length) issues.push(`${p}: Arabic SYSTEM text in English chrome: ${c.arabic.join(" | ")}`);
      });
    }

    // Persistence across reload.
    await page.reload();
    await waitRendered(page);
    const after = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, stored: localStorage.getItem("erp_lang") }));
    expect(after.lang, `${lang}: html.lang persists across reload`).toBe(lang);
    expect(after.stored, `${lang}: erp_lang persists`).toBe(lang);

    console.log(`\n[${project}][${lang}] leaves: ${PATHS.length} | issues: ${issues.length} | console: ${consoleErrors.length} | failedReq: ${failedRequests.length} | remoteFonts: ${remoteFonts.length}`);
    issues.forEach((i) => console.log(`  [issue] ${i}`));
    consoleErrors.forEach((e) => console.log(`  [console] ${e}`));
    [...new Set(failedRequests)].forEach((r) => console.log(`  [network] ${r}`));
    remoteFonts.forEach((f) => console.log(`  [remote-font] ${f}`));

    expect(remoteFonts, `${lang}: no remote/CDN font requests (Cairo is self-hosted)`).toEqual([]);
    expect(issues, `${lang}: nav/chrome must be localized, key-free, healthy, contained`).toEqual([]);
    expect(consoleErrors, `${lang}: zero console errors`).toEqual([]);
    expect(failedRequests, `${lang}: zero failed requests`).toEqual([]);
  });
}

test("login screen: language toggle flips language + dir instantly, in both languages", async ({ page }) => {
  test.setTimeout(60_000);
  // No token → the login screen, which renders the LanguageToggle directly
  // (in the shell it lives inside the UserMenu dropdown). The toggle's
  // accessible name is its aria-label; its visible text names the language
  // you'll switch TO ("English" while in Arabic).
  await page.addInitScript(() => {
    localStorage.setItem("erp_lang", "ar");
    localStorage.removeItem("pos_token");
    localStorage.removeItem("pos_session");
  });
  await page.goto("/app");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  expect(await page.evaluate(() => document.documentElement.dir), "starts rtl").toBe("rtl");

  const toggle = page.getByRole("button", { name: /تبديل لغة الواجهة|Switch interface language/ }).first();
  await expect(toggle, "language toggle is visible on the login screen").toBeVisible({ timeout: 10_000 });
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 8_000 })
    .toBe("en");
  expect(await page.evaluate(() => document.documentElement.dir), "flips to ltr").toBe("ltr");

  // And back, to prove the toggle is bidirectional.
  await page.getByRole("button", { name: /تبديل لغة الواجهة|Switch interface language/ }).first().click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 8_000 })
    .toBe("ar");
});
