// ═══════════════════════════════════════════════════════════════════════════
// Trial Balance RBAC — REAL LOGIN, three real identities (Tier A.2 Section 8b).
//
// Unlike e2e/erp/erp.spec.ts (which injects an admin JWT into localStorage via
// addInitScript for speed, since it's walking 89 routes), this spec exists
// specifically to prove the RBAC boundary on ONE route end-to-end through the
// product's own login form — no token injection anywhere in the tests below.
// Setup (creating the three throwaway accounts) DOES use an admin token
// against the real POST /api/auth/users API, mirroring the pattern already
// established in tests/integration/auditorRole.test.js (the admin there is a
// fixture actor, never the subject under test); the three identities actually
// under test each authenticate through the real <LoginPage/> form.
//
// Run:  npx playwright test --config=playwright.erp.config.ts e2e/erp/trial-balance-rbac.spec.ts
//       (build first: npm --prefix frontend/erp run build)
//
// Proves, against the REAL backend RBAC state (db/migrations/finance/
// capabilities.js's ROLE_GRANTS, not a hardcoded frontend assumption):
//   - accountant: real login → sidebar link reachable → healthy Trial Balance view.
//   - auditor:    same — auditor holds finance.reports.view (read-only elsewhere,
//                 already proven by tests/integration/auditorRole.test.js).
//   - cashier:    real login → CapGuard blocks a direct deep link with
//                 data-state="permission-denied", and the sidebar never offers
//                 the link in the first place — two independent enforcement
//                 points, both checked.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const ADMIN_TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const API_BASE = "http://127.0.0.1:3027";
const TB_HREF = "/app/accounting/trial-balance";
// Passes POST /api/auth/users' password policy: >=6 chars, a letter, a digit,
// a special char (routes/auth.js line ~706).
const PW = "E2eTbRbac#2026!Aa";
const SUFFIX = Date.now();

const IDENTITIES = {
  accountant: { username: `e2e_tb_acct_${SUFFIX}`, role: "accountant" },
  auditor: { username: `e2e_tb_aud_${SUFFIX}`, role: "auditor" },
  cashier: { username: `e2e_tb_cash_${SUFFIX}`, role: "cashier" },
} as const;

async function apiCall(method: string, urlPath: string, token: string | null, body?: unknown) {
  const res = await fetch(API_BASE + urlPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as { success?: boolean; error?: string } | null };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  for (const id of Object.values(IDENTITIES)) {
    const created = await apiCall("POST", "/api/auth/users", ADMIN_TOKEN, {
      username: id.username,
      password: PW,
      role: id.role,
      displayName: `E2E RBAC ${id.role}`,
    });
    if (!created.body || created.body.success !== true) {
      throw new Error(
        `setup: POST /api/auth/users failed for role=${id.role}: ${JSON.stringify(created.body)}`
      );
    }
  }
  // Fixture-only concern, not the behavior under test: every admin-created
  // account is forced to change its password on first login (routes/auth.js,
  // "close2"), which would otherwise redirect all three logins below to
  // /change-password instead of the screen this spec actually exercises. The
  // real product API has no endpoint to clear that flag (only the change-
  // password flow itself does) — same class of fixture-setup exception
  // auditorRole.test.js already uses for its non-subject admin actor.
  const db = require("../../db/connection");
  await db.query(
    `UPDATE users SET must_change_password = 0 WHERE username IN (?, ?, ?)`,
    Object.values(IDENTITIES).map((i) => i.username)
  );
});

test.afterAll(async () => {
  for (const id of Object.values(IDENTITIES)) {
    await apiCall("DELETE", `/api/auth/users/${id.username}`, ADMIN_TOKEN);
  }
});

async function realLogin(page: Page, username: string) {
  await page.goto("/app/login");
  // Login.tsx's Field wraps the label as plain text, not a semantic <label
  // for=...> — getByLabel can't associate it with the input (confirmed via
  // the accessibility snapshot on first run: "text: اسم المستخدم" then a
  // bare "textbox", not a labelled one). Select by the autoComplete
  // attributes Login.tsx sets directly on each Input instead.
  const usernameInput = page.locator('input[autocomplete="username"]');
  const passwordInput = page.locator('input[autocomplete="current-password"]');
  await expect(usernameInput).toBeVisible({ timeout: 30_000 });
  await usernameInput.fill(username);
  await passwordInput.fill(PW);
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
}

// The sidebar's capability filter (Sidebar.tsx) depends on usePermissions(),
// which sources from useAccessScope() — an async server fetch. Checking the
// DOM immediately after the post-login navigation races that fetch (observed
// directly: a fresh accountant login intermittently shows zero nav links for
// a beat). Wait for the shell to mount AND for network activity to settle
// before asserting on sidebar contents, same as erp.spec.ts's settle().
//
// The <aside> itself is `hidden lg:flex` (display:none below the lg
// breakpoint — mobile/tablet get MobileNav instead), so `state: "attached"`
// (not the default "visible") and raw DOM .click() via page.evaluate()
// (not Playwright's actionability-checked locator.click()) are required to
// work across every viewport project — the exact same technique
// erp.spec.ts's spaNavigate() already uses, for the same reason.
async function waitForSidebarSettled(page: Page) {
  await page.waitForSelector('aside[aria-label="الشريط الجانبي"]', { state: "attached", timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

async function clickDom(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}

// Sidebar.tsx is section-collapsed: only group.items[0] (whichever leaf
// survives the capability filter first, per role) renders as a direct <a>
// until its group is expanded via the chevron toggle
// (button[aria-controls="nav-group-<id>"]). Trial Balance is never that
// first item (chart-of-accounts / gl-journals rank earlier in the
// "accounting" group in the manifest), so reaching it via the real sidebar
// — not a raw deep link — requires expanding the group first, exactly as a
// real user would click the chevron.
async function clickSidebarTrialBalanceLink(page: Page) {
  await waitForSidebarSettled(page);
  const already = await page.evaluate(
    (href) => !!document.querySelector(`aside a[href="${href}"]`),
    TB_HREF
  );
  if (!already) {
    await clickDom(page, 'aside button[aria-controls="nav-group-accounting"]');
    await page.waitForTimeout(200); // group expand is a synchronous React state update, but settle the animation
  }
  return clickDom(page, `aside a[href="${TB_HREF}"]`);
}

async function sidebarHasTrialBalanceLink(page: Page) {
  await waitForSidebarSettled(page);
  await clickDom(page, 'aside button[aria-controls="nav-group-accounting"]');
  await page.waitForTimeout(200);
  return page.evaluate(
    (href) => !!document.querySelector(`aside a[href="${href}"]`),
    TB_HREF
  );
}

test("accountant: real login, sidebar link reachable, healthy Trial Balance view", async ({ page }) => {
  await realLogin(page, IDENTITIES.accountant.username);
  await page.waitForURL("**/app/overview", { timeout: 20_000 });

  const clicked = await clickSidebarTrialBalanceLink(page);
  expect(clicked, "accountant must see ميزان المراجعة in the sidebar (finance.reports.view granted)").toBe(true);
  await page.waitForURL(`**${TB_HREF}`, { timeout: 15_000 });

  await expect(page.locator('[data-state="permission-denied"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "ميزان المراجعة" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("الإجمالي").first()).toBeVisible({ timeout: 20_000 });
});

test("auditor: real login, sidebar link reachable, healthy read-only Trial Balance view", async ({ page }) => {
  await realLogin(page, IDENTITIES.auditor.username);
  await page.waitForURL("**/app/overview", { timeout: 20_000 });

  const clicked = await clickSidebarTrialBalanceLink(page);
  expect(clicked, "auditor must see ميزان المراجعة in the sidebar (finance.reports.view granted)").toBe(true);
  await page.waitForURL(`**${TB_HREF}`, { timeout: 15_000 });

  await expect(page.locator('[data-state="permission-denied"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "ميزان المراجعة" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("الإجمالي").first()).toBeVisible({ timeout: 20_000 });
});

test("cashier: real login redirects to POS; sidebar never offers the link; a direct deep link is blocked (permission-denied)", async ({ page }) => {
  await realLogin(page, IDENTITIES.cashier.username);
  // Login.tsx sends a cashier straight to /pos/, not /app/overview — their
  // home is the register, not the Back-Office. Confirms the app itself
  // already steers a cashier away from finance screens before RBAC even
  // has to intervene.
  await page.waitForURL("**/pos/**", { timeout: 20_000 });

  // Now the direct-URL attempt: same token (still in localStorage from the
  // login above), navigated straight at the ERP route a cashier could guess
  // or bookmark. This is the actual RBAC boundary under test.
  await page.goto(TB_HREF);
  await expect(page.locator('[data-state="permission-denied"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByText("الإجمالي")).toHaveCount(0);

  // And on a screen a cashier CAN legitimately reach in the ERP shell, the
  // sidebar itself must never have offered the link (Sidebar.tsx filters by
  // capability) — a second, independent enforcement point from CapGuard.
  await page.goto("/app/overview");
  const hasLink = await sidebarHasTrialBalanceLink(page);
  expect(hasLink, "cashier must NOT see ميزان المراجعة in the sidebar (no finance.reports.view)").toBe(false);
});
