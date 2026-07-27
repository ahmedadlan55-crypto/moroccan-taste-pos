// ═══════════════════════════════════════════════════════════════════════════
// Sales Analytics Hub — RBAC E2E (wave W5c; pattern cloned from
// trial-balance-rbac.spec.ts: REAL login through the product's own form, real
// throwaway identities, server-side enforcement probed with the identity's OWN
// token — never just the client-side guard).
//
// Run:  npx playwright test --config=playwright.erp.config.ts e2e/erp/sales-hub-rbac.spec.ts
//
// Proves, against the live capability seeds (db/migrations/capability-seeds/
// g-analytics.json):
//   cashier — holds NO analytics.view: a direct /app/reports/sales deep-link
//     renders data-state="permission-denied", no nav chrome ever offers the
//     hub link, AND the cashier's own token gets a genuine server-side 403
//     from POST /api/analytics/query (middleware/analyticsScope).
//   manager — holds analytics.view but NOT analytics.cost.view: the
//     profitability tab is hidden from the strip, a deep-link renders the
//     tab-gate PermissionDenied, and — the money assertion — cost/profit
//     metric VALUES never appear in any /api/analytics/query response payload
//     for that identity: masked keys are absent from rows/subtotals/totals
//     (meta.maskedMetrics names them), and an all-masked request is refused
//     with 403 ANALYTICS_ALL_MASKED.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

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
// Honors E2E_PORT (playwright.erp.config.ts) — see trial-balance-rbac.spec.ts.
const API_BASE = `http://127.0.0.1:${Number(process.env.E2E_PORT) || 3027}`;
const HUB_HREF = "/app/reports/sales";
const PW = "E2eShRbac#2026!Aa";
const SUFFIX = Date.now();

// Seed fixture constants (provision-and-serve.js seeds prefix E2E-SH).
const PREFIX = "E2E-SH";
const SEED_RANGE = { from: "2032-03-01", to: "2032-03-31" };
const COST_METRICS = ["cogs", "gross_profit", "margin_pct"] as const;

const IDENTITIES = {
  cashier: { username: `e2e_sh_cash_${SUFFIX}`, role: "cashier" },
  manager: { username: `e2e_sh_mgr_${SUFFIX}`, role: "manager" },
} as const;

const BENIGN_CONSOLE =
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
  return { status: res.status, body: json as Record<string, unknown> | null };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  for (const id of Object.values(IDENTITIES)) {
    const created = await apiCall("POST", "/api/auth/users", ADMIN_TOKEN, {
      username: id.username,
      password: PW,
      role: id.role,
      displayName: `E2E SH RBAC ${id.role}`,
    });
    if (!created.body || created.body.success !== true) {
      throw new Error(`setup: POST /api/auth/users failed for role=${id.role}: ${JSON.stringify(created.body)}`);
    }
  }
  // Fixture-only concerns (same class of setup exception trial-balance-rbac
  // documents): (1) clear the forced first-login password change; (2) grant
  // the MANAGER warehouse access to the seeded fixture warehouses so their
  // analytics branch scope covers the seed branches — the masking assertions
  // below must run against REAL rows, not an empty fail-closed scope.
  const mysql = require("mysql2/promise");
  const { e2eDbConfig } = require("../e2e-db-name");
  const db = await mysql.createConnection(e2eDbConfig(readDotEnv()));
  try {
    await db.query(`UPDATE users SET must_change_password = 0 WHERE username IN (?, ?)`, [
      IDENTITIES.cashier.username,
      IDENTITIES.manager.username,
    ]);
    const [[mgr]] = await db.query(`SELECT id FROM users WHERE username = ? LIMIT 1`, [
      IDENTITIES.manager.username,
    ]);
    if (!mgr || mgr.id == null) throw new Error("setup: manager user id not found");
    for (const wh of [`${PREFIX}-W1`, `${PREFIX}-W2`]) {
      await db.query(
        `INSERT INTO user_warehouse_access (user_id, warehouse_id, created_by) VALUES (?, ?, 'e2e-fixture')`,
        [mgr.id, wh],
      );
    }
  } finally {
    await db.end();
  }
});

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
    console.error("CRITICAL: sales-hub-rbac.spec.ts cleanup could not delete fixture users:", failures);
  }
});

async function realLogin(page: Page, username: string) {
  await page.goto("/app/login");
  const usernameInput = page.locator('input[autocomplete="username"]');
  const passwordInput = page.locator('input[autocomplete="current-password"]');
  await expect(usernameInput).toBeVisible({ timeout: 30_000 });
  await usernameInput.fill(username);
  await passwordInput.fill(PW);
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
}

async function getSessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem("pos_token") || "");
  if (!token) throw new Error("getSessionToken: no pos_token in localStorage after login");
  return token;
}

function trackConsole(page: Page) {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) consoleErrors.push(m.text().slice(0, 220));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 220)));
  return consoleErrors;
}

/** Recursively collect every object key present anywhere in a JSON payload. */
function collectKeys(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

test("cashier: hub deep-link renders permission-denied; nav never offers the hub; the API refuses the cashier's own token with a real 403", async ({ page }) => {
  const consoleErrors = trackConsole(page);
  await realLogin(page, IDENTITIES.cashier.username);
  // Login.tsx sends a cashier to the register, not the Back-Office.
  await page.waitForURL("**/pos/**", { timeout: 20_000 });

  // ── server-side: the cashier's own JWT, straight at the analytics API ──
  const cashierToken = await getSessionToken(page);
  const direct = await apiCall("POST", "/api/analytics/query", cashierToken, {
    metrics: ["net_ex_vat"],
    dimensions: [],
    range: SEED_RANGE,
    dateBasis: "business_day",
  });
  expect(direct.status, "analyticsScope must refuse a cashier with a genuine server-side 403").toBe(403);
  expect(direct.body && direct.body.code, "the 403 must carry the canonical permission code").toBe("PERMISSION_DENIED");
  const metadata = await apiCall("GET", "/api/analytics/metadata", cashierToken);
  expect(metadata.status, "the registry endpoint must refuse a cashier too").toBe(403);

  // ── client-side: a guessed/bookmarked deep link is EJECTED from /app ──
  // This used to assert the hub's own PermissionDenied panel. The v8.1 portal
  // isolation (frontend/erp/src/app/providers/require-auth.tsx, the UI half of
  // middleware/posPortalScope.js) is stronger than that: a POS-only role never
  // gets the back-office shell at all — RequireAuth sends them home to /pos/
  // before any route renders. So the assertion is now "no back-office screen
  // ever painted", which subsumes "the hub was denied".
  await page.goto(HUB_HREF);
  await page.waitForURL("**/pos/**", { timeout: 20_000 });
  // Nothing from the hub rendered anywhere on the way out (unscoped on
  // purpose — #main belongs to the shell the cashier must never receive).
  await expect(page.locator('[data-testid="analytics-topbar"]')).toHaveCount(0);
  await expect(page.locator('button[aria-haspopup="listbox"]')).toHaveCount(0);

  // ── and a screen a cashier could legitimately reach in the ERP is ejected
  //    the same way, so no nav surface exists that could offer the hub link ──
  await page.goto("/app/overview");
  await page.waitForURL("**/pos/**", { timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await expect(
    page.locator('aside[aria-label="الشريط الجانبي"]'),
    "the back-office shell must never render for a cashier",
  ).toHaveCount(0);
  await expect(
    page.locator(`a[href="${HUB_HREF}"]`),
    "no nav surface may offer the sales-analytics hub to a cashier",
  ).toHaveCount(0);

  expect(consoleErrors, "zero console errors expected").toEqual([]);
});

test("manager (no analytics.cost.view): profitability tab hidden + deep-link tab-gate denied; cost metric values absent from EVERY query response", async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors = trackConsole(page);

  // Intercept EVERY /api/analytics/query response this session produces and
  // harvest all keys of all payloads — the cost metric ids must never appear.
  const seenPayloadKeys = new Set<string>();
  const seenMasked: string[][] = [];
  page.on("response", (r) => {
    if (!r.url().includes("/api/analytics/query")) return;
    r.json()
      .then((body) => {
        const data = (body && (body as Record<string, unknown>).data) ?? body;
        collectKeys(data, seenPayloadKeys);
        const masked = (body as { meta?: { maskedMetrics?: string[] } })?.meta?.maskedMetrics;
        if (Array.isArray(masked)) seenMasked.push(masked);
      })
      .catch(() => {});
  });

  await realLogin(page, IDENTITIES.manager.username);
  await page.waitForURL("**/app/overview", { timeout: 20_000 });

  // ── the hub itself renders for a manager (analytics.view granted) ──
  const seedQs = `?from=${SEED_RANGE.from}&to=${SEED_RANGE.to}`;
  await page.goto(`${HUB_HREF}/executive${seedQs}`);
  const picker = page.locator('#main button[aria-haspopup="listbox"]').first();
  await expect(picker).toBeVisible({ timeout: 30_000 });

  // Picker: 15 of 16 sections — profitability (cost-gated) hidden; the
  // cashiers section STAYS (manager holds analytics.employees.view).
  await picker.click();
  const options = page.locator('#main [role="listbox"] [role="option"]');
  await expect(options, "manager sees 15 sections (profitability hidden)").toHaveCount(15);
  await expect(
    options.filter({ hasText: "الربحية" }),
    "the profitability section must be hidden without analytics.cost.view",
  ).toHaveCount(0);
  await expect(
    options.filter({ hasText: "أداء الكاشير" }),
    "the cashiers section stays (manager holds analytics.employees.view)",
  ).toHaveCount(1);
  await page.keyboard.press("Escape");

  // ── deep-link to the cost-gated segment → the tab-gate PermissionDenied ──
  await page.goto(`${HUB_HREF}/profitability${seedQs}`);
  await expect(page.locator('[data-state="permission-denied"]')).toHaveCount(1, { timeout: 20_000 });
  // The picker stays (the hub is not blanked — only the segment is denied).
  await expect(page.locator('#main button[aria-haspopup="listbox"]').first()).toBeVisible();

  // ── walk data-bearing segments so real query traffic flows ──
  for (const segment of ["executive", "items", "cashiers"]) {
    await page.goto(`${HUB_HREF}/${segment}${seedQs}`);
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await expect(page.locator('#main [data-state="loading"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('#main [data-state="error"]')).toHaveCount(0);
  }

  // ── server-side with the manager's OWN token ──
  const managerToken = await getSessionToken(page);

  // (a) mixed request: visible metrics answer, cost metrics are masked OUT of
  //     the payload and NAMED in meta.maskedMetrics — never zeroed, never sent.
  const mixed = await apiCall("POST", "/api/analytics/query", managerToken, {
    metrics: ["net_ex_vat", ...COST_METRICS],
    dimensions: ["menu_item"],
    range: SEED_RANGE,
    dateBasis: "business_day",
    filters: [{ dimension: "branch", op: "in", values: [`${PREFIX}-B1`, `${PREFIX}-B2`] }],
  });
  expect(mixed.status, "a mixed request answers 200 with the visible slice").toBe(200);
  const mixedKeys = new Set<string>();
  collectKeys((mixed.body as { data?: unknown })?.data, mixedKeys);
  for (const costId of COST_METRICS) {
    expect(mixedKeys.has(costId), `"${costId}" must NOT appear anywhere in the response payload`).toBe(false);
  }
  const mixedMasked = ((mixed.body as { meta?: { maskedMetrics?: string[] } })?.meta?.maskedMetrics ?? []) as string[];
  for (const costId of COST_METRICS) {
    expect(mixedMasked, "meta.maskedMetrics must name every refused metric").toContain(costId);
  }
  // The visible metric really did come back with seed data (not an empty dodge).
  expect(mixedKeys.has("net_ex_vat"), "the visible metric must still answer").toBe(true);

  // (b) all-masked request → hard 403, not an empty 200.
  const allMasked = await apiCall("POST", "/api/analytics/query", managerToken, {
    metrics: [...COST_METRICS],
    dimensions: [],
    range: SEED_RANGE,
    dateBasis: "business_day",
  });
  expect(allMasked.status, "an all-cost request must be refused outright").toBe(403);
  expect(allMasked.body && allMasked.body.code).toBe("ANALYTICS_ALL_MASKED");

  // ── the harvested BROWSER traffic never carried a cost value either ──
  expect(seenPayloadKeys.size, "the walk must have produced real query traffic").toBeGreaterThan(0);
  for (const costId of COST_METRICS) {
    expect(
      seenPayloadKeys.has(costId),
      `"${costId}" must never appear in any /api/analytics/query response payload for this manager`,
    ).toBe(false);
  }

  expect(consoleErrors, "zero console errors expected").toEqual([]);
});
