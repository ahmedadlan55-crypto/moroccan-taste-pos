// ═══════════════════════════════════════════════════════════════════════════
// Unified ADLAN Back-Office (frontend/erp) — smoke + screenshot E2E.
//
// Run with:  npx playwright test --config=playwright.erp.config.ts
//   (build the bundle first: npm --prefix frontend/erp run build)
//
// Auth: the Back-Office shares the legacy JWT. addInitScript seeds
//   localStorage.pos_token   = <admin JWT from e2e/.token>
//   localStorage.pos_session = { user: "admin", role: "admin" }
// The React auth-provider decodes pos_token (username claim) → admin session,
// and can() hard-bypasses every capability for role "admin", so every nav item
// and deep link is reachable in the production build (CapGuard enforces caps
// when import.meta.env.DEV is false).
//
// Flow:
//   1. goto /app → assert the persistent shell (#root + sidebar) rendered.
//   2. Walk EACH nav group's first item (SPA click on desktop, goto on mobile
//      where the sidebar is display:none) → assert the page rendered (heading/
//      table, never the error-boundary crash) and ZERO console errors + ZERO
//      failed requests accumulated so far.
//   3. Deep-link 5 representative routes directly + page.reload() each → still
//      renders (history-fallback refresh-safe).
//   4. assert document.dir === "rtl".
//   5. Capture fullPage screenshots of ~10 representative screens.
// The whole run fails on any real console error or non-whitelisted 4xx/5xx.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const OUT_ROOT = path.join(process.cwd(), "artifacts", "e2e", "erp");
const CRASH_TEXT = "حدث خطأ غير متوقّع"; // the ErrorBoundary recovery heading

// Benign console noise that is NOT a real app error.
const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag/i;
// Failed responses that are allowed (pre-existing / irrelevant to the SPA).
const NETWORK_WHITELIST: RegExp[] = [
  /\/favicon\.ico(\?|$)/i,
  /\/api\/erp\/projects(\?|$)/i, // documented pre-existing 404 in some envs
];

// The first permitted nav item of every manifest group (admin sees all).
const GROUP_FIRST: { group: string; path: string }[] = [
  { group: "overview", path: "/overview" },
  { group: "sales", path: "/sales/orders" },
  { group: "pos-admin", path: "/pos-admin/register" },
  { group: "inventory", path: "/inventory" },
  { group: "purchasing", path: "/purchasing/suppliers" },
  { group: "accounting", path: "/accounting/chart-of-accounts" },
  { group: "banking", path: "/banking/cashboxes" },
  { group: "people", path: "/people/employees" },
  { group: "workflow", path: "/workflow/inbox" },
  { group: "reports", path: "/reports/sales" },
  { group: "administration", path: "/administration/companies" },
];

// ~10 representative screens to screenshot at both viewports.
const SHOTS: { path: string; file: string }[] = [
  { path: "/overview", file: "01-overview.png" },
  { path: "/sales/orders", file: "02-sales-orders.png" },
  { path: "/customers", file: "03-customers.png" },
  { path: "/inventory/items", file: "04-inventory-items.png" },
  { path: "/purchasing/orders", file: "05-purchasing-orders.png" },
  { path: "/accounting/trial-balance", file: "06-accounting-trial-balance.png" },
  { path: "/banking/cashboxes", file: "07-banking-cashboxes.png" },
  { path: "/people/employees", file: "08-people-employees.png" },
  { path: "/administration/audit-log", file: "09-administration-audit-log.png" },
  { path: "/workflow/inbox", file: "10-workflow-inbox.png" },
  // FC-P3 converted screens
  { path: "/people/payroll", file: "11-payroll.png" },
  { path: "/banking/reconciliation", file: "12-bank-reconciliation.png" },
  { path: "/banking/cash-closing", file: "13-cash-closing.png" },
  { path: "/workflow/approval-flows", file: "14-approval-flows.png" },
];

// Deep-linked routes that must survive a hard refresh (history fallback).
const DEEP_LINKS = [
  "/accounting/chart-of-accounts", // E1 — converted heavy editor
  "/accounting/journals", // E1 — converted heavy editor
  "/accounting/trial-balance",
  "/sales/orders",
  "/inventory/items",
  "/administration/audit-log",
  "/people/employees",
  // FC-P3 — converted placeholders (payroll, bank-rec, cash-closing, workflow
  // builder, vouchers) must render cleanly (0 console errors / 0 failed reqs).
  "/people/payroll",
  "/banking/reconciliation",
  "/banking/cash-closing",
  "/workflow/approval-flows",
  "/banking/receipts",
];

// E1 — the two converted heavy editors, captured at all four review viewports.
const E1_VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1024, h: 768 },
  { w: 1440, h: 900 },
];
const E1_SCREENS = [
  { path: "/accounting/chart-of-accounts", name: "coa" },
  { path: "/accounting/journals", name: "journals" },
];

test.describe.configure({ mode: "serial" });

async function waitRendered(page: Page, label: string) {
  await page.waitForFunction(
    (crash) => {
      // A top-level crash makes the ErrorBoundary REPLACE the whole tree
      // (shell + #main disappear), so check the document body for the crash
      // heading first — otherwise #main is null and we'd wait forever.
      const bodyTxt = document.body ? document.body.innerText || "" : "";
      if (bodyTxt.includes(crash)) return true; // crash — asserted below
      const main = document.getElementById("main");
      if (!main) return false;
      // Settled = the lazy chunk mounted a real page, not the Suspense skeleton
      // (which has none of these). Page titles come from PageHeader (h1) or the
      // workflow ScreenIntro (<header>); list pages render a <table> when they
      // have rows; empty/loading pages still carry their heading.
      return !!main.querySelector("h1, h2, table, header");
    },
    CRASH_TEXT,
    { timeout: 30_000 },
  );
  const crashed = await page.getByText(CRASH_TEXT).count();
  expect(crashed, `error-boundary crash at ${label}`).toBe(0);
}

async function navTo(page: Page, routePath: string) {
  const href = `/app${routePath}`;
  const link = page.locator(`aside[aria-label="الشريط الجانبي"] a[href="${href}"]`).first();
  const clickable = await link.isVisible().catch(() => false);
  if (clickable) {
    // Desktop: exercise real client-side (SPA) routing via the sidebar.
    await link.click();
    await page.waitForURL(`**${href}`, { timeout: 15_000 }).catch(() => {});
  } else {
    // Mobile: the sidebar is display:none — deep-link through the history fallback.
    await page.goto(href);
  }
  await waitRendered(page, routePath);
}

test("unified back-office — smoke, refresh-safety & screenshots", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error" && !BENIGN_CONSOLE.test(msg.text())) {
      consoleErrors.push(msg.text().slice(0, 220));
    }
  });
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + String(err).slice(0, 220)));
  page.on("response", (res) => {
    if (res.status() >= 400 && !NETWORK_WHITELIST.some((re) => re.test(res.url()))) {
      failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`.slice(0, 240));
    }
  });

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })],
  );

  // ── 1. Shell renders ──────────────────────────────────────────────────────
  await page.goto("/app");
  await expect(page.locator("#root")).toHaveCount(1);
  // The sidebar <aside> is in the DOM on both viewports (display:none on mobile).
  await expect(page.locator('aside[aria-label="الشريط الجانبي"]')).toHaveCount(1);
  await expect(page.locator("main#main")).toHaveCount(1);
  await waitRendered(page, "/app (overview redirect)");

  // ── 4. RTL (assert early; it must hold for the whole run) ──────────────────
  const dir = await page.evaluate(() => document.documentElement.dir);
  expect(dir, "document.dir must be rtl").toBe("rtl");

  // ── 2. Walk every nav group's first item ──────────────────────────────────
  const walk: string[] = [];
  for (const { group, path: p } of GROUP_FIRST) {
    await test.step(`nav ${group} → ${p}`, async () => {
      await navTo(page, p);
      walk.push(`${group}: ${p} [ok]`);
      // Fail fast the moment any error accumulates so the culprit screen is clear.
      expect(consoleErrors, `console errors after ${p}`).toEqual([]);
      expect(failedRequests, `failed requests after ${p}`).toEqual([]);
    });
  }

  // ── 3. Deep-link + hard-refresh safety ────────────────────────────────────
  for (const p of DEEP_LINKS) {
    await test.step(`refresh ${p}`, async () => {
      await page.goto(`/app${p}`);
      await waitRendered(page, `deep-link ${p}`);
      await page.reload();
      await waitRendered(page, `reload ${p}`);
      expect(consoleErrors, `console errors after reload ${p}`).toEqual([]);
      expect(failedRequests, `failed requests after reload ${p}`).toEqual([]);
    });
  }

  // ── 5. Screenshots ────────────────────────────────────────────────────────
  const dir2 = path.join(OUT_ROOT, project);
  fs.mkdirSync(dir2, { recursive: true });
  const shot: string[] = [];
  for (const { path: p, file } of SHOTS) {
    await test.step(`shot ${file}`, async () => {
      await navTo(page, p);
      await page.waitForTimeout(500); // fonts + route transition settle
      await page.screenshot({ path: path.join(dir2, file), fullPage: true });
      shot.push(file);
    });
  }

  // ── 6. E1 heavy editors — explicit 4-viewport capture (once, desktop project) ─
  if (project === "desktop") {
    const e1dir = path.join(dir2, "e1");
    fs.mkdirSync(e1dir, { recursive: true });
    for (const s of E1_SCREENS) {
      for (const v of E1_VIEWPORTS) {
        await test.step(`e1 shot ${s.name} ${v.w}x${v.h}`, async () => {
          await page.setViewportSize({ width: v.w, height: v.h });
          await page.goto(`/app${s.path}`);
          await waitRendered(page, `${s.name} ${v.w}x${v.h}`);
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(e1dir, `${s.name}-${v.w}x${v.h}.png`), fullPage: true });
        });
      }
    }
    // The journal EDITOR (open "قيد جديد") at desktop + mobile, for visual review
    // of the live-balance grid, dimension header and mandatory-cost-center rule.
    for (const v of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      await test.step(`e1 shot journal-editor ${v.w}x${v.h}`, async () => {
        await page.setViewportSize({ width: v.w, height: v.h });
        await page.goto(`/app/accounting/journals`);
        await waitRendered(page, `journals ${v.w}x${v.h}`);
        const newBtn = page.getByRole("button", { name: /قيد جديد/ }).first();
        if (await newBtn.isVisible().catch(() => false)) {
          await newBtn.click();
          await page.waitForTimeout(700);
          await page.screenshot({ path: path.join(e1dir, `journal-editor-${v.w}x${v.h}.png`), fullPage: true });
        }
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 }); // restore
  }

  // ── Evidence for the report ───────────────────────────────────────────────
  console.log(`\n[${project}] nav walk:\n  ${walk.join("\n  ")}`);
  console.log(`[${project}] screenshots: ${shot.join(", ")}`);
  console.log(`[${project}] console errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  [console] ${e}`));
  console.log(`[${project}] failed requests (non-whitelisted): ${failedRequests.length}`);
  failedRequests.forEach((r) => console.log(`  [network] ${r}`));

  expect(consoleErrors, "zero console errors expected").toEqual([]);
  expect(failedRequests, "zero non-whitelisted failed requests expected").toEqual([]);
});
