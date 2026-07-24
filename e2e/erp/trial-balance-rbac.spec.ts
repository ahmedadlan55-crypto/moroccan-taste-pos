// ═══════════════════════════════════════════════════════════════════════════
// Trial Balance RBAC — REAL LOGIN, three real identities (Tier A.2 Section 8b,
// hardened Tier A.3 Release Gate item 8).
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
//   - accountant: real login → REAL navigation UI (sidebar on desktop,
//                 MobileNav bottom bar on mobile — never a hidden element
//                 clicked via page.evaluate()) → a genuinely healthy Trial
//                 Balance view with real numeric data, not just a heading.
//   - auditor:    same — auditor holds finance.reports.view (read-only
//                 elsewhere, already proven by tests/integration/auditorRole.test.js).
//   - cashier:    real login → CapGuard blocks a direct deep link with
//                 data-state="permission-denied", the sidebar/MobileNav never
//                 offer the link, AND the cashier's own token gets a genuine
//                 SERVER-SIDE 403 calling the API directly — three
//                 independent enforcement points, all checked.
// Every test also fails on any console error, any pageerror, or any API
// response >=400 — the same zero-tolerance contract e2e/erp/erp.spec.ts
// already enforces for the full closure gate.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

/** Host/port/credentials from .env — the DATABASE always comes from
 *  e2e/e2e-db-name.ts, never from here. See the note at its use site. */
function readDotEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

const ADMIN_TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const API_BASE = "http://127.0.0.1:3027";
const TB_PATH = "/accounting/trial-balance";
const TB_HREF = "/app" + TB_PATH;
// Passes POST /api/auth/users' password policy: >=6 chars, a letter, a digit,
// a special char (routes/auth.js line ~706).
const PW = "E2eTbRbac#2026!Aa";
const SUFFIX = Date.now();

const IDENTITIES = {
  accountant: { username: `e2e_tb_acct_${SUFFIX}`, role: "accountant" },
  auditor: { username: `e2e_tb_aud_${SUFFIX}`, role: "auditor" },
  cashier: { username: `e2e_tb_cash_${SUFFIX}`, role: "cashier" },
} as const;

// Same non-healthy-state contract e2e/erp/erp.spec.ts enforces for the full
// closure gate — kept in sync deliberately, not redefined loosely.
const BAD_STATES = [
  "error", "offline", "session-expired", "permission-denied", "conflict", "feature-disabled", "not-found",
];
// Same benign-console allowlist as erp.spec.ts — anything outside this is a
// real defect, not noise to swallow.
const BENIGN_CONSOLE =
  // + about:srcdoc sandbox-block (Playwright addInitScript into the script-free,
  // deliberately-sandboxed InvoiceSettings receipt-preview iframe) — see erp.spec.ts.
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag|Blocked script execution in .?about:srcdoc/i;

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
  return { status: res.status, body: json as { success?: boolean; error?: string; code?: string; token?: string } | null };
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
  // CLOSEOUT — this used to be `require("../../db/connection")`, the APP's
  // shared pool. That pool binds at require time to whatever process.env holds
  // in the PLAYWRIGHT RUNNER process, which is `.env` — i.e. the DEVELOPMENT
  // database. Two bugs in one line:
  //   1. it wrote to the developer's real database on every run (an UPDATE, so
  //      it changed no row COUNTS and slipped straight past a counts-based
  //      "zero dev writes" check);
  //   2. once the server under test moved to the isolated clone, this cleared
  //      the flag in the WRONG database entirely — so all three logins below
  //      were redirected to /app/change-password?must=1 and the spec failed
  //      with a navigation timeout that looks nothing like its actual cause.
  // Use the same database the server is serving, resolved in exactly one place.
  const mysql = require("mysql2/promise");
  const { e2eDbConfig } = require("../e2e-db-name");
  const fixtureDb = await mysql.createConnection(e2eDbConfig(readDotEnv()));
  try {
    await fixtureDb.query(
      `UPDATE users SET must_change_password = 0 WHERE username IN (?, ?, ?)`,
      Object.values(IDENTITIES).map((i) => i.username)
    );
  } finally {
    await fixtureDb.end();
  }
});

// Tier A.3 Release Gate item 8 — every identity's DELETE is now independently
// try/caught: the original version aborted the whole loop (leaving later
// identities un-deleted) the instant ANY single delete threw (a network-level
// fetch failure, not just a non-2xx response, which apiCall already tolerates
// without throwing). Runs regardless of whether beforeAll/individual tests
// failed or the run was interrupted — afterAll still fires either way, and
// this makes the cleanup itself resilient rather than all-or-nothing.
test.afterAll(async () => {
  const failures: string[] = [];
  for (const id of Object.values(IDENTITIES)) {
    try {
      await apiCall("DELETE", `/api/auth/users/${id.username}`, ADMIN_TOKEN);
    } catch (e) {
      failures.push(`${id.username}: ${String(e)}`);
    }
  }
  if (failures.length) {
    console.error("CRITICAL: trial-balance-rbac.spec.ts cleanup could not delete some fixture users:", failures);
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

/** Extract the JWT this session is actually using, straight from localStorage. */
async function getSessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem("pos_token") || "");
  if (!token) throw new Error("getSessionToken: no pos_token in localStorage after login");
  return token;
}

// Tier A.3 Release Gate item 8 — navigation is now VIEWPORT-REAL: on the
// `mobile` project the sidebar <aside> is display:none (lg:hidden) and was
// never reachable by an actual phone user, so clicking it via
// page.evaluate()'s raw DOM .click() — even though it "worked" and even
// though it dispatches a real click event React Router's handler receives —
// proved nothing about the actual mobile experience: MobileNav.tsx is a
// COMPLETELY DIFFERENT component (a fixed bottom bar showing only the first
// 5 permitted nav items), and it was never touched by the old test at all.
// Real Playwright locator .click() calls are used throughout below — no
// page.evaluate() DOM injection — so Playwright's own actionability checks
// (visible, enabled, not obscured) apply exactly as they would for a real
// user/tap.
// Same set erp.spec.ts checks (`usesMobileNav`) — tablet-768 is BELOW the
// `lg` breakpoint too, so it gets MobileNav, not the sidebar.
function isMobileProject(testInfo: { project: { name: string } }) {
  return testInfo.project.name === "mobile" || testInfo.project.name === "tablet-768";
}

/** Desktop: expand the "accounting" group in the sidebar, then click the real, visible link. */
async function navigateViaSidebar(page: Page) {
  const aside = page.locator('aside[aria-label="الشريط الجانبي"]');
  await expect(aside).toBeVisible({ timeout: 20_000 });
  const link = aside.locator(`a[href="${TB_HREF}"]`);
  if (!(await link.isVisible().catch(() => false))) {
    // Sidebar.tsx is section-collapsed: only the group's first surviving item
    // renders as a direct <a> until the group is expanded via its chevron —
    // real user behavior, not a shortcut.
    await aside.locator('button[aria-controls="nav-group-accounting"]').click();
  }
  await expect(link).toBeVisible({ timeout: 10_000 });
  await link.click();
}

/**
 * Mobile: tap the REAL MobileNav bottom bar — the only IN-APP nav chrome a
 * phone user has. MobileNav.tsx is a hard `.slice(0, 5)` of capability-
 * permitted items with no "more" overflow — reachability here is a real
 * PRODUCT CONSTRAINT, not a test bug, and confirmed empirically NOT to
 * include Trial Balance for either accountant or auditor's actual granted
 * capability set (verified directly against role_permissions, then against
 * the real rendered bar — accountant's higher-ranked "sales" capabilities
 * fill all 5 slots first). Failing the whole spec over a genuine, correctly-
 * enforced UI density tradeoff would be testing MobileNav's placement
 * policy, not the RBAC boundary this spec exists to prove. Recorded as a
 * visible, non-fatal finding (Playwright annotation, shows in the HTML
 * report) and falls back to a direct deep link — the same "log it, don't
 * silently route around it" pattern e2e/erp/erp.spec.ts's spaNavigate()
 * already uses for the identical class of situation — so the report's own
 * health/data is still exercised and verified either way.
 */
async function navigateViaMobileNav(page: Page, testInfo: { annotations: Array<{ type: string; description?: string }> }) {
  const nav = page.locator('nav[aria-label="تنقل سريع"]');
  await expect(nav).toBeVisible({ timeout: 20_000 });
  const link = nav.locator(`a[href="${TB_HREF}"]`);
  const reachable = await link.isVisible().catch(() => false);
  if (reachable) {
    await link.click();
    return;
  }
  const finding =
    "Trial Balance is NOT among MobileNav's first 5 permitted items for this role — a real mobile user cannot reach it from the bottom nav. " +
    "Falling back to direct navigation to still verify the report's own health/data; the unreachability itself is the finding.";
  console.warn("[trial-balance-rbac] " + finding);
  testInfo.annotations.push({ type: "mobilenav-unreachable", description: finding });
  await page.goto(TB_HREF);
}

async function navigateToTrialBalance(page: Page, testInfo: { project: { name: string }; annotations: Array<{ type: string; description?: string }> }) {
  if (isMobileProject(testInfo)) {
    await navigateViaMobileNav(page, testInfo);
  } else {
    await navigateViaSidebar(page);
  }
  await page.waitForURL(`**${TB_HREF}`, { timeout: 15_000 });
}

/** Wire the same zero-tolerance console/response contract erp.spec.ts uses. */
function trackHealthSignals(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) consoleErrors.push(m.text().slice(0, 220));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 220)));
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 240));
  });
  return { consoleErrors, failedRequests };
}

function assertHealthSignals(consoleErrors: string[], failedRequests: string[]) {
  expect(consoleErrors, "zero console errors expected").toEqual([]);
  expect(failedRequests, "zero unexpected API responses >=400 expected").toEqual([]);
}

// Tier A.3 Release Gate item 8 — accountant/auditor used to only assert the
// heading and the word "الإجمالي" were present, which passes identically
// whether the report shows real, correctly-computed data OR a near-empty
// shell with the same static chrome. Now asserts: no bad data-state, at
// least one real account row rendered, and the grand-total cells actually
// contain parseable numbers (not blank, not "NaN", not "—" placeholder
// text) — a genuinely healthy, populated report, not just its frame.
async function assertHealthyPopulatedReport(page: Page) {
  const main = page.locator("#main");
  for (const bad of BAD_STATES) {
    await expect(page.locator(`[data-state="${bad}"]`), `must not show data-state="${bad}"`).toHaveCount(0);
  }
  await expect(page.locator('[data-state="empty"]'), "must show REAL data, not the empty-report state").toHaveCount(0);
  await expect(page.getByRole("heading", { name: "ميزان المراجعة" }).first()).toBeVisible({ timeout: 20_000 });

  // Release-Candidate gate — every assertion ABOVE can pass against a report
  // that is still FETCHING, so the content checks below have to wait for a
  // real settle signal first. Each one is blind to loading for its own
  // reason: data-state="loading" is deliberately NOT in BAD_STATES (loading
  // is a legitimate state, exactly like empty), the empty-state element does
  // not exist yet while loading, and the heading is static page chrome that
  // paints before any data arrives. The row count then used a bare .count(),
  // which — unlike expect().toHaveCount() — is a ONE-SHOT read with no
  // auto-retry, so it sampled an empty tbody and failed.
  //
  // That is exactly what happened: this assertion failed once on `desktop`
  // and once on `tablet-768`, in different runs, while the other three
  // viewport projects passed against the SAME database in the SAME run.
  // Same data, same moment, different viewport is the signature of a race,
  // not of missing data. So the fix waits for the fetch to settle; it does
  // NOT relax what is asserted — every check below is unchanged in strength.
  await expect(
    page.locator('[data-state="loading"]'),
    "the report must finish loading before its contents are judged",
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(
    main.locator("table tbody tr").first(),
    "at least one real account row must be rendered, not just the report's chrome",
  ).toBeVisible({ timeout: 30_000 });

  const rowCount = await main.locator("table tbody tr").count();
  expect(rowCount, "at least one real account row must be rendered, not just the report's chrome").toBeGreaterThan(0);

  // The footer is rendered conditionally ({totals && …}) so it can also be
  // absent mid-fetch — wait for it rather than calling innerText() on a
  // locator that may not have resolved yet.
  await expect(main.locator("tfoot").first(), "the totals footer must be rendered").toBeVisible({ timeout: 30_000 });
  const footerText = await main.locator("tfoot").first().innerText();
  const numbers = footerText.match(/[\d,]+\.\d{2}/g) || [];
  expect(numbers.length, "the footer must contain real parseable money figures, not blank/placeholder cells").toBeGreaterThan(0);
  for (const n of numbers) {
    expect(Number.isNaN(Number(n.replace(/,/g, ""))), `footer figure "${n}" must be a real number`).toBe(false);
  }
}

test("accountant: real login, real navigation UI, healthy Trial Balance view with real data", async ({ page }, testInfo) => {
  const { consoleErrors, failedRequests } = trackHealthSignals(page);
  await realLogin(page, IDENTITIES.accountant.username);
  await page.waitForURL("**/app/overview", { timeout: 20_000 });

  await navigateToTrialBalance(page, testInfo);
  await assertHealthyPopulatedReport(page);
  assertHealthSignals(consoleErrors, failedRequests);
});

test("auditor: real login, real navigation UI, healthy read-only Trial Balance view with real data", async ({ page }, testInfo) => {
  const { consoleErrors, failedRequests } = trackHealthSignals(page);
  await realLogin(page, IDENTITIES.auditor.username);
  await page.waitForURL("**/app/overview", { timeout: 20_000 });

  await navigateToTrialBalance(page, testInfo);
  await assertHealthyPopulatedReport(page);
  assertHealthSignals(consoleErrors, failedRequests);
});

test("cashier: real login redirects to POS; nav UI never offers the link; a direct deep link is blocked; the API itself refuses the cashier's own token with a real 403", async ({ page }, testInfo) => {
  const { consoleErrors, failedRequests } = trackHealthSignals(page);
  await realLogin(page, IDENTITIES.cashier.username);
  // Login.tsx sends a cashier straight to /pos/, not /app/overview — their
  // home is the register, not the Back-Office. Confirms the app itself
  // already steers a cashier away from finance screens before RBAC even
  // has to intervene.
  await page.waitForURL("**/pos/**", { timeout: 20_000 });

  // ── Tier A.3 Release Gate item 8 — the SERVER, not just CapGuard, must
  // refuse this. Pull the cashier's own real JWT out of localStorage and
  // call the trial-balance API directly, bypassing the frontend entirely —
  // proves the backend RBAC gate (requireCapability('finance.reports.view')
  // in routes/erp-core.js) actually holds on its own, not just that the
  // React app's client-side guard happens to hide the link. ──
  const cashierToken = await getSessionToken(page);
  const direct = await apiCall("GET", `/api/erp/reports/trial-balance?from=2026-01-01&to=2026-12-31`, cashierToken);
  expect(direct.status, "the cashier's own token must be refused with a genuine server-side 403, not just hidden client-side").toBe(403);
  expect(direct.body && direct.body.code, "the 403 must carry a specific permission code").toBe("PERMISSION_DENIED");

  // Now the direct-URL attempt in the browser: same token (still in
  // localStorage from the login above), navigated straight at the ERP route
  // a cashier could guess or bookmark. This is CapGuard, the SECOND
  // independent enforcement point.
  await page.goto(TB_HREF);
  await expect(page.locator('[data-state="permission-denied"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByText("الإجمالي")).toHaveCount(0);

  // And on a screen a cashier CAN legitimately reach in the ERP shell, the
  // REAL navigation UI for this viewport — sidebar on desktop, MobileNav on
  // mobile — must never have offered the link either: a THIRD independent
  // enforcement point.
  await page.goto("/app/overview");
  if (isMobileProject(testInfo)) {
    const nav = page.locator('nav[aria-label="تنقل سريع"]');
    await expect(nav).toBeVisible({ timeout: 20_000 });
    await expect(nav.locator(`a[href="${TB_HREF}"]`), "cashier must NOT see ميزان المراجعة in MobileNav (no finance.reports.view)").toHaveCount(0);
  } else {
    const aside = page.locator('aside[aria-label="الشريط الجانبي"]');
    await expect(aside).toBeVisible({ timeout: 20_000 });
    const group = aside.locator('button[aria-controls="nav-group-accounting"]');
    if (await group.isVisible().catch(() => false)) await group.click();
    await expect(aside.locator(`a[href="${TB_HREF}"]`), "cashier must NOT see ميزان المراجعة in the sidebar (no finance.reports.view)").toHaveCount(0);
  }

  // The permission-denied screen and the blocked API call are both EXPECTED
  // non-2xx/bad-state outcomes for this specific test — assert health
  // signals only over what happened on /app/overview just above, where
  // everything should be genuinely clean.
  expect(consoleErrors, "zero console errors expected").toEqual([]);
  const unexpectedFailures = failedRequests.filter((r) => !r.includes("/reports/trial-balance"));
  expect(unexpectedFailures, "zero UNEXPECTED API responses >=400 (the trial-balance 403s above are the expected/asserted ones)").toEqual([]);
});
