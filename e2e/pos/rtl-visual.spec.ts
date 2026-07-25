// ═══════════════════════════════════════════════════════════════════════════
// RTL/LTR visual baseline matrix — /pos main screen + 2 migrated dialogs.
//
// Fixture: JWT-injection convention (same as e2e/pos/responsive.spec.ts's own
// `readEnv()` + jwt.sign + addInitScript(localStorage.setItem("pos_token")))
// rather than e2e/pos/critical-cashier-shift.spec.ts's real-login flow — this
// spec is a pure, read-only VISUAL check of already-rendered chrome; it never
// mutates shift/sale state, so there is no reason to pay the real-login +
// mandatory-password-change-bypass cost bilingual-flow.spec.ts pays.
//
// REAL BUG DISCOVERED by actually running this spec against a live server
// (not knowable from reading source ahead of time): the synthetic
// `{ id: 1, username: "admin", role: "admin", tokenVersion: 1 }` JWT —
// exactly the fixture offline.spec.ts / responsive.spec.ts also sign — logs
// in fine, but routes/pos-v2.js GET /catalog's brand-scope filter
// (`_resolveBrandScope` → `_cashierBrandId`, added by the in-flight brand/
// branch-scope redesign) resolves the `admin` DB ROW's brand as NULL — its
// `users.brand_id`, `branch_id`, AND `default_branch_id` are all NULL,
// confirmed live via a direct DB read — and the brand WHERE clause is
// `(menu.brand_id IS NULL OR menu.brand_id = ?)`. Every real menu row
// (2,000/2,000, confirmed live) carries `brand_id='SEED-BR-1'`, so an
// admin-scoped request matches ZERO rows: the catalog renders "لا نتائج"
// (no results) instead of any product card, which starved the ORIGINAL
// `main POS screen` / `ShiftDialog` tests below of the very content
// (`section[aria-label="الأصناف"] button` = a product card, and
// ShiftDialog's Numpad) they exist to screenshot.
//
// This is a backend/seed-data defect (routes/pos-v2.js + the `admin` seed
// row), not an i18n dictionary defect, and out of scope for THIS task to
// fix — flagged precisely in the task report instead. The pragmatic,
// spec-local workaround below swaps the signed identity to `seed_manager`
// (role=manager, a real seeded E2E account — see
// e2e/pos/critical-cashier-shift.spec.ts's own scratchpad-accounts
// convention for its sibling `test.cashier`/`test.custody` rows) whose DB
// row has a real `brand_id`/`branch_id` (`SEED-BR-1`/`SEED-BRANCH-1`,
// confirmed live) AND a stable `token_version=1` that matches this
// hardcoded `tokenVersion: 1` claim (unlike `test.cashier`, whose real
// token_version drifts upward every time critical-cashier-shift.spec.ts's
// mandatory-password-change flow runs — confirmed live at 39 during this
// same session — which would 401 a hardcoded-version JWT). None of the
// three tests below (main screen / Header-More / ShiftDialog) touch any
// admin-only UI, so the role swap costs nothing here.
//
// Language is set directly via localStorage("pos_lang") in the SAME
// addInitScript that seeds the token — this spec exists to prove RENDERING
// at a given persisted language, not the interactive toggle itself (that is
// e2e/pos/bilingual-flow.spec.ts's job, steps 4-5 + 23).
//
// Baselines are written under e2e/pos/rtl-visual.spec.ts-snapshots/ by
// Playwright's own DEFAULT convention (test-file-basename + project name +
// platform, e.g. pos-main-ar-desktop-win32.png) — that IS "Playwright's
// default convention"; a literal `__screenshots__/` directory is not.
// One set per viewport project this spec is wired into
// (playwright.pos.config.ts: desktop=1440x900, mobile-390=390x844,
// tablet-768=768x1024) × ar/en.
//
// NOTE: generating/updating baselines requires a live MySQL + built POS
// bundle (see playwright.pos.config.ts's webServer) — see this task's own
// report for exactly what was actually run in this environment.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

/* eslint-disable @typescript-eslint/no-var-requires */
const jwt = require("jsonwebtoken");

function readEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

async function gotoAsAdmin(page: import("@playwright/test").Page, lang: "ar" | "en"): Promise<void> {
  const env = readEnv();
  // username/role: "seed_manager"/"manager" — NOT the literal `admin` account.
  // See file header "REAL BUG DISCOVERED" note: the `admin` DB row has no
  // brand_id/branch_id, so routes/pos-v2.js's brand-scope filter starves it
  // of every catalog row. `seed_manager` resolves a real brand/branch and
  // has a stable token_version=1 matching this hardcoded claim. Function
  // name kept as `gotoAsAdmin` (not renamed) only to keep this diff minimal
  // against the rest of the file — it now signs a manager identity.
  const token = jwt.sign(
    // id: 33 is seed_manager's REAL users.id (confirmed live) — not a guess.
    // lib/sessionVersion.js's tokenVersion check keys off decoded.id, and
    // several write paths (audit log, etc.) can reference req.user.id as a
    // real FK, so this must be the actual row id, not a placeholder.
    { id: 33, username: "seed_manager", role: "manager", name: "Seed Manager", tokenVersion: 1 },
    env.JWT_SECRET,
    { expiresIn: "30m" },
  );
  await page.addInitScript(
    ({ tok, l }) => {
      localStorage.setItem("pos_token", tok);
      localStorage.setItem("pos_lang", l);
    },
    { tok: token, l: lang },
  );
  await page.goto("/pos/");
  await expect(page.getByTestId("pos-header")).toBeVisible({ timeout: 30_000 });
  // Settle: catalog fetch + image lazy-load + any entrance transition.
  await page.waitForTimeout(400);
}

const LANGS: Array<"ar" | "en"> = ["ar", "en"];

for (const lang of LANGS) {
  test.describe(`rtl-visual (${lang})`, () => {
    test(`main POS screen — catalog visible (${lang})`, async ({ page }) => {
      await gotoAsAdmin(page, lang);
      await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
      // Product CARDS only — NOT the horizontal CategoryRail duplicate that
      // App.tsx also renders inside this same section for <1024px layouts
      // (`lg:hidden`, so CSS-hidden but still in the DOM at 1440px — a bare
      // `section[aria-label="الأصناف"] button` locator resolves to that
      // hidden duplicate FIRST and times out; confirmed by a real run here.
      // Same technique as e2e/pos/bilingual-flow.spec.ts's `productCards`:
      // cards are the one button shape in this section with a <p> child
      // (name + price paragraphs); category-rail/filter chips have none.
      // The products landmark is LOCALIZED (appShell.aria.products since
      // dfb613b): "الأصناف" in Arabic, "Items" in English.
      const catalogSection = page.locator(`section[aria-label="${lang === "ar" ? "الأصناف" : "Items"}"]`);
      const productCards = catalogSection.locator("button").filter({ has: page.locator("p") });
      await expect(productCards.first()).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveScreenshot(`pos-main-${lang}.png`, {
        fullPage: true,
        animations: "disabled",
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`Header ▸ More menu open (${lang})`, async ({ page }) => {
      await gotoAsAdmin(page, lang);
      const header = page.getByTestId("pos-header");
      await header.getByRole("button", { name: /المزيد|More/ }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible({ timeout: 5_000 });
      // Screenshot the MENU element, not the full page: this test exists to
      // prove the More menu's chrome/direction/localization, and a full-page
      // shot drags in the catalog grid behind it, whose lazily-loading item
      // images vary run-to-run (a real 3%-diff flake on tablet-768).
      await expect(menu).toHaveScreenshot(`pos-header-more-${lang}.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.02,
      });
    });

    test(`ShiftDialog open (no shift) (${lang})`, async ({ page }) => {
      await gotoAsAdmin(page, lang);
      const header = page.getByTestId("pos-header");
      const openBtn = header.getByRole("button", { name: lang === "ar" ? "فتح وردية" : "Open shift", exact: true });
      await openBtn.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByTestId("numpad")).toBeVisible();
      await expect(page).toHaveScreenshot(`pos-shift-dialog-${lang}.png`, {
        fullPage: true,
        animations: "disabled",
        maxDiffPixelRatio: 0.02,
      });
    });
  });
}
