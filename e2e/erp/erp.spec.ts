// ═══════════════════════════════════════════════════════════════════════════
// Unified ADLAN Back-Office (frontend/erp) — CLOSURE GATE E2E.
//
// Run:  npx playwright test --config=playwright.erp.config.ts
//       (build first: npm --prefix frontend/erp run build)
//
// This is the Definition-of-Done gate. It walks EVERY leaf route in the nav
// manifest (parsed from the single source of truth) at desktop 1440 AND mobile
// 390, and fails on ANY of:
//   • a non-healthy page state — data-state ∈ {error, offline, session-expired,
//     permission-denied, conflict, feature-disabled}.  data-state="empty" is a
//     legitimate business state and PASSES: that is the required distinction
//     between "no rows yet" and "failed to load".
//   • a placeholder / deferral phrase, or a back-to-legacy link in #main
//   • the router not actually landing on the requested route
//   • horizontal overflow, or the fixed MobileNav covering content
//   • ANY console error, or ANY response ≥400 — on BOTH viewports, no whitelist
//
// WHY SPA NAVIGATION (and not page.goto per leaf): a prior version goto'd all 89
// leaves on mobile, re-bootstrapping the app ~89× and firing ~500+ API calls from
// one IP. That tripped the server's own rate limiter (500/15min) → every screen
// rendered a 429 ErrorState → and because failed requests were only *logged* on
// mobile, the run reported a FALSE PASS. We now navigate via the router (one
// bootstrap for the whole walk) and assert network health on BOTH viewports.
// The sidebar is display:none on mobile, but a programmatic .click() on the
// anchor still bubbles to React Router's handler → real SPA navigation.
//
// The gate must run against a PRODUCTION build: CapGuard only enforces caps when
// import.meta.env.DEV is false.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const OUT_ROOT = path.join(process.cwd(), "artifacts", "e2e", "erp");
const CRASH_TEXT = "حدث خطأ غير متوقّع"; // ErrorBoundary recovery heading

// ── Leaves: parsed from the manifest (single source of truth) ────────────────
const MANIFEST_SRC = fs.readFileSync(
  path.join(process.cwd(), "frontend", "erp", "src", "app", "navigation", "manifest.ts"),
  "utf8",
);
type Leaf = { path: string; label: string };
const LEAVES: Leaf[] = [...MANIFEST_SRC.matchAll(/\bpath:\s*"([^"]+)"[^}\n]*\blabel:\s*"([^"]+)"/g)]
  .map((m) => ({ path: m[1], label: m[2] }))
  .filter((l, i, a) => a.findIndex((x) => x.path === l.path) === i);

// One representative leaf per nav group — used for deep-link + hard-refresh.
const GROUP_FIRST = ["/overview", "/sales/orders", "/menu/hub", "/pos-admin/register", "/inventory",
  "/purchasing/suppliers", "/accounting/chart-of-accounts", "/banking/cashboxes", "/people/employees",
  "/workflow/inbox", "/reports/sales", "/administration/companies"];

// Non-healthy page states. `empty` and `loading` are intentionally NOT here:
// "no rows yet" is a legitimate business state. `not-found` IS here — no manifest
// leaf may ever render the NotFound screen.
const BAD_STATES = [
  "error", "offline", "session-expired", "permission-denied", "conflict", "feature-disabled", "not-found",
];

// Distinctive placeholder / legacy-handoff sentences (kept specific so they can't
// collide with real business status text such as a transfer that is "قيد النقل").
const BANNED_PHRASES = [
  "قيد النقل إلى الواجهة",
  "قيد الإعداد",
  "قيد التحويل",
  "النظام الأصلي",
  "النظام الحالي",
  "يُدار حاليًا في النظام",
  "العودة للنظام",
];

// Benign console noise that is NOT an app error.
const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag/i;
// NOTE: there is deliberately NO network whitelist. A 404 from an API is a defect
// to fix, not an exception to hide.

const SHOTS: { path: string; file: string }[] = [
  { path: "/overview", file: "01-overview.png" },
  { path: "/sales/channels", file: "02b-sales-channels.png" },
  { path: "/sales/pricing", file: "02c-sales-pricing.png" },
  { path: "/menu/hub", file: "15-menu-hub.png" },
  { path: "/menu/recipes-bom", file: "17-menu-recipes-bom.png" },
  { path: "/inventory/items", file: "04-inventory-items.png" },
  { path: "/purchasing/requisitions", file: "19-purchasing-requisitions.png" },
  { path: "/accounting/chart-of-accounts", file: "06-accounting-coa.png" },
  { path: "/banking/reconciliation", file: "12-bank-reconciliation.png" },
  { path: "/people/payroll", file: "11-payroll.png" },
  { path: "/workflow/approval-flows", file: "14-approval-flows.png" },
  { path: "/administration/tax", file: "20-administration-tax-zatca.png" },
  { path: "/administration/security", file: "21-administration-security.png" },
];

test.describe.configure({ mode: "serial" });

/** Let in-flight XHRs settle so we never assert against a half-rendered screen. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

async function waitRendered(page: Page, label: string) {
  await page.waitForFunction(
    (crash) => {
      const body = document.body ? document.body.innerText || "" : "";
      if (body.includes(crash)) return true; // crash — asserted below
      const main = document.getElementById("main");
      if (!main) return false;
      // A settled screen either rendered a real state (data-state) or its chrome.
      if (main.querySelector("[data-state]")) return true;
      if (main.querySelector("h1, h2, h3, table, header")) return true;
      return (main.innerText || "").trim().length > 40;
    },
    CRASH_TEXT,
    { timeout: 30_000 },
  );
  expect(await page.getByText(CRASH_TEXT).count(), `error-boundary crash at ${label}`).toBe(0);
}

/**
 * Navigate via the ROUTER (no reload). The sidebar anchor is display:none on
 * mobile, but a programmatic click still bubbles to React Router's handler.
 */
async function spaNavigate(page: Page, routePath: string) {
  const href = `/app${routePath}`;
  const ok = await page.evaluate((h) => {
    const a = document.querySelector(`aside a[href="${h}"]`) as HTMLAnchorElement | null;
    if (!a) return false;
    a.click();
    return true;
  }, href);
  if (!ok) {
    // The link isn't in the sidebar (e.g. hidden by a cap/flag) — that itself is a
    // finding, but fall back to a deep link so the leaf is still audited.
    await page.goto(href);
  }
  await page.waitForURL(`**${href}`, { timeout: 15_000 }).catch(() => {});
  await waitRendered(page, routePath);
}

/** Collect every way a leaf is not real/healthy/contained (non-fatal → issues). */
async function auditLeaf(page: Page, leaf: Leaf, isMobile: boolean, issues: string[]) {
  const href = `/app${leaf.path}`;

  // 1) The router actually landed on the requested route.
  const url = new URL(page.url());
  if (url.pathname.replace(/\/$/, "") !== href.replace(/\/$/, "")) {
    issues.push(`${leaf.path}: router did not land here (url=${url.pathname})`);
    return; // everything below would describe the wrong screen
  }

  const probe = await page.evaluate(
    ({ banned, bad, h }) => {
      const main = document.getElementById("main");
      const txt = main ? main.innerText || "" : "";
      // Non-healthy state?
      let badState: string | null = null;
      if (main) {
        for (const el of Array.from(main.querySelectorAll("[data-state]"))) {
          const s = el.getAttribute("data-state") || "";
          if (bad.includes(s)) { badState = s; break; }
        }
      }
      const hit = banned.find((b: string) => txt.includes(b)) || null;
      const legacyLink = main ? !!main.querySelector('a[href="/"], a[href^="/legacy"]') : false;
      // Router identity: the sidebar marks the active route.
      const active = !!document.querySelector(`aside a[href="${h}"][aria-current="page"]`);
      // Overflow
      const de = document.documentElement;
      const bodyOverflow = de.scrollWidth - de.clientWidth;
      const mainOverflow = main ? main.scrollWidth - main.clientWidth : 0;
      // Fixed bottom MobileNav clearance
      const fixedBars = (Array.from(document.querySelectorAll("nav, div")) as HTMLElement[]).filter((el) => {
        const s = getComputedStyle(el);
        return s.position === "fixed" && parseFloat(s.bottom || "999") < 40 && el.offsetHeight > 30 && el.offsetHeight < 120;
      });
      const navH = fixedBars.length ? Math.max(...fixedBars.map((c) => c.offsetHeight)) : 0;
      const mainPadBottom = main ? parseFloat(getComputedStyle(main).paddingBottom || "0") : 0;
      const heading = main ? (main.querySelector("h1, h2")?.textContent || "").trim() : "";
      return { badState, hit, legacyLink, active, bodyOverflow, mainOverflow, navH, mainPadBottom, heading };
    },
    { banned: BANNED_PHRASES, bad: BAD_STATES, h: href },
  );

  if (probe.badState) issues.push(`${leaf.path}: non-healthy state "${probe.badState}" («${leaf.label}»)`);
  if (probe.hit) issues.push(`${leaf.path}: placeholder/legacy phrase "${probe.hit}"`);
  if (probe.legacyLink) issues.push(`${leaf.path}: back-to-legacy link in #main`);
  if (!probe.active) issues.push(`${leaf.path}: sidebar does not mark this route active (aria-current)`);
  if (probe.bodyOverflow > 1) issues.push(`${leaf.path}: horizontal overflow (body) ${probe.bodyOverflow}px`);
  if (probe.mainOverflow > 1) issues.push(`${leaf.path}: horizontal overflow (#main) ${probe.mainOverflow}px`);
  if (isMobile && probe.navH > 0 && probe.mainPadBottom < probe.navH * 0.8) {
    issues.push(`${leaf.path}: #main does not clear the ${probe.navH}px MobileNav (pad-bottom=${probe.mainPadBottom})`);
  }
  return probe.heading;
}

test("closure gate — every leaf is real, healthy, contained, legacy-free", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const usesMobileNav = project === "mobile" || project === "tablet-768";
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const issues: string[] = [];

  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) consoleErrors.push(m.text().slice(0, 220));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 220)));
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 240));
  });

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })],
  );

  // ── Shell + RTL (the ONLY full page load of the walk) ─────────────────────
  await page.goto("/app");
  await expect(page.locator("#root")).toHaveCount(1);
  await expect(page.locator('aside[aria-label="الشريط الجانبي"]')).toHaveCount(1);
  await expect(page.locator("main#main")).toHaveCount(1);
  await waitRendered(page, "/app (overview redirect)");
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.dir), "document.dir must be rtl").toBe("rtl");

  // ── Walk EVERY leaf via SPA navigation ────────────────────────────────────
  expect(LEAVES.length, "manifest leaf count").toBeGreaterThan(80);
  const headings: string[] = [];
  for (const leaf of LEAVES) {
    await test.step(`leaf ${leaf.path}`, async () => {
      await spaNavigate(page, leaf.path);
      await settle(page);
      const h = await auditLeaf(page, leaf, usesMobileNav, issues);
      headings.push(`${leaf.path} → ${h || "(no heading)"}`);
    });
  }

  // ── Deep-link + hard refresh, one per nav group ───────────────────────────
  for (const p of GROUP_FIRST) {
    const leaf = LEAVES.find((l) => l.path === p);
    if (!leaf) continue;
    await test.step(`refresh ${p}`, async () => {
      await page.goto(`/app${p}`);
      await waitRendered(page, `deep-link ${p}`);
      await page.reload();
      await waitRendered(page, `reload ${p}`);
      await settle(page);
      await auditLeaf(page, leaf, usesMobileNav, issues);
    });
  }

  // ── Screenshots (evidence) ────────────────────────────────────────────────
  const dir = path.join(OUT_ROOT, project);
  fs.mkdirSync(dir, { recursive: true });
  for (const { path: p, file } of SHOTS) {
    await test.step(`shot ${file}`, async () => {
      await spaNavigate(page, p);
      await settle(page);
      await page.waitForTimeout(450); // let the route-transition fade finish so the evidence isn't dimmed
      await page.screenshot({ path: path.join(dir, file), fullPage: true, animations: "disabled" });
    });
  }

  console.log(`\n[${project}] leaves walked: ${LEAVES.length}`);
  console.log(`[${project}] issues: ${issues.length}`);
  issues.forEach((i) => console.log(`  [issue] ${i}`));
  console.log(`[${project}] console errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  [console] ${e}`));
  console.log(`[${project}] failed requests: ${failedRequests.length}`);
  [...new Set(failedRequests)].forEach((r) => console.log(`  [network] ${r}`));

  expect(issues, "every leaf must be real, healthy, contained and legacy-free").toEqual([]);
  expect(consoleErrors, "zero console errors expected").toEqual([]);
  expect(failedRequests, "zero failed requests expected (both viewports, no whitelist)").toEqual([]);
});

test("company and branch scope stays readable from 390px through 1920px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one serial responsive matrix is enough");

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })],
  );

  const sizes = [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];

  for (const size of sizes) {
    await test.step(`${size.width}px scope layout`, async () => {
      await page.setViewportSize(size);
      await page.goto("/app/overview");
      await waitRendered(page, `/overview scope ${size.width}`);
      await settle(page);

      // The redesigned top bar exposes search + scope from Tailwind's `xl`
      // breakpoint (1280px). Below it they remain available in the tools row.
      if (size.width < 1280) {
        await page.getByRole("button", { name: /فتح البحث ونطاق العمل/ }).click();
      }

      const group = page.getByRole("group", { name: "نطاق عرض البيانات" });
      await expect(group).toBeVisible();
      await expect(group.getByRole("combobox", { name: "اختيار الشركة" })).toHaveValue("all");
      await expect(group.getByRole("combobox", { name: "اختيار الفرع" })).toHaveValue("all");
      await expect(group.getByText("كل الشركات", { exact: true }).last()).toBeVisible();
      await expect(group.getByText("كل الفروع", { exact: true }).last()).toBeVisible();

      const probe = await group.evaluate((scope) => {
        const rects = Array.from(scope.querySelectorAll("label")).map((label) => {
          const rect = label.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
        const valuesFit = Array.from(scope.querySelectorAll<HTMLElement>("[data-scope-value]"))
          .every((value) => value.scrollWidth <= value.clientWidth + 1);
        const search = Array.from(
          document.querySelectorAll<HTMLElement>('[aria-label="بحث والانتقال السريع (Ctrl+K)"]'),
        ).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return rect.width > 0
            && rect.height > 0
            && style.display !== "none"
            && style.visibility !== "hidden";
        });
        const scopeRect = scope.getBoundingClientRect();
        const searchRect = search?.getBoundingClientRect();
        const overlapsSearch = !!searchRect
          && scopeRect.left < searchRect.right
          && scopeRect.right > searchRect.left
          && scopeRect.top < searchRect.bottom
          && scopeRect.bottom > searchRect.top;
        return {
          bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rects,
          valuesFit,
          overlapsSearch,
        };
      });

      expect(probe.bodyOverflow, `${size.width}px must not overflow`).toBeLessThanOrEqual(1);
      expect(probe.valuesFit, `${size.width}px scope values must not clip`).toBe(true);
      expect(probe.overlapsSearch, `${size.width}px scope must not overlap search`).toBe(false);
      expect(probe.rects).toHaveLength(2);
      expect(probe.rects.every((rect) => rect.height >= 44 && rect.width >= 150)).toBe(true);

      const dir = path.join(OUT_ROOT, "scope-responsive");
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({
        path: path.join(dir, `scope-${size.width}.png`),
        fullPage: false,
        animations: "disabled",
      });
    });
  }
});

test("create and edit workflows use a full-page work area instead of side panels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one serial visual matrix is enough");

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })],
  );

  const flows = [
    { id: "supplier", path: "/app/purchasing/suppliers", trigger: /مورد جديد/, title: "إضافة مورد جديد" },
    { id: "customer", path: "/app/customers", trigger: /عميل جديد/, title: "إضافة عميل" },
    { id: "employee", path: "/app/people/employees", trigger: /موظف جديد/, title: "موظف جديد" },
  ];
  const sizes = [
    { label: "mobile", width: 390, height: 844 },
    { label: "desktop", width: 1440, height: 900 },
  ];

  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const flow of flows) {
      await test.step(`${size.label} ${flow.id} workspace`, async () => {
        await page.goto(flow.path);
        await waitRendered(page, `${flow.id} ${size.label}`);
        await settle(page);
        await page.getByRole("button", { name: flow.trigger }).click();

        const workspace = page.getByRole("region", { name: flow.title });
        await expect(workspace).toBeVisible();
        await expect(workspace).toHaveAttribute("data-presentation", "full-page");
        await expect(page.getByRole("dialog")).toHaveCount(0);

        const probe = await workspace.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        expect(probe.width).toBeGreaterThanOrEqual(probe.viewportWidth - 1);
        expect(probe.height).toBeGreaterThanOrEqual(probe.viewportHeight - 1);
        expect(probe.bodyOverflow).toBeLessThanOrEqual(1);

        const dir = path.join(OUT_ROOT, "workspaces");
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({
          path: path.join(dir, `${size.label}-${flow.id}.png`),
          fullPage: false,
          animations: "disabled",
        });

        await page.getByRole("button", { name: "العودة إلى الصفحة السابقة" }).click();
        await expect(workspace).toBeHidden();
      });
    }
  }
});
