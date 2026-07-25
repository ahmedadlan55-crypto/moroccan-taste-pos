// ═══════════════════════════════════════════════════════════════════════════
// Retired report surfaces → Sales Analytics Hub redirects (wave W5c).
//
// Run:  npx playwright test --config=playwright.erp.config.ts e2e/erp/sales-hub-redirects.spec.ts
//
// Mirrors app/router.tsx's REDIRECTS table (the ONE allow-listed home for old
// report paths). For each retired path: an old deep link WITH query params —
// mapped params, plus a foreign param the map does not know — must land on
// the new hub segment with EVERY param preserved, settle into a healthy
// data-state, and produce zero console errors.
//
// The ?from/&to values are pinned to the E2E-SH seed window so the landing
// screen renders REAL data — proving the carried params actually filter
// (release note in router.tsx: on the old /accounting/sales-analytics page the
// brand/branch params never worked; the hub honors them for the first time).
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const CRASH_TEXT = "حدث خطأ غير متوقّع";

const SEED_FROM = "2032-03-01";
const SEED_TO = "2032-03-31";
const BRAND = "E2E-SH-BRAND";

// Mirror of app/router.tsx REDIRECTS (kept literal on purpose: if the router
// table changes, THIS list is the contract old bookmarks depend on).
const CASES = [
  {
    from: "/accounting/sales-analytics",
    to: "/reports/sales/executive",
    // old param → carried value; brandId maps 1:1, unknown passes through.
    query: { from: SEED_FROM, to: SEED_TO, brandId: BRAND, unknown: "keep-me" },
  },
  {
    from: "/pos-admin/reports",
    to: "/reports/sales/shifts",
    query: { from: SEED_FROM, to: SEED_TO, unknown: "keep-me" },
  },
] as const;

const BAD_STATES = [
  "error", "offline", "session-expired", "permission-denied", "conflict", "feature-disabled", "not-found",
];
const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag|Blocked script execution in .?about:srcdoc/i;

async function waitRendered(page: Page, label: string) {
  await page.waitForFunction(
    (crash) => {
      const body = document.body ? document.body.innerText || "" : "";
      if (body.includes(crash)) return true;
      const main = document.getElementById("main");
      if (!main) return false;
      if (main.querySelector("[data-state]")) return true;
      if (main.querySelector("h1, h2, h3, table, header")) return true;
      return (main.innerText || "").trim().length > 40;
    },
    CRASH_TEXT,
    { timeout: 30_000 },
  );
  expect(await page.getByText(CRASH_TEXT).count(), `error-boundary crash at ${label}`).toBe(0);
}

test("every retired report path redirects into the hub with ALL query params preserved and a healthy screen", async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) consoleErrors.push(m.text().slice(0, 220));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 220)));
  page.on("response", (r) => {
    if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 240));
  });

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })],
  );

  for (const spec of CASES) {
    await test.step(`${spec.from} → ${spec.to}`, async () => {
      const qs = new URLSearchParams(spec.query as Record<string, string>).toString();
      await page.goto(`/app${spec.from}?${qs}`);

      // The router must land on the NEW path (replace-redirect, same tab).
      await page.waitForURL(`**/app${spec.to}**`, { timeout: 20_000 });
      const url = new URL(page.url());
      expect(url.pathname, "redirect target path").toBe(`/app${spec.to}`);

      // EVERY param preserved — mapped ones under their canonical names,
      // foreign ones untouched.
      for (const [key, value] of Object.entries(spec.query)) {
        expect(
          url.searchParams.get(key),
          `param "${key}" must survive the redirect verbatim`,
        ).toBe(value);
      }

      // The landing screen settles healthy (never an error/denied state).
      await waitRendered(page, spec.to);
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await expect(page.locator('#main [data-state="loading"]')).toHaveCount(0, { timeout: 30_000 });
      for (const bad of BAD_STATES) {
        await expect(
          page.locator(`#main [data-state="${bad}"]`),
          `${spec.to}: must not settle into data-state="${bad}"`,
        ).toHaveCount(0);
      }

      // The hub actually HONORS the carried window: the period chip reflects
      // the old link's from/to (the codec treats non-default URL params as
      // active filters — this is what makes the redirect a real migration,
      // not a cosmetic path swap).
      await expect(page.locator('[data-testid="active-filter-chips"]')).toContainText("2032");
    });
  }

  expect(consoleErrors, "zero console errors expected").toEqual([]);
  expect(failedResponses, "zero responses >=400 expected").toEqual([]);
});
