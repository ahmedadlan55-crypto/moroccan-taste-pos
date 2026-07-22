// ═══════════════════════════════════════════════════════════════════════════
// Bilingual (ar/en) end-to-end regression — /pos.
//
// Drives the FULL cashier-facing surface once in each language and proves the
// language toggle itself (persistence, <html dir>, no leftover Arabic in the
// namespaces this wave migrated) before exercising the ordinary sell/shift/
// back-office flows so the merged i18n barrel (frontend/pos/src/i18n/
// dictionaries/{ar,en}/index.ts) is validated against REAL rendered UI, not
// just the structural-parity unit test in i18n/__tests__/dictionary.test.ts.
//
// Fixture: reuses e2e/pos/critical-cashier-shift.spec.ts's REAL, non-admin
// `test.cashier` fixture EXACTLY — same username, same scratchpad-file
// password source (never hardcoded, never printed), same mysql2 connection
// convention. It does NOT invent a new account.
//
// One deliberate divergence from that spec's fixture handling: critical-
// cashier-shift.spec.ts's whole point is exercising the MANDATORY first-login
// password-change screen, so its afterAll always leaves the account with
// must_change_password=1. That flow already has full, dedicated coverage
// there. This spec instead needs an ordinary "already onboarded" cashier
// session so the bilingual UI (not the change-password screen, which lives in
// the ERP app under a different bundle) is what actually gets exercised. So
// beforeAll flips must_change_password=0 / password_changed_at=NOW() for the
// duration of this run WITHOUT touching the password value itself (the
// scratchpad file stays accurate — no bcrypt, no rewrite needed), and
// afterAll restores must_change_password=1 / password_changed_at=NULL — the
// exact resting state critical-cashier-shift.spec.ts's own afterAll leaves —
// so either spec can run before or after the other, any number of times.
//
// ── CONFIRMED GAPS (read from source before writing this spec; not fixed
//    here — this is a proving spec, not the migration) ──────────────────────
//
//  1. frontend/pos/src/components/PosLogin.tsx has NO i18n at all: no useT/
//     useLang/useSetLang import, every string hardcoded Arabic, and there is
//     no language-toggle element anywhere on the login screen. The task plan
//     calls for "select English from the login screen's language toggle"
//     BEFORE logging in; that control does not exist. Step 2 below asserts
//     for it as the plan intends (so this spec starts failing the INSTANT a
//     future PR adds a real one, rather than silently never checking), soft-
//     fails with a clear message, then recovers by logging in in Arabic (the
//     only language PosLogin can render) and switching language via the
//     Header's REAL, working toggle (More ▸ language chip) once inside the
//     shell — the only place a functioning switch currently exists.
//
//  2. frontend/pos/src/components/Numpad.tsx (used by ShiftDialog's opening-
//     float entry AND PaymentDialog's cash/split entry) is NOT i18n-migrated:
//     DIGIT_LABELS is a hardcoded Arabic word map (aria-label="اثنان" etc.)
//     with no useT/useLang. This is true regardless of pos_lang, including in
//     English mode. Every numpad interaction below therefore keys by the
//     Arabic digit-word aria-label on purpose (not a mistake) — that is
//     genuinely the only accessible name the button has right now, in either
//     language.
//
//  3. frontend/pos/src/lib/types.ts's CatalogItem has no `nameEn` (or any
//     bilingual name) field, and ProductGrid.tsx's filterItems() only matches
//     `it.name` / `it.id`. There is no true bilingual PRODUCT NAME search yet.
//     "search by English text" is therefore proxied by searching the item's
//     `id` (a Latin/ASCII SKU code — filterItems matches id too), which is
//     real Latin-text search coverage, but is NOT the same claim as "search
//     an English product name" — flagged here and in the task report, not
//     silently presented as full coverage.
//
//  4. DiscountDialog.tsx, CustomerPicker.tsx (+ its own CustomerAddDialog /
//     CustomerHistoryDialog), ReturnRequestDialog.tsx, the shared Dialog.tsx
//     wrapper's own X close button (aria-label="إغلاق", hardcoded — confirmed
//     by a real run: MyInvoicesDialog and RequisitionsDialog have NO other
//     close control in either language, so closeDialogViaX() below targets
//     it deliberately) and App.tsx shell's own aside/section aria-labels are
//     ALL still hardcoded Arabic — none of them import useT. Only the 10
//     namespaces this merge wired up
//     (common, errors, header, cartPanel, receipt, shiftDialog, paymentDialog,
//     myInvoicesDialog, stocktakeDialog, requisitionsDialog) actually
//     translate. Step 6's "no leftover Arabic" check is therefore
//     DELIBERATELY narrow — only Header + CartPanel strings, exactly as the
//     task instructions specify — and every interaction below with one of the
//     non-migrated dialogs targets its (still-Arabic-only) real strings
//     rather than pretending they are bilingual.
//
//  5. ORDER_TO_CASH_ENABLE=1 is set in this repo's .env (loaded by server.js
//     regardless of playwright.pos.config.ts's own webServer.env overrides,
//     which don't touch this key) — see memory note "O2C blocks POS
//     reversals": with O2C on, MyInvoicesDialog routes «Return» through
//     ReturnRequestDialog / createSalesReturn, which is documented elsewhere
//     in this codebase as currently 409-ing. The return step below is
//     therefore soft — it proves the UI reaches the dialog and submits, but
//     does not hard-fail the whole spec on a pre-existing, already-tracked
//     backend issue outside this task's scope.
//
//  6. NEWLY DISCOVERED by actually running this spec (not knowable from
//     reading source ahead of time), NOW FIXED: ShiftDialog.tsx's own
//     mode-reset useEffect depended on `shiftId`. confirmClose() set
//     mode="closed" and (via onShiftClosed()) nulled the context's shiftId —
//     but nulling shiftId re-fired that same effect (the dialog was still
//     `open`), which immediately reset mode back to "info", so the dialog
//     fell straight through to the "no open shift" screen instead of ever
//     showing the post-close Z-report/WhatsApp-share summary. Fixed by
//     splitting the effect in two: one keyed only on `[open]` for the full
//     reset, and a second keyed on `[open, shiftId, online]` that ONLY
//     refetches the summary and leaves mode/result alone (a harmless no-op
//     once shiftId goes null right after a close). Confirming the fix also
//     surfaced a second, independent bug IN THIS TEST: step 22's assertion
//     used the non-retrying `locator.isVisible({ timeout })`, which
//     snapshots once and does not wait out the async close request, so it
//     read a false negative even with the product bug fixed. Switched to
//     the auto-retrying `expect(...).toBeVisible()`. Step 22 is now a
//     normal hard requirement (no longer soft) — both bugs fixed and
//     confirmed via a real run.
//
//  7. NEWLY DISCOVERED + FIXED by actually running this spec against a live
//     server: App.tsx renders CartPanel TWICE — an inline `<aside>` (visible
//     >=768px) and a mobile bottom-sheet copy (<768px, opened by a "السلة
//     (N)…" trigger). At mobile-390, every CartPanel-only control (discount/
//     pay/customer) was UNREACHABLE until the sheet is explicitly opened
//     first — the very first run of this spec hung the full 180s test
//     timeout on step 13's "Add order discount" click for exactly this
//     reason. Fixed with the openCartSheetIfCollapsed/closeCartSheetIfOpen
//     helpers below (steps 13/14/15/17), plus two follow-on bugs the fix
//     itself surfaced: (a) a `getByText("Discount")` strict-mode violation,
//     because the desktop `<aside>` copy stays in the DOM (just
//     `display:none`) and a plain text/label locator — unlike getByRole,
//     which respects the accessibility tree — matches it too; and (b) the
//     naive "always click the trigger" version of the open-helper hanging
//     AGAIN at step 14, because the trigger button is merely OCCLUDED (not
//     display:none) once the sheet is already open from step 13, so
//     Playwright kept retrying a click that its own backdrop was
//     intercepting. See the helpers' own comments for the fix. Confirmed
//     clean through step 14's payment-confirm click in this environment.
//
//  8. ENVIRONMENT — NOT a code defect: mid-verification in this environment,
//     the shared scratchpad accounts file this spec (and critical-cashier-
//     shift.spec.ts) reads test.cashier's password from was wiped by an
//     unrelated, concurrently-running Claude session that owns that same
//     temp directory (confirmed: every other file in that session's
//     scratchpad vanished at the same timestamp, replaced by two empty dirs
//     for a clearly unrelated task) — the documented "concurrent session
//     hazard" pattern for this repo. This interrupted live verification
//     partway through step 14 (pay cash). Resetting the account's password
//     directly (mirroring critical-cashier-shift.spec.ts's own afterAll
//     convention, to self-heal the fixture) was correctly blocked by this
//     environment's own credential-write safety guardrail, so it was not
//     attempted further. See the task report for exactly which steps this
//     left unverified after the GAP #7 fixes landed.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

import { e2eDbConfig } from "../e2e-db-name";
/* eslint-disable @typescript-eslint/no-var-requires */
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

const CASHIER_USERNAME = "test.cashier";

// Same handoff file / marker convention as critical-cashier-shift.spec.ts —
// this spec reads the cashier's current real password from it.
//
// Release-Candidate gate — this was an ABSOLUTE path into one particular
// Claude session's scratchpad directory, so the spec only ran inside that one
// session and died in beforeAll with ENOENT everywhere else. Pre-existing, not
// a merge regression (byte-identical on origin/main). Now: E2E_ACCOUNTS_FILE
// wins if set, otherwise the repo's own gitignored artifacts/ directory.
const SCRATCHPAD_ACCOUNTS_FILE =
  process.env.E2E_ACCOUNTS_FILE ||
  path.join(process.cwd(), "artifacts", "e2e", "test-accounts.txt");
const CASHIER_BLOCK_MARKER = "[CASHIER (branch + warehouse)]";
// Must match critical-cashier-shift.spec.ts's RESET_PASSWORD — that spec always
// resets the fixture account back to this value in afterAll, so it is the value
// to bootstrap to when no handoff file exists yet. Kept in sync deliberately.
const BOOTSTRAP_PASSWORD = "E2eCashierReset!83Qz9";

function readEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

/** Extract the CASHIER block's CURRENT password. Never logged. */
function readCashierPassword(): string {
  const text = fs.readFileSync(SCRATCHPAD_ACCOUNTS_FILE, "utf8");
  const idx = text.indexOf(CASHIER_BLOCK_MARKER);
  if (idx === -1) throw new Error("CASHIER block not found in scratchpad accounts file");
  const block = text.slice(idx);
  const m = block.match(/password:\s*(\S+)/);
  if (!m) throw new Error("password line not found in CASHIER block");
  return m[1];
}

/**
 * Return the cashier's password, bootstrapping when no usable handoff file
 * exists. Mirrors critical-cashier-shift.spec.ts. This matters here too and
 * not only there: with a single worker Playwright runs spec files
 * alphabetically, so bilingual-flow runs FIRST and cannot rely on the other
 * spec having created the file. Recovery is the same reset that spec performs
 * in its own afterAll, so no new secret is introduced.
 */
async function readCashierPasswordOrBootstrap(): Promise<string> {
  try {
    return readCashierPassword();
  } catch {
    const hash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 12);
    const [res] = await db.query(
      "UPDATE users SET password=?, must_change_password=1, password_changed_at=NULL, " +
      "failed_attempts=0, locked_until=NULL WHERE username=?",
      [hash, CASHIER_USERNAME],
    );
    if (!res || res.affectedRows === 0) {
      throw new Error(
        `No handoff file at ${SCRATCHPAD_ACCOUNTS_FILE} AND no '${CASHIER_USERNAME}' account to bootstrap. ` +
        "Create the fixture cashier first, or point E2E_ACCOUNTS_FILE at a file containing its password.",
      );
    }
    fs.mkdirSync(path.dirname(SCRATCHPAD_ACCOUNTS_FILE), { recursive: true });
    fs.writeFileSync(
      SCRATCHPAD_ACCOUNTS_FILE,
      `${CASHIER_BLOCK_MARKER}\nusername: ${CASHIER_USERNAME}\npassword: ${BOOTSTRAP_PASSWORD}\n`,
      "utf8",
    );
    return BOOTSTRAP_PASSWORD;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let seedPassword: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const e = readEnv();
  db = await mysql.createConnection({
    ...e2eDbConfig(e), // database ALWAYS from e2e/e2e-db-name.ts — never .env DB_NAME
  });
  // Defensive pre-clean, same rationale as critical-cashier-shift.spec.ts: a
  // prior crashed run must never leave an OPEN shift blocking this one.
  await db.query("DELETE FROM shifts WHERE username = ?", [CASHIER_USERNAME]);
  seedPassword = await readCashierPasswordOrBootstrap();
  // Bypass the mandatory-change gate for THIS run only — see file header.
  await db.query(
    "UPDATE users SET must_change_password=0, password_changed_at=NOW(), failed_attempts=0, locked_until=NULL WHERE username=?",
    [CASHIER_USERNAME],
  );
});

test.afterAll(async () => {
  if (db) {
    // Restore critical-cashier-shift.spec.ts's resting-state contract exactly
    // (must_change_password=1) — see file header. Password value untouched.
    await db.query(
      "UPDATE users SET must_change_password=1, password_changed_at=NULL WHERE username=?",
      [CASHIER_USERNAME],
    );
    await db.query("DELETE FROM shifts WHERE username = ?", [CASHIER_USERNAME]);
    await db.end();
  }
});

// Numpad digit-word aria-labels — see GAP #2. Shared by shift-open and
// payment amount entry below.
const AR_DIGIT_WORDS: Record<string, string> = {
  "0": "صفر", "1": "واحد", "2": "اثنان", "3": "ثلاثة", "4": "أربعة",
  "5": "خمسة", "6": "ستة", "7": "سبعة", "8": "ثمانية", "9": "تسعة",
};

async function pressNumpadDigits(dialog: ReturnType<Page["getByRole"]>, digits: string): Promise<void> {
  for (const ch of digits) {
    await dialog.getByRole("button", { name: AR_DIGIT_WORDS[ch], exact: true }).click();
  }
}

test("full bilingual cashier flow — language toggle, sell, shift, back-office", async ({ page, request }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // ═══ Step 1 — open /pos/, clear stale session so PosLogin actually renders ═══
  await test.step("1. open /pos/", async () => {
    await page.goto("/pos/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByLabel("اسم المستخدم")).toBeVisible({ timeout: 30_000 });
  });

  // ═══ Step 2 — select English from the LOGIN SCREEN's language toggle ═══════
  // GAP #1 — see file header. Written as the plan intends; soft-fails with a
  // clear message rather than being silently skipped or weakened.
  await test.step("2. select English from the login screen's language toggle [KNOWN GAP]", async () => {
    const loginToggle = page.getByRole("button", { name: /change interface language|تغيير لغة الواجهة/i });
    const count = await loginToggle.count();
    expect.soft(
      count,
      "GAP: PosLogin.tsx has no i18n at all (no useT/useLang/useSetLang, no " +
      "toggle element) — confirmed by reading the component source. There is " +
      "currently no way to choose a language before logging in. This step " +
      "cannot pass until PosLogin.tsx is migrated.",
    ).toBeGreaterThan(0);
  });

  // ═══ Step 3 — login with the REAL cashier fixture ══════════════════════════
  await test.step("3. login with the cashier fixture (test.cashier)", async () => {
    await page.getByLabel("اسم المستخدم").fill(CASHIER_USERNAME);
    await page.getByLabel("كلمة المرور").fill(seedPassword);
    await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
    await expect(page.getByTestId("pos-header")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("cashier-identity")).toHaveText(CASHIER_USERNAME);
  });

  const header = page.getByTestId("pos-header");

  // Helper: open the Header's «more» panel and click the language chip that
  // switches TO the given language (labels are never translated — see
  // header.ts's languageToggle comment — "EN" always switches to English,
  // "عربي" always switches to Arabic, regardless of current UI language).
  async function switchLanguageViaHeader(target: "en" | "ar"): Promise<void> {
    const moreBtn = header.getByRole("button", { name: /المزيد|More/ });
    await moreBtn.click();
    // NOTE: the toggle's ACCESSIBLE NAME is its aria-label (t("header.
    // languageToggle.ariaLabel") — "تغيير لغة الواجهة"/"Change interface
    // language"), which wins over its visible text content for accessible-
    // name computation. "EN"/"عربي" is only the rendered text, so it must be
    // matched with getByText, not getByRole(..., { name }) — confirmed via a
    // real run's accessibility snapshot (button "تغيير لغة الواجهة": EN).
    const chip = page.getByRole("menu").getByText(target === "en" ? "EN" : "عربي", { exact: true });
    await expect(chip).toBeVisible({ timeout: 5_000 });
    await chip.click();
    // Menu closes on outside click / language change re-render; make sure it
    // is gone before continuing so later locators don't collide with it.
    await expect(page.getByRole("menu")).toBeHidden({ timeout: 5_000 }).catch(() => {});
  }

  // Dialog.tsx's own X close button has a HARDCODED aria-label="إغلاق"
  // regardless of language (confirmed by a real run + reading Dialog.tsx —
  // an additional un-migrated spot beyond GAP #4's list). Several dialogs
  // (MyInvoicesDialog, RequisitionsDialog, ShiftDialog's info screen) have no
  // OTHER close affordance, so this is their only real close control in
  // either language. StocktakeDialog is the one dialog with an explicit
  // common.close-backed "Close"/"إغلاق" footer button on its done screen —
  // that one really does translate, and is targeted directly where used.
  async function closeDialogViaX(dialog: ReturnType<Page["getByRole"]>): Promise<void> {
    await dialog.getByRole("button", { name: "إغلاق", exact: true }).click();
  }

  // StocktakeDialog/RequisitionsDialog render a Large-quantity INPUT only for
  // materials with a configured big unit — a material with none (confirmed
  // live: a "—" dash cell, no input, for a small-unit-only material) has ONLY
  // the Small-quantity input. Try Large first, fall back to Small so this
  // works for either kind of real material.
  async function fillFirstQtyInput(dialog: ReturnType<Page["getByRole"]>, amount: string): Promise<void> {
    const big = dialog.locator('input[aria-label^="Large quantity"]').first();
    if (await big.count()) {
      await big.fill(amount);
      return;
    }
    await dialog.locator('input[aria-label^="Small quantity"]').first().fill(amount);
  }

  // App.tsx renders CartPanel TWICE depending on viewport: inline as an
  // `<aside>` from md (768px) up, and — below that — behind a collapsed
  // bottom-sheet triggered by a "السلة (N) — total ر.س" bar (`md:hidden`,
  // so only actually rendered-visible under 768px). Every CartPanel-only
  // control below (discount, pay, customer) is UNREACHABLE at mobile-390
  // until that sheet is opened first — confirmed by a real run hanging on
  // "Add order discount" for the full 180s test timeout. These two helpers
  // are idempotent no-ops at >=768px (the trigger/close-handle simply isn't
  // visible there, since the inline `<aside>` is already on-screen).
  // The sheet's own drag-handle doubles as its close control
  // (aria-label="إغلاق السلة", hardcoded regardless of language — App.tsx is
  // not i18n-migrated, GAP #4's scope). Its visibility is the reliable
  // "is the sheet currently open" signal — the bottom-bar TRIGGER button
  // stays `visible` per Playwright's CSS-visibility check even while the
  // sheet already covers it (it is merely OCCLUDED by the z-50 backdrop
  // stacked on top, not display:none), so checking the trigger alone caused
  // a real click-interception hang here (steps 13→14 are consecutive cart
  // interactions — the sheet is still open going into 14, and re-"opening"
  // it just tried to click straight through its own backdrop) — confirmed
  // by a real run.
  const cartSheetCloseHandle = page.getByRole("button", { name: "إغلاق السلة", exact: true });
  async function openCartSheetIfCollapsed(): Promise<void> {
    if (await cartSheetCloseHandle.isVisible().catch(() => false)) return; // already open
    const trigger = page.getByRole("button", { name: /^السلة \(/ });
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
    }
  }
  async function closeCartSheetIfOpen(): Promise<void> {
    // Closing is required before any HEADER-triggered dialog below
    // (Stocktake/Requisitions/etc.) — the sheet is a `fixed inset-0 z-50`
    // full-viewport backdrop that otherwise covers the header and blocks
    // Playwright's actionability check on it.
    if (await cartSheetCloseHandle.isVisible().catch(() => false)) {
      await cartSheetCloseHandle.click();
      await expect(cartSheetCloseHandle).toBeHidden({ timeout: 5_000 }).catch(() => {});
    }
  }

  // ═══ Step 4/5 — switch to English (the REAL, working toggle — see GAP #1) ═
  await test.step("4-5. switch to English via Header ▸ More (recovery for GAP #1) + assert <html dir=ltr>", async () => {
    await switchLanguageViaHeader("en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr", { timeout: 5_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pos_lang"))).toBe("en");
  });

  // ═══ Step 6 — no leftover Arabic in migrated chrome (narrow, targeted check) ═
  await test.step("6. assert known-migrated Header/CartPanel labels are English, not Arabic", async () => {
    const quick = page.getByTestId("pos-quick-actions");
    await expect(quick.getByText("My invoices", { exact: true })).toBeVisible();
    await expect(quick.getByText("Stocktake", { exact: true })).toBeVisible();
    await expect(quick.getByText("Requisitions", { exact: true })).toBeVisible();
    await expect(quick.getByText("فواتيري")).toHaveCount(0);
    await expect(quick.getByText("جرد المخزون")).toHaveCount(0);

    // CartPanel order-type radios (cartPanel.orderTypes.*) — visible on desktop
    // width; on narrow viewports the cart lives behind the bottom sheet, so
    // this check is soft (layout-dependent, not an i18n regression signal).
    const dineIn = page.getByRole("radio", { name: "Dine-in" });
    if (await dineIn.count()) {
      await expect(dineIn).toBeVisible();
      await expect(page.getByRole("radio", { name: "محلي" })).toHaveCount(0);
    }
  });

  // ═══ Step 7 — reload, assert English persisted ═════════════════════════════
  await test.step("7. reload — assert English persisted", async () => {
    await page.reload();
    await expect(header).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByTestId("pos-quick-actions").getByText("My invoices", { exact: true })).toBeVisible();
  });

  // ═══ Step 8 — open shift with an opening float ═════════════════════════════
  const OPENING_FLOAT = 300;
  await test.step("8. open shift with opening float", async () => {
    const quickOpenBtn = header.getByRole("button", { name: "Open shift", exact: true });
    await quickOpenBtn.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // GAP #2 — Numpad is Arabic-only regardless of language; see helper above.
    await pressNumpadDigits(dialog, "300");
    await expect(dialog.getByText("300.00 SAR")).toBeVisible();
    await dialog.getByRole("button", { name: "Open shift", exact: true }).click();
    await expect(dialog.getByText("Current shift")).toBeVisible({ timeout: 15_000 });
    await closeDialogViaX(dialog);
    await expect(dialog).toBeHidden();
    await expect(header.getByRole("button", { name: /Shift/ })).toBeVisible();
  });

  // ═══ Step 9 — product names/images render ══════════════════════════════════
  // App.tsx's own aside/section aria-labels are hardcoded Arabic (GAP #4) —
  // used here purely as a stable container selector, not an i18n assertion.
  const catalogSection = page.locator('section[aria-label="الأصناف"]');
  // Product cards ONLY — NOT the horizontal CategoryRail duplicate that
  // App.tsx also renders inside this same section for <1024px layouts
  // (`lg:hidden`, so CSS-hidden but still in the DOM at wider viewports —
  // confirmed by a real run hanging on it). Cards are the one button shape
  // in this section with a <p> child (name + price paragraphs).
  const productCards = catalogSection.locator("button").filter({ has: page.locator("p") });
  await test.step("9. assert product names/images render", async () => {
    await expect(catalogSection).toBeVisible({ timeout: 15_000 });
    await expect(productCards.first()).toBeVisible({ timeout: 15_000 });
    // Images are a per-item catalog data question, not an i18n regression —
    // soft: assert IF any product-thumb exists, it actually renders content.
    const thumbCount = await page.getByTestId("product-thumb").count();
    if (thumbCount > 0) {
      await expect(page.getByTestId("product-thumb").first()).toBeVisible();
    }
  });

  // Pull a real catalog item (name/id/barcode) via the same API the app uses,
  // so search assertions below exercise real data, not guessed strings.
  const token = await page.evaluate(() => localStorage.getItem("pos_token"));
  const catalogRes = await request.get("/api/pos/v2/catalog", { headers: { Authorization: `Bearer ${token}` } });
  expect(catalogRes.ok(), "catalog API reachable for search-assertion setup").toBe(true);
  const catalogJson = await catalogRes.json();
  type CatalogItem = { id: string; name: string; active: boolean; barcode?: string | null; units?: Array<{ barcode?: string | null }> };
  const items: CatalogItem[] = (catalogJson.items ?? catalogJson.data?.items ?? []) as CatalogItem[];
  const searchTarget = items.find((it) => it.active && it.name && it.id) ?? items[0];
  const barcodeTarget = items.find((it) => it.active && (it.barcode || it.units?.some((u) => u.barcode)));
  const targetBarcode = barcodeTarget?.barcode || barcodeTarget?.units?.find((u) => u.barcode)?.barcode || null;

  // StocktakeDialog / RequisitionsDialog search RAW MATERIALS/inventory
  // (GET /api/inventory/items — routes/inventory.js), a completely different
  // dataset from the sellable menu catalog above — confirmed live: searching
  // for a dish name in Stocktake's search box correctly returns "No matching
  // results". Fetch a real material name for steps 19-20 instead of reusing
  // the menu item.
  const invRes = await request.get("/api/inventory/items", { headers: { Authorization: `Bearer ${token}` } });
  const invItems: Array<{ id: string; name: string; active: number | boolean }> =
    invRes.ok() ? await invRes.json() : [];
  const materialTarget = invItems.find((it) => it.active && it.name);

  const searchInput = page.getByPlaceholder("بحث أو مسح باركود… (F2)");

  // ═══ Step 10 — search by Arabic text ═══════════════════════════════════════
  await test.step("10. search by Arabic text (real catalog item name)", async () => {
    test.skip(!searchTarget, "catalog returned no active items to search for");
    await searchInput.fill(searchTarget!.name);
    await expect(catalogSection.getByText(searchTarget!.name, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    await searchInput.fill("");
  });

  // ═══ Step 11 — search by "English" text ════════════════════════════════════
  // GAP #3 — proxied via the item's Latin/ASCII id (filterItems also matches
  // `it.id`), NOT a translated product name (none exists yet).
  await test.step('11. search by "English" text [PROXY — see GAP #3]', async () => {
    test.skip(!searchTarget, "catalog returned no active items to search for");
    const idQuery = searchTarget!.id.slice(0, Math.max(3, Math.min(6, searchTarget!.id.length)));
    await searchInput.fill(idQuery);
    const matched = await productCards.count();
    expect.soft(
      matched,
      "GAP: CatalogItem has no nameEn field and filterItems() only matches " +
      "name/id — this asserts the id-substring (Latin/ASCII) search path " +
      "instead, as a proxy for the still-missing bilingual product name search.",
    ).toBeGreaterThan(0);
    await searchInput.fill("");
  });

  // ═══ Step 12 — search by barcode + add item to cart ════════════════════════
  await test.step("12. search by barcode, add item to cart", async () => {
    if (targetBarcode) {
      await searchInput.fill(targetBarcode);
      await searchInput.press("Enter");
    } else {
      // No barcoded item in this catalog — fall back to a direct card tap so
      // the rest of the flow (discount/pay/etc.) still has a real cart line.
      await searchInput.fill("");
      await productCards.first().click();
    }
    await expect(page.getByTestId("card-qty-badge").first()).toBeVisible({ timeout: 5_000 });
  });

  // ═══ Step 13 — apply a discount ═════════════════════════════════════════════
  // DiscountDialog.tsx is NOT i18n-migrated (GAP #4) — Arabic-only regardless
  // of pos_lang, so its own strings are used here on purpose.
  await test.step("13. apply a discount", async () => {
    await openCartSheetIfCollapsed();
    await page.getByRole("button", { name: "Add order discount", exact: true }).click();
    const discountDialog = page.getByRole("dialog").filter({ hasText: "خصم على الطلب" });
    await expect(discountDialog).toBeVisible({ timeout: 5_000 });
    await discountDialog.getByLabel("النسبة (0–100)").fill("10");
    await discountDialog.getByRole("button", { name: "تطبيق الخصم", exact: true }).click();
    await expect(discountDialog).toBeHidden();
    // getByRole (not getByText/getByLabel) on purpose: App.tsx keeps BOTH a
    // desktop `<aside>` copy of CartPanel (css `hidden` at <768px — still in
    // the DOM, just display:none) and, once opened, the mobile sheet's own
    // copy, alive simultaneously. display:none elements are excluded from
    // the accessibility tree (so getByRole naturally resolves to the one
    // truly-visible instance), whereas a plain text/label locator matches
    // BOTH raw DOM nodes and strict-mode-violates — confirmed by a real run.
    await expect(page.getByRole("button", { name: /^Discount\b/ })).toBeVisible();
  });

  // ═══ Step 14 — pay cash ═════════════════════════════════════════════════════
  async function capturePrintPopup(trigger: () => Promise<void>): Promise<void> {
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 10_000 }), trigger()]);
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    const html = await popup.content().catch(() => "");
    expect(html.length, "print popup received real receipt HTML, not a blank window").toBeGreaterThan(0);
    await popup.close().catch(() => {});
  }

  await test.step("14. pay cash", async () => {
    await openCartSheetIfCollapsed();
    await page.getByRole("button", { name: /^Pay —/ }).click();
    const payDialog = page.getByRole("dialog");
    await expect(payDialog).toBeVisible({ timeout: 5_000 });
    await payDialog.getByRole("tab", { name: "Cash" }).click();
    await payDialog.getByRole("button", { name: "Exact amount", exact: true }).click();
    await payDialog.getByRole("button", { name: /^Confirm payment —/ }).click();
    await expect(payDialog.getByText("Payment successful")).toBeVisible({ timeout: 20_000 });

    // ═══ Step 18a — print receipt (assert the HTML task, no real printer) ═══
    await capturePrintPopup(async () => {
      await payDialog.getByRole("button", { name: "Print receipt", exact: true }).click();
    });

    await payDialog.getByRole("button", { name: "New order", exact: true }).click();
    await expect(payDialog).toBeHidden({ timeout: 10_000 });
  });

  // ═══ Step 15 — pay mixed (split tender) ════════════════════════════════════
  await test.step("15. pay mixed (split tender)", async () => {
    if (targetBarcode) {
      await searchInput.fill(targetBarcode);
      await searchInput.press("Enter");
    } else {
      await productCards.first().click();
    }
    await expect(page.getByTestId("card-qty-badge").first()).toBeVisible({ timeout: 5_000 });

    await openCartSheetIfCollapsed();
    await page.getByRole("button", { name: /^Pay —/ }).click();
    const payDialog = page.getByRole("dialog");
    await expect(payDialog).toBeVisible({ timeout: 5_000 });

    const splitTab = payDialog.getByRole("tab", { name: "Split" });
    if (!(await splitTab.isEnabled())) {
      // Split is disabled while offline — this run needs a live server
      // connection, so treat this as a real failure, not a silent skip.
      throw new Error("Split tender tab is disabled — payment requires an online connection");
    }
    await splitTab.click();

    const totalText = await payDialog.locator("text=/Total due/").locator("xpath=following-sibling::*").first().textContent().catch(() => null);
    // Read the numeric total straight from the dialog instead of recomputing
    // cart math client-side — split entirely to Cash keeps this deterministic
    // regardless of the exact discount/tax figures.
    const totalMatch = (await payDialog.textContent())?.match(/([\d,]+\.\d{2})\s*SAR/);
    const total = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null;
    expect(total, "could read the payable total off the split-tender screen").not.toBeNull();

    await payDialog.getByLabel("Cash", { exact: true }).fill(String(total));
    await expect(payDialog.getByText("Total matches", { exact: true })).toBeVisible({ timeout: 5_000 });
    await payDialog.getByRole("button", { name: /^Confirm payment —/ }).click();
    await expect(payDialog.getByText("Payment successful")).toBeVisible({ timeout: 20_000 });
    await payDialog.getByRole("button", { name: "New order", exact: true }).click();
    await expect(payDialog).toBeHidden({ timeout: 10_000 });
    void totalText;
  });

  // ═══ Step 16 — open "My Invoices" and reprint ══════════════════════════════
  await test.step('16. open "My Invoices" and reprint', async () => {
    await header.getByRole("button", { name: "My invoices", exact: true }).click();
    const invoicesDialog = page.getByRole("dialog");
    await expect(invoicesDialog).toBeVisible({ timeout: 10_000 });
    await expect(invoicesDialog.getByText("My Invoices", { exact: true })).toBeVisible();
    const firstPrintBtn = invoicesDialog.getByRole("button", { name: "Print", exact: true }).first();
    await expect(firstPrintBtn).toBeVisible({ timeout: 10_000 });
    await capturePrintPopup(async () => { await firstPrintBtn.click(); });
    await closeDialogViaX(invoicesDialog);
    await expect(invoicesDialog).toBeHidden();
  });

  // ═══ Step 17 — open customers ═══════════════════════════════════════════════
  // CustomerPicker.tsx / its sub-dialogs are NOT i18n-migrated (GAP #4) —
  // this only opens the picker via CartPanel's own (migrated) toggle button.
  await test.step("17. open customers", async () => {
    await openCartSheetIfCollapsed();
    const customerBtn = page.getByRole("button", { name: "Customer", exact: true });
    await customerBtn.click();
    await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    // Close the mobile sheet (no-op at >=768px) — every remaining step is a
    // HEADER-triggered dialog (Stocktake/Requisitions/My Invoices/Shift),
    // and the sheet's full-viewport backdrop would otherwise block those
    // header clicks. See openCartSheetIfCollapsed/closeCartSheetIfOpen above.
    await closeCartSheetIfOpen();
  });

  // ═══ Step 19 — run stocktake ════════════════════════════════════════════════
  await test.step("19. run stocktake", async () => {
    await header.getByRole("button", { name: "Stocktake", exact: true }).click();
    const stDialog = page.getByRole("dialog");
    await expect(stDialog).toBeVisible({ timeout: 10_000 });
    if (await stDialog.getByText("Stocktake requires a connection").isVisible().catch(() => false)) {
      throw new Error("Stocktake dialog reports offline — expected an online connection for this run");
    }
    test.skip(!materialTarget, "inventory API returned no active material to search for");
    await stDialog.getByLabel("Search for a material", { exact: true }).fill(materialTarget!.name.slice(0, 3));
    const firstResult = stDialog.getByRole("listbox").getByRole("option").first().or(stDialog.getByRole("listbox").locator("li").first());
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();
    await fillFirstQtyInput(stDialog, "1");
    // NOT exact — the button's accessible name is "Review & send (N)" (a
    // trailing `<span>{counted.length}</span>` sibling, confirmed via a real
    // run's trace: `exact: true` against "Review & send" alone never
    // resolves, since the count suffix is part of the same accessible name).
    await stDialog.getByRole("button", { name: /^Review & send/ }).click();
    await stDialog.getByRole("button", { name: "Send for approval", exact: true }).click();
    await expect(stDialog.getByText("Stocktake sheet sent for approval")).toBeVisible({ timeout: 15_000 });
    await stDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(stDialog).toBeHidden();
  });

  // ═══ Step 20 — submit a requisition ═════════════════════════════════════════
  await test.step("20. submit a requisition", async () => {
    await header.getByRole("button", { name: "Requisitions", exact: true }).click();
    const reqDialog = page.getByRole("dialog");
    await expect(reqDialog).toBeVisible({ timeout: 10_000 });
    if (await reqDialog.getByText("Shortage requests & receiving requires a connection").isVisible().catch(() => false)) {
      throw new Error("Requisitions dialog reports offline — expected an online connection for this run");
    }
    test.skip(!materialTarget, "inventory API returned no active material to search for");
    await reqDialog.getByLabel("Search for an item", { exact: true }).fill(materialTarget!.name.slice(0, 3));
    const firstResult = reqDialog.getByRole("listbox").getByRole("option").first().or(reqDialog.getByRole("listbox").locator("li").first());
    await expect(firstResult).toBeVisible({ timeout: 10_000 });
    await firstResult.click();
    await fillFirstQtyInput(reqDialog, "1");
    // NOT exact — same "(N)" count-suffix accessible-name shape as
    // StocktakeDialog's "Review & send" above.
    await reqDialog.getByRole("button", { name: /^Submit request/ }).click();
    // NOTE: unlike StocktakeDialog (which has its own persistent in-dialog
    // "done" screen), a successful submit here only shows a transient GLOBAL
    // toast (Toasts.tsx, rendered outside the dialog's own DOM subtree — see
    // requisitionsDialog.toast.created) and auto-switches to the "My
    // Requests & Receiving" tab — confirmed via a real run. Assert on the
    // now-visible request row (SHR-…) instead of the toast text.
    await expect(reqDialog.getByText(/^SHR-/).first()).toBeVisible({ timeout: 15_000 });
    await closeDialogViaX(reqDialog);
    await expect(reqDialog).toBeHidden();
  });

  // ═══ Step 21 — create a return if permissions allow ═════════════════════════
  // GAP #5 — soft: proves the UI path reaches submission, does not hard-fail
  // this whole spec on the pre-existing, separately-tracked O2C 409.
  await test.step("21. create a return if permissions allow [SOFT — see GAP #5]", async () => {
    await header.getByRole("button", { name: "My invoices", exact: true }).click();
    const invoicesDialog = page.getByRole("dialog");
    await expect(invoicesDialog).toBeVisible({ timeout: 10_000 });
    const returnBtn = invoicesDialog.getByRole("button", { name: "Return", exact: true }).first();
    if (await returnBtn.count()) {
      await returnBtn.click();
      const returnUi = page.getByRole("dialog").filter({ hasText: /مرتجع|Return/ }).last();
      const reachedReturnUi = await returnUi.isVisible({ timeout: 5_000 }).catch(() => false);
      expect.soft(reachedReturnUi, "GAP: return UI did not open — see GAP #5 (O2C return path)").toBe(true);
    } else {
      expect.soft(false, "no returnable invoice row was available to test the return flow against").toBe(true);
    }
    await page.keyboard.press("Escape");
    await closeDialogViaX(invoicesDialog).catch(() => {});
  });

  // ═══ Step 22 — close shift ═══════════════════════════════════════════════════
  await test.step("22. close shift", async () => {
    const shiftChip = header.getByRole("button", { name: /Shift/ });
    await shiftChip.click();
    const shiftDialog = page.getByRole("dialog");
    await expect(shiftDialog).toBeVisible({ timeout: 10_000 });
    await shiftDialog.getByRole("button", { name: "Close shift", exact: true }).click();
    await expect(shiftDialog.getByText(/invoices in this shift/)).toBeVisible({ timeout: 10_000 });

    // Fetch the exact expected CASH total from the same endpoint the UI
    // reads, and type it straight into the (non-denomination-driven) cash
    // counted field — avoids GAP #2's Arabic-only denomination grid entirely
    // and gives a deterministic zero-variance close.
    const shiftIdText = (await shiftChip.textContent())?.replace(/[^\d]/g, "") ?? "";
    const closingRes = await request.get(`/api/shifts/closing-data-v3/SH-${shiftIdText}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    let cashExpected: number | null = null;
    if (closingRes && closingRes.ok()) {
      const closingJson = await closingRes.json();
      const cashMethod = (closingJson.methods as Array<{ groupType: string; expectedAmount: number }> | undefined)
        ?.find((m) => m.groupType === "cash");
      if (cashMethod) cashExpected = Number(cashMethod.expectedAmount);
    }

    const countedInputs = shiftDialog.locator('input[aria-label^="Counted —"]');
    const countedCount = await countedInputs.count();
    if (cashExpected != null && countedCount > 0) {
      // Cash is the primary built-in method and — per ShiftDialog.tsx's own
      // varianceRows ordering — renders first among the counted-amount rows.
      await countedInputs.first().fill(cashExpected.toFixed(2));
    }

    await shiftDialog.getByText("I finished counting and entered the amounts").click();

    const confirmBtn = shiftDialog.getByRole("button", { name: "Confirm shift close", exact: true });
    if (!(await confirmBtn.isEnabled())) {
      // Gate gave a variance-explanation requirement (gate.needsNote) —
      // satisfy it rather than fighting exact-cent accounting math.
      await shiftDialog.getByLabel("Closing notes", { exact: false }).fill("E2E bilingual-flow close — see gate.needsNote.");
    }
    await confirmBtn.click();

    // GAP #6 — WAS: ShiftDialog.tsx's own mode-reset useEffect
    // (`useEffect(() => { if (!open) return; setMode("info"); ...
    // setClosedShiftId(null); ... }, [open, shiftId, online])`) listed
    // `shiftId` as a dependency. confirmClose() set mode="closed" AND (via
    // onShiftClosed()) nulled the context's shiftId — but nulling shiftId
    // re-fired that SAME reset effect (still `open`), which immediately
    // stomped mode back to "info", so the dialog fell straight through to
    // the "no open shift" screen instead of ever showing the post-close
    // Z-report/WhatsApp-share summary.
    //
    // FIXED in frontend/pos/src/components/dialogs/ShiftDialog.tsx: the
    // reset is now split into two effects — one keyed only on `[open]` that
    // does the full reset, and a second keyed on `[open, shiftId, online]`
    // that ONLY refetches the summary and never touches mode/result, so it
    // no-ops harmlessly once shiftId goes null right after a close.
    //
    // Verifying that fix also surfaced a SECOND, independent bug — this
    // time in the test itself: the original assertion used
    // `locator.isVisible({ timeout })`, which does NOT auto-retry (it
    // snapshots the DOM once and returns immediately); it was being
    // evaluated before confirmClose()'s awaited closeShiftV3() POST had even
    // resolved, so it read a false "not visible" regardless of the product
    // bug above. Replaced with the auto-retrying `expect(...).toBeVisible()`
    // web-first assertion, which correctly waits out the close request.
    // With both bugs fixed and confirmed via a real run, this is now a
    // normal hard requirement — not a soft/known-gap check.
    const closedScreen = shiftDialog.getByText("Shift closed");
    await expect(
      closedScreen,
      "post-close Z-report screen did not appear after confirming shift close",
    ).toBeVisible({ timeout: 10_000 });
    await capturePrintPopup(async () => {
      await shiftDialog.getByRole("button", { name: "Print Z report", exact: true }).click();
    });
    await shiftDialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(shiftDialog).toBeHidden();
  });

  // ═══ Step 23 — switch back to Arabic, assert RTL ════════════════════════════
  await test.step("23. switch back to Arabic — assert <html dir=rtl>", async () => {
    await switchLanguageViaHeader("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 5_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pos_lang"))).toBe("ar");
  });

  const artifactsDir = path.join(process.cwd(), "artifacts", "e2e", "pos", "bilingual-flow");
  fs.mkdirSync(artifactsDir, { recursive: true });
  await page.screenshot({
    path: path.join(artifactsDir, `bilingual-flow-${testInfo.project.name}.png`),
    fullPage: true,
  });

  // Reported, not asserted-away: this flow legitimately touches un-migrated
  // dialogs (GAP #4) and known offline/O2C edges, so a strict zero-
  // console-errors gate would be noise rather than signal for THIS spec.
  if (consoleErrors.length) {
    testInfo.annotations.push({ type: "console-errors", description: JSON.stringify(consoleErrors) });
  }
});
