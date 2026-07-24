// ═══════════════════════════════════════════════════════════════════════════
// CO-3(b) — pinned visual baselines, every viewport, both languages.
//
// Separated from rc-inventory-menu.spec.ts on purpose. That spec's functional
// tests are hard-wired to the rc-gate-seed dataset (2000 synthetic inv_items,
// `RC-SKU-*`) in `moroccan_taste_pos_test`; CO-0 repointed the E2E webServer to
// the `moroccan_taste_pos_e2e` dev clone, so those functional tests only pass
// against their own DB (they now run under playwright.rc-gate.config.ts). The
// baselines have no such dependency — they render whatever the dev clone holds,
// with the DB-varying regions made deterministic — so they live here and run in
// the ordinary ERP e2e against the clone, not behind a `serial` block that a
// mismatched functional test can skip.
//
// This used to be an unpinned screenshot DUMP that also skipped itself on two
// of four projects. Writing a PNG nobody diffs asserts nothing — a layout
// regression at 768/1024 (the exact class the laptop-1024 Transfers overflow
// was) shipped silently — and the runtime `test.skip()` showed as SKIPPED,
// hiding the gap. Now: toHaveScreenshot at all four configured viewports
// (1440 / 390 / 768 / 1024) in ar and en — 7 screens × 2 languages × 4
// viewports = 56 baselines, diffed on every run.
//
// DETERMINISM, honestly:
//   * animations disabled + caret hidden (no frame-timing noise);
//   * the CLOCK IS FROZEN — TrialBalance.tsx seeds its filter with
//     `{ from: startOfYearISO(), to: todayISO() }`, so the date range would
//     drift daily. Masking those inputs was the wrong tool (no testids to
//     target; a mask that matches nothing rots silently), so Date is frozen at
//     the source instead;
//   * the DB-backed LIST screens (inventory-list / menu-list) are made
//     deterministic BY STATE — a fixed no-match search empties the table body
//     while the filter row + column headers (where the overflow lives) are
//     still captured. The dev clone the CRUD spec mutates cannot then drift the
//     rows out from under the baseline.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const SHOTS = path.join(process.cwd(), "artifacts", "rc-shots");
const CRASH_TEXT = "حدث خطأ غير متوقّع";

/**
 * Seeding localStorage is NOT enough to pick the language — language-sync.tsx
 * applies the SERVER-persisted preference from GET /api/user-preferences on
 * mount and overwrites the seed. Without pinning, both the ar and the en
 * baseline would render in whatever the server has stored, silently corrupting
 * the pair. Pin the response so the requested language actually renders.
 */
async function login(page: Page, lang: "ar" | "en") {
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
  await page.waitForFunction((crash) => {
    const b = document.body?.innerText || "";
    if (b.includes(crash)) return true;
    const m = document.getElementById("main");
    if (!m) return false;
    return !!m.querySelector("[data-state], h1, h2, table, header") || (m.innerText || "").trim().length > 40;
  }, CRASH_TEXT, { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

const SCREENS = [
  { id: "overview", url: "/app/overview" },
  { id: "inventory-list", url: "/app/inventory/items" },
  { id: "inventory-new", url: "/app/inventory/items/new" },
  { id: "menu-list", url: "/app/menu/brand" },
  { id: "menu-new", url: "/app/menu/brand/new" },
  { id: "trial-balance", url: "/app/accounting/trial-balance" },
  { id: "admin-users", url: "/app/administration/users" },
];

// setFixedTime (not clock.install): pins Date/now() without pausing timers, so
// react-query intervals and transitions still run normally.
const FROZEN_CLOCK = new Date("2026-06-15T09:00:00.000Z");

for (const lang of ["ar", "en"] as const) {
  test(`visual baseline [${lang}]`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.clock.setFixedTime(FROZEN_CLOCK);
    await login(page, lang);
    const vp = testInfo.project.name;
    for (const s of SCREENS) {
      await page.goto(s.url);
      await waitRendered(page);

      // Make the DB-backed list bodies deterministic by state (fixed no-match
      // search), keeping the filter row + column headers in frame.
      if (s.id === "inventory-list" || s.id === "menu-list") {
        const search = page.locator('#main input[type="search"]').first();
        await expect(search).toBeVisible({ timeout: 20_000 });
        await search.fill("ZZQZ-NO-SUCH-ROW-ZZQZ");
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(700); // server-mode search debounce
      }

      // Settle: fonts resolved (Cairo swaps in late and shifts metrics).
      await page.evaluate(() => (document as any).fonts?.ready);
      await expect(page.locator("#main")).toBeVisible();
      // Playwright appends `-{project}-{platform}` itself, so the viewport must
      // NOT be repeated here or files become "…-desktop-desktop-win32.png".
      await expect(page).toHaveScreenshot(`${s.id}--${lang}.png`, {
        animations: "disabled",
        caret: "hide",
        maxDiffPixelRatio: 0.01,
        timeout: 20_000,
      });
      // The flat artifacts/ copy a human browses during visual review.
      await page.screenshot({ path: path.join(SHOTS, `${s.id}--${lang}--${vp}.png`), fullPage: false });
    }
  });
}
