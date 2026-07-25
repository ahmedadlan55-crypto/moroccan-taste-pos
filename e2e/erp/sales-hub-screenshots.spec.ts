// ═══════════════════════════════════════════════════════════════════════════
// Sales Analytics Hub — DELIVERY-REPORT screenshots (wave W5c).
//
// These are REPORT ARTIFACTS for docs/status/screenshots/, not pinned
// baselines: full-page PNGs of four representative hub screens (executive,
// explorer, profitability, reconciliation) in AR desktop + AR mobile + EN
// desktop = 12 PNGs, named `sales-hub--<segment>--<lang>-<viewport>.png`.
// Nothing is diffed here — the pinned diffs live in visual-baselines.spec.ts.
//
// Runs inside the ordinary erp e2e (the provisioned server + E2E-SH seed are
// already up): the desktop project writes the 8 desktop shots (ar+en), the
// mobile project writes the 4 AR mobile shots; the other projects skip.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const OUT_DIR = path.join(process.cwd(), "docs", "status", "screenshots");
const CRASH_TEXT = "حدث خطأ غير متوقّع";
const SEED_QS = "?from=2032-03-01&to=2032-03-31";

const SEGMENTS = ["executive", "explorer", "profitability", "reconciliation"] as const;

async function login(page: Page, lang: "ar" | "en") {
  await page.route("**/api/user-preferences", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ language: lang }) });
  });
  await page.addInitScript(
    ([token, session, l]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("erp_lang", l);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" }), lang],
  );
}

async function capture(page: Page, lang: "ar" | "en", viewport: string) {
  for (const segment of SEGMENTS) {
    await test.step(`${segment} [${lang} ${viewport}]`, async () => {
      await page.goto(`/app/reports/sales/${segment}${SEED_QS}`);
      await page.waitForFunction(
        (crash) => {
          const body = document.body ? document.body.innerText || "" : "";
          if (body.includes(crash)) return true;
          const main = document.getElementById("main");
          return !!main && (!!main.querySelector("[data-state], h1, h2, table") || (main.innerText || "").trim().length > 40);
        },
        CRASH_TEXT,
        { timeout: 30_000 },
      );
      expect(await page.getByText(CRASH_TEXT).count(), `crash at ${segment}`).toBe(0);
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await expect(page.locator('#main [data-state="loading"]')).toHaveCount(0, { timeout: 30_000 });
      await page.evaluate(() => (document as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready);
      await page.waitForTimeout(1800); // recharts JS intro settle
      await page.screenshot({
        path: path.join(OUT_DIR, `sales-hub--${segment}--${lang}-${viewport}.png`),
        fullPage: true,
        animations: "disabled",
      });
    });
  }
}

test("delivery screenshots — sales hub report artifacts", async ({ page }, testInfo) => {
  test.skip(
    !["desktop", "mobile"].includes(testInfo.project.name),
    "delivery shots are captured on desktop (ar+en) and mobile (ar) only",
  );
  test.setTimeout(420_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (testInfo.project.name === "desktop") {
    await login(page, "ar");
    await capture(page, "ar", "desktop");
    // Fresh context state for the EN pass: same page object, new routing pin.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await login(page, "en");
    await capture(page, "en", "desktop");
  } else {
    await login(page, "ar");
    await capture(page, "ar", "mobile");
  }
});
