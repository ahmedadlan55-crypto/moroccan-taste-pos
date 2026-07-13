// ═══════════════════════════════════════════════════════════════════════════
// Unified ADLAN Back-Office (frontend/erp) — CLOSURE GATE E2E.
//
// Run with:  npx playwright test --config=playwright.erp.config.ts
//   (build the bundle first: npm --prefix frontend/erp run build)
//
// This is the Definition-of-Done gate for the Closure Sprint. It walks EVERY
// leaf route in the nav manifest (not one-per-group) at both desktop (1440) and
// mobile (390) viewports and FAILS the moment any screen is not "real":
//   • a placeholder / deferral phrase is visible  ("قيد الإعداد", "قيد التحويل",
//     "قيد النقل", "النظام الأصلي", "النظام الحالي", DeferredScreen text)
//   • a back-to-legacy link is present in #main    (href="/" or href^="/legacy",
//     or an "العودة للنظام" control)
//   • the content overflows horizontally           (#main scrollWidth > clientWidth)
//   • the fixed MobileNav would cover content       (main lacks bottom clearance)
//   • any console error or non-whitelisted ≥400 response occurs
//
// Auth: shares the legacy JWT. addInitScript seeds localStorage.pos_token (admin)
// + pos_session; can() hard-bypasses caps for role "admin" so every leaf renders
// in the production build. The leaf list is parsed from the manifest source so it
// can never drift from the single source of truth.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const OUT_ROOT = path.join(process.cwd(), "artifacts", "e2e", "erp");
const CRASH_TEXT = "حدث خطأ غير متوقّع"; // the ErrorBoundary recovery heading

// ── Leaf routes: parsed from the manifest (single source of truth) ───────────
const MANIFEST_SRC = fs.readFileSync(
  path.join(process.cwd(), "frontend", "erp", "src", "app", "navigation", "manifest.ts"),
  "utf8",
);
const LEAF_PATHS: string[] = [...MANIFEST_SRC.matchAll(/\bpath:\s*"(\/[^"]*)"/g)]
  .map((m) => m[1])
  .filter((p, i, a) => a.indexOf(p) === i);

// ── Banned content — proof a screen is still a placeholder / legacy hand-off ──
const BANNED_PHRASES = [
  "قيد الإعداد",
  "قيد التحويل",
  "قيد النقل",
  "النظام الأصلي",
  "النظام الحالي",
  "يُدار حاليًا في النظام",
  "العودة للنظام",
];

// Benign console noise that is NOT a real app error.
const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag/i;
// Failed responses that are allowed (pre-existing / irrelevant to the SPA).
const NETWORK_WHITELIST: RegExp[] = [
  /\/favicon\.ico(\?|$)/i,
  /\/api\/erp\/projects(\?|$)/i, // documented pre-existing 404 in some envs
];

// Representative screens to screenshot at both viewports (evidence for report).
const SHOTS: { path: string; file: string }[] = [
  { path: "/overview", file: "01-overview.png" },
  { path: "/sales/orders", file: "02-sales-orders.png" },
  { path: "/sales/channels", file: "02b-sales-channels.png" },
  { path: "/sales/pricing", file: "02c-sales-pricing.png" },
  { path: "/menu/hub", file: "15-menu-hub.png" },
  { path: "/menu/brand", file: "16-menu-brand.png" },
  { path: "/menu/recipes-bom", file: "17-menu-recipes-bom.png" },
  { path: "/menu/price-lists", file: "18-menu-price-lists.png" },
  { path: "/inventory/items", file: "04-inventory-items.png" },
  { path: "/purchasing/requisitions", file: "19-purchasing-requisitions.png" },
  { path: "/accounting/trial-balance", file: "06-accounting-trial-balance.png" },
  { path: "/banking/reconciliation", file: "12-bank-reconciliation.png" },
  { path: "/people/payroll", file: "11-payroll.png" },
  { path: "/workflow/approval-flows", file: "14-approval-flows.png" },
  { path: "/administration/tax", file: "20-administration-tax-zatca.png" },
  { path: "/administration/security", file: "21-administration-security.png" },
];

test.describe.configure({ mode: "serial" });

async function waitRendered(page: Page, label: string) {
  await page.waitForFunction(
    (crash) => {
      const bodyTxt = document.body ? document.body.innerText || "" : "";
      if (bodyTxt.includes(crash)) return true; // crash — asserted below
      const main = document.getElementById("main");
      if (!main) return false;
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
    await link.click(); // desktop: real SPA routing
    await page.waitForURL(`**${href}`, { timeout: 15_000 }).catch(() => {});
  } else {
    await page.goto(href); // mobile: sidebar is display:none — history fallback
  }
  await waitRendered(page, routePath);
}

/** The core gate: assert a rendered leaf is real, contained, and legacy-free. */
async function assertClean(page: Page, routePath: string, isMobile: boolean) {
  const probe = await page.evaluate(
    ({ banned }) => {
      const main = document.getElementById("main");
      const txt = main ? main.innerText || "" : "";
      const hit = banned.find((b: string) => txt.includes(b)) || null;
      // Legacy back-links inside the content area.
      const legacyLink = main
        ? !!main.querySelector('a[href="/"], a[href^="/legacy"], a[href="/app/"][data-legacy]')
        : false;
      // Horizontal overflow — the page body must never scroll sideways.
      const de = document.documentElement;
      const bodyOverflow = de.scrollWidth - de.clientWidth;
      const mainOverflow = main ? main.scrollWidth - main.clientWidth : 0;
      // MobileNav clearance: the fixed bottom bar must not cover content.
      const nav = document.querySelector('nav[aria-label], [data-mobile-nav]') as HTMLElement | null;
      // find the fixed bottom nav specifically (lg:hidden bottom bar)
      let navH = 0;
      const candidates = Array.from(document.querySelectorAll("nav, div")).filter((el) => {
        const s = getComputedStyle(el as HTMLElement);
        return s.position === "fixed" && parseFloat(s.bottom || "999") < 40 && (el as HTMLElement).offsetHeight < 120 && (el as HTMLElement).offsetHeight > 30;
      }) as HTMLElement[];
      if (candidates.length) navH = Math.max(...candidates.map((c) => c.offsetHeight));
      const mainPadBottom = main ? parseFloat(getComputedStyle(main).paddingBottom || "0") : 0;
      return { hit, legacyLink, bodyOverflow, mainOverflow, navH, mainPadBottom, nav: !!nav };
    },
    { banned: BANNED_PHRASES },
  );

  expect(probe.hit, `placeholder/legacy phrase visible on ${routePath}: "${probe.hit}"`).toBeNull();
  expect(probe.legacyLink, `back-to-legacy link present in #main on ${routePath}`).toBe(false);
  expect(
    probe.bodyOverflow,
    `horizontal overflow (body) on ${routePath}: scrollWidth-clientWidth=${probe.bodyOverflow}`,
  ).toBeLessThanOrEqual(1);
  expect(
    probe.mainOverflow,
    `horizontal overflow (#main) on ${routePath}: scrollWidth-clientWidth=${probe.mainOverflow}`,
  ).toBeLessThanOrEqual(1);
  if (isMobile && probe.navH > 0) {
    expect(
      probe.mainPadBottom,
      `#main must clear the ${probe.navH}px MobileNav on ${routePath} (padding-bottom=${probe.mainPadBottom})`,
    ).toBeGreaterThanOrEqual(probe.navH * 0.8);
  }
}

test("closure gate — every leaf is real, contained, legacy-free", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const isMobile = project === "mobile";
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

  // ── Shell renders + RTL ────────────────────────────────────────────────────
  await page.goto("/app");
  await expect(page.locator("#root")).toHaveCount(1);
  await expect(page.locator('aside[aria-label="الشريط الجانبي"]')).toHaveCount(1);
  await expect(page.locator("main#main")).toHaveCount(1);
  await waitRendered(page, "/app (overview redirect)");
  const dir = await page.evaluate(() => document.documentElement.dir);
  expect(dir, "document.dir must be rtl").toBe("rtl");

  // ── Walk EVERY leaf route ──────────────────────────────────────────────────
  expect(LEAF_PATHS.length, "manifest leaf count").toBeGreaterThan(80);
  const walked: string[] = [];
  for (const p of LEAF_PATHS) {
    await test.step(`leaf ${p}`, async () => {
      await navTo(page, p);
      await assertClean(page, p, isMobile);
      walked.push(p);
      expect(consoleErrors, `console errors after ${p}`).toEqual([]);
      expect(failedRequests, `failed requests after ${p}`).toEqual([]);
    });
  }

  // ── Deep-link refresh-safety on a sample ───────────────────────────────────
  for (const p of ["/menu/hub", "/purchasing/requisitions", "/administration/security", "/workflow/approval-flows"]) {
    await test.step(`refresh ${p}`, async () => {
      await page.goto(`/app${p}`);
      await waitRendered(page, `deep-link ${p}`);
      await page.reload();
      await waitRendered(page, `reload ${p}`);
      await assertClean(page, p, isMobile);
    });
  }

  // ── Screenshots (evidence) ─────────────────────────────────────────────────
  const dir2 = path.join(OUT_ROOT, project);
  fs.mkdirSync(dir2, { recursive: true });
  for (const { path: p, file } of SHOTS) {
    await test.step(`shot ${file}`, async () => {
      await navTo(page, p);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(dir2, file), fullPage: true });
    });
  }

  console.log(`\n[${project}] leaves walked: ${walked.length}/${LEAF_PATHS.length}`);
  console.log(`[${project}] console errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  [console] ${e}`));
  console.log(`[${project}] failed requests: ${failedRequests.length}`);
  failedRequests.forEach((r) => console.log(`  [network] ${r}`));

  expect(consoleErrors, "zero console errors expected").toEqual([]);
  expect(failedRequests, "zero non-whitelisted failed requests expected").toEqual([]);
});
