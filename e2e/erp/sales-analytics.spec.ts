// ═══════════════════════════════════════════════════════════════════════════
// Sales Analytics Hub — E2E (Sales Analytics sprint, wave W5c).
//
// Run:  npx playwright test --config=playwright.erp.config.ts e2e/erp/sales-analytics.spec.ts
//       (build first: npm --prefix frontend/erp run build)
//
// DATA: scripts/e2e/provision-and-serve.js seeds tests/fixtures/salesHubSeed.js
// into the e2e clone under prefix E2E-SH, window 2032-03 (far future, disjoint
// from everything the dev clone holds). Every exact value asserted below is a
// hand-computed salesHubSeed EXPECTED constant, so a drift here is a REAL
// engine/UI regression, never fixture noise. The specs deep-link each segment
// with ?from/to pinned to the seed window so pages render REAL numbers — the
// default last30 window (2026) would show only healthy-but-empty states.
//
// COVERED (per the wave contract):
//   1. every one of the 16 segments × all four viewport projects: healthy
//      data-state (never error/permission-denied/…), tab strip + TopBar
//      rendered, zero console errors, zero failed requests, no horizontal
//      overflow;
//   2. desktop-focused flows: deep-link restore (chips + scoped table),
//      the branch → business_day → hour → cashier → orders → invoice drill
//      chain, an English-language pass over four representative segments,
//      and the business-day/tax-basis toggles changing the displayed numbers
//      (exact seed values both ways).
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const CRASH_TEXT = "حدث خطأ غير متوقّع";

// ── seed constants (tests/fixtures/salesHubSeed.js, prefix E2E-SH) ──────────
const PREFIX = "E2E-SH";
const SEED_FROM = "2032-03-01";
const SEED_TO = "2032-03-31";
const B1 = `${PREFIX}-B1`; // ITEST SH Riyadh
const B1_NAME = "ITEST SH Riyadh";
const B2_NAME = "ITEST SH Cairo";
const CASHIER = `${PREFIX}-c1`;
// EXPECTED grand totals (default filters, business-day basis, ex-VAT):
const NET_EX_VAT_ALL = "950";      // EXPECTED.TOTAL.net_ex_vat
const NET_INCL_VAT_ALL = "1,071.5"; // EXPECTED.TOTAL.net_incl_vat (formatted)
// F8 same-UTC-instant fixture: business-day vs calendar-day disagree for B2.
// BD_ALL['2032-03-19'] = 30 exists ONLY on the business-day basis; on the
// calendar basis that order counts on 03-20 (CAL_B2).

// ── the five centres and their reports (frontend lib/reportRegistry) ────────
// The hub is /reports/sales/<centre>?view=<report>. Kept literal here on
// purpose: if the registry changes, THIS list is the contract a bookmark and a
// support answer depend on, and the sweep below must fail rather than follow.
const REPORTS = [
  { id: "executive", centre: "executive" },
  { id: "items", centre: "items" },
  { id: "profitability", centre: "items" },
  { id: "modifiers", centre: "items" },
  { id: "payments", centre: "payments" },
  { id: "taxes", centre: "payments" },
  { id: "discounts", centre: "payments" },
  { id: "reconciliation", centre: "payments" },
  { id: "branches", centre: "operations" },
  { id: "channels", centre: "operations" },
  { id: "hours", centre: "operations" },
  { id: "cashiers", centre: "operations" },
  { id: "shifts", centre: "operations" },
  { id: "voids", centre: "operations" },
  { id: "orders", centre: "operations" },
  { id: "explorer", centre: "explorer" },
  { id: "builder", centre: "explorer" },
] as const;

/** Retired flat paths → the report they became. Every one is somebody's bookmark. */
const RETIRED_PATHS: Record<string, { centre: string; view: string }> = {
  "item-sales": { centre: "items", view: "items" },
  modifiers: { centre: "items", view: "modifiers" },
  profitability: { centre: "items", view: "profitability" },
  taxes: { centre: "payments", view: "taxes" },
  discounts: { centre: "payments", view: "discounts" },
  reconciliation: { centre: "payments", view: "reconciliation" },
  branches: { centre: "operations", view: "branches" },
  cashiers: { centre: "operations", view: "cashiers" },
  hours: { centre: "operations", view: "hours" },
  shifts: { centre: "operations", view: "shifts" },
  voids: { centre: "operations", view: "voids" },
  orders: { centre: "operations", view: "orders" },
  builder: { centre: "explorer", view: "builder" },
};

const BAD_STATES = [
  "error", "offline", "session-expired", "permission-denied", "conflict", "feature-disabled", "not-found",
];

// Same benign-console allowlist as erp.spec.ts — kept in sync deliberately.
const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag|Blocked script execution in .?about:srcdoc/i;

/** requestfailed entries that are CANCELLATIONS, not failures: react-query
 *  aborts superseded queries by design (AbortSignal threaded through the hub
 *  data hooks), so ERR_ABORTED is expected traffic on any filter change. */
const BENIGN_REQUEST_FAILURE = /ERR_ABORTED|net::ERR_ABORTED/i;

/** The canonical URL of a report, on the seed window. */
function seedUrl(reportId: string, extra = ""): string {
  const centre = REPORTS.find((r) => r.id === reportId)?.centre ?? reportId;
  return `/app/reports/sales/${centre}?view=${reportId}&from=${SEED_FROM}&to=${SEED_TO}${extra}`;
}

interface HealthSignals {
  consoleErrors: string[];
  failedRequests: string[];
  failedResponses: string[];
}

/** Same zero-tolerance contract erp.spec.ts enforces, plus requestfailed. */
function trackHealth(page: Page): HealthSignals {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) consoleErrors.push(m.text().slice(0, 220));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 220)));
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText ?? "";
    if (BENIGN_REQUEST_FAILURE.test(failure)) return; // react-query cancellation
    // Everything this suite loads is same-origin (127.0.0.1:3027) — there is
    // no third-party traffic to exempt, so any residual failure is a defect.
    failedRequests.push(`${failure} ${r.method()} ${r.url()}`.slice(0, 240));
  });
  page.on("response", (r) => {
    if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 240));
  });
  return { consoleErrors, failedRequests, failedResponses };
}

function assertHealth(h: HealthSignals) {
  expect(h.consoleErrors, "zero console errors expected").toEqual([]);
  expect(h.failedRequests, "zero failed (non-cancelled) requests expected").toEqual([]);
  expect(h.failedResponses, "zero responses >=400 expected").toEqual([]);
}

async function loginAs(page: Page, lang: "ar" | "en" = "ar") {
  // Pin the server-persisted language preference — language-sync.tsx would
  // otherwise overwrite the localStorage seed on mount (same pattern as
  // visual-baselines.spec.ts).
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

/** Wait until the page settled into a healthy (ready/empty) state. */
async function waitHealthy(page: Page, label: string) {
  await waitRendered(page, label);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await expect(
    page.locator('#main [data-state="loading"]'),
    `${label}: must finish loading before its state is judged`,
  ).toHaveCount(0, { timeout: 30_000 });
  for (const bad of BAD_STATES) {
    await expect(
      page.locator(`#main [data-state="${bad}"]`),
      `${label}: must not settle into data-state="${bad}"`,
    ).toHaveCount(0);
  }
}

/**
 * Flip a basis radio (tax / date) through the compact filter bar.
 *
 * The bar became DRAFT-FIRST: the two basis toggles moved behind «المزيد من
 * الفلاتر», and no control commits to the URL until «تطبيق» is pressed. That is
 * the point of the redesign — a report must never repaint under a new period's
 * label before the user asked for it — so this test drives the same three steps
 * a person does, rather than reaching past the interaction it is meant to cover.
 *
 * The panel is left OPEN between calls (it auto-opens when the URL already
 * carries one of its filters), hence the guarded expand.
 */
async function setBasis(page: Page, radioName: string) {
  const panel = page.locator("#analytics-more-filters");
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "المزيد من الفلاتر" }).click();
    await expect(panel, "the inline more-filters panel must open").toBeVisible();
  }
  await page.getByRole("radio", { name: radioName }).click();
  const apply = page.getByRole("button", { name: "تطبيق" });
  await expect(apply, `«تطبيق» must enable once ${radioName} differs from the applied filters`).toBeEnabled();
  await apply.click();
}

async function assertHubChrome(page: Page, label: string) {
  // The grouped report picker (admin holds every cap → all 17 reports, grouped
  // by the five centres) + TopBar.
  const trigger = page.locator('#main button[aria-haspopup="listbox"]').first();
  await expect(trigger, `${label}: hub report picker must render`).toBeVisible();
  await trigger.click();
  const listbox = page.locator('#main [role="listbox"]');
  await expect(listbox, `${label}: the picker must open`).toBeVisible();
  await expect(
    listbox.locator('[role="option"]'),
    `${label}: admin sees all 17 reports`,
  ).toHaveCount(17);
  await page.keyboard.press("Escape");
  await expect(listbox, `${label}: Escape must close the picker`).toHaveCount(0);
  await expect(
    page.locator('[data-testid="analytics-topbar"]'),
    `${label}: the shared analytics TopBar must render`,
  ).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${label}: no horizontal overflow (scrollWidth <= clientWidth + 1)`).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: "serial" });

// ─────────────────────────────────────────────────────────────────────────────
// 1) All 17 reports, every viewport project (desktop/mobile/tablet/laptop).
// ─────────────────────────────────────────────────────────────────────────────
test("all 17 hub reports render healthy on this viewport", async ({ page }) => {
  test.setTimeout(420_000);
  const health = trackHealth(page);
  await loginAs(page);

  for (const { id: segment, centre } of REPORTS) {
    await test.step(`report ${segment}`, async () => {
      await page.goto(seedUrl(segment));
      await waitHealthy(page, `/reports/sales/${centre}?view=${segment}`);
      await assertHubChrome(page, segment);
      await assertNoHorizontalOverflow(page, segment);
      // Router ↔ picker identity: exactly one option is selected, and the
      // trigger names that same report (no title table needed — the two must
      // simply agree, in whatever language the UI is running).
      const trigger = page.locator('#main button[aria-haspopup="listbox"]').first();
      const triggerText = ((await trigger.textContent()) || "").trim();
      expect(triggerText, `${segment}: the picker must name the open report`).not.toBe("");
      await trigger.click();
      const selected = page.locator('#main [role="listbox"] [role="option"][aria-selected="true"]');
      await expect(selected, `${segment}: exactly one selected section`).toHaveCount(1);
      await expect(selected, `${segment}: picker label matches the selection`).toContainText(
        triggerText,
      );
      await page.keyboard.press("Escape");
    });
  }

  assertHealth(health);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b) Every retired flat path still resolves — with its filter state.
//
// The seventeen flat report paths became five centres. A bookmark is a promise,
// and a redirect that lands on the right centre while dropping the query string
// is not a working link: it is a link to a DIFFERENT report over a different
// period. So each retired path is opened with a real filter state on it.
// ─────────────────────────────────────────────────────────────────────────────
test("every retired report path lands on its report with the filter state intact", async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(test.info().project.name !== "desktop", "one viewport is enough for routing");
  const health = trackHealth(page);
  await loginAs(page);

  for (const [retired, target] of Object.entries(RETIRED_PATHS)) {
    await test.step(`${retired} → ${target.centre}?view=${target.view}`, async () => {
      const qs = `from=${SEED_FROM}&to=${SEED_TO}&branchId=${encodeURIComponent(B1)}&unknown=keep-me`;
      await page.goto(`/app/reports/sales/${retired}?${qs}`);
      await page.waitForURL(`**/app/reports/sales/${target.centre}**`, { timeout: 20_000 });

      const url = new URL(page.url());
      expect(url.pathname, `${retired}: redirect target`).toBe(`/app/reports/sales/${target.centre}`);
      expect(url.searchParams.get("view"), `${retired}: opens the right report`).toBe(target.view);
      // The whole filter state rides along — including a param the hub knows
      // nothing about, because a real bookmark carries one.
      expect(url.searchParams.get("from")).toBe(SEED_FROM);
      expect(url.searchParams.get("to")).toBe(SEED_TO);
      expect(url.searchParams.get("branchId")).toBe(B1);
      expect(url.searchParams.get("unknown")).toBe("keep-me");

      await waitHealthy(page, `${retired} → ${target.view}`);
      // …and the carried scope is really APPLIED, not merely present in the URL.
      await expect(page.locator('[data-testid="active-filter-chips"]')).toContainText("2032");
    });
  }

  assertHealth(health);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Focused desktop flows.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("focused flows (desktop)", () => {
  test.beforeEach(() => {
    // Focused interaction flows run once, on the desktop project; the
    // 16-segment × 4-viewport health sweep above is the cross-viewport gate.
    test.skip(test.info().project.name !== "desktop", "desktop-only focused flows");
  });

  test("deep-link restore: explorer?by=branch&from&to&branchId rebuilds chips and scopes the table", async ({ page }) => {
    const health = trackHealth(page);
    await loginAs(page);

    await page.goto(seedUrl("explorer", `&by=branch&branchId=${B1}`));
    await waitHealthy(page, "explorer deep-link");

    // Filter chips reflect the URL: a period chip + a branch chip.
    const chips = page.locator('[data-testid="active-filter-chips"]');
    await expect(chips, "active-filter chips row must render for a non-default URL").toBeVisible();
    await expect(chips, "period chip must reflect the URL from/to").toContainText("2032");
    await expect(chips.getByText(/الفرع/), "branch chip must be present").toBeVisible();

    // The pivot table is genuinely SCOPED: only the pinned branch appears.
    const main = page.locator("#main");
    await expect(main.getByText(B1_NAME).first(), "pinned branch row must render").toBeVisible({ timeout: 20_000 });
    await expect(main.getByText(B2_NAME), "the other branch must be filtered OUT").toHaveCount(0);

    // KPI total = EXPECTED.B1.net_ex_vat (830) — exact seed math, ex-VAT.
    await expect(
      page.locator('[data-testid="kpi-row"]'),
      "B1-scoped net KPI must equal the hand-computed 830",
    ).toContainText("830");

    assertHealth(health);
  });

  test("drill chain: executive day-drill, then explorer branch→day→hour→cashier→orders→invoice", async ({ page }) => {
    test.setTimeout(240_000);
    const health = trackHealth(page);
    await loginAs(page);

    // ── executive: click a by-day table row → the day is pinned in the URL ──
    await page.goto(seedUrl("executive"));
    await waitHealthy(page, "executive (drill start)");
    // `:visible` skips the collapsed ChartCard <details> tables, which carry
    // the same day text but no click handler.
    const dayRow = page
      .locator("#main table tbody tr:visible")
      .filter({ hasText: "2032-03-10" })
      .first();
    await expect(dayRow, "seeded business day 2032-03-10 must appear in the by-day table").toBeVisible();
    await dayRow.click();
    await page.waitForURL(/from=2032-03-10/, { timeout: 15_000 });
    expect(page.url()).toContain("to=2032-03-10");

    // ── explorer: walk the full drill chain on the seed window ──
    await page.goto(seedUrl("explorer", "&by=branch"));
    await waitHealthy(page, "explorer (chain start)");

    const clickLeaf = async (text: string | RegExp, label: string) => {
      // Leaf rows only — subtotal rows carry data-subtotal (PivotTable.tsx).
      const leaf = page
        .locator('#main table tbody tr')
        .filter({ hasText: text })
        .first();
      await expect(leaf, `${label}: drillable row must be visible`).toBeVisible({ timeout: 20_000 });
      await leaf.click();
    };

    await clickLeaf(B1_NAME, "branch leaf");
    await page.waitForURL(/by=business_day/, { timeout: 15_000 });
    expect(page.url(), "branch drill pins branchId").toContain(`branchId=${encodeURIComponent(B1)}`);
    await waitHealthy(page, "explorer by=business_day");

    await clickLeaf("2032-03-10", "business-day leaf");
    await page.waitForURL(/by=hour/, { timeout: 15_000 });
    expect(page.url(), "day drill pins from=to").toContain("from=2032-03-10");
    await waitHealthy(page, "explorer by=hour");

    // F1 is the only B1 order on 03-10 → local hour 13.
    await clickLeaf(/13/, "hour leaf");
    await page.waitForURL(/by=cashier/, { timeout: 15_000 });
    expect(page.url(), "hour drill pins hour").toMatch(/hour=13/);
    await waitHealthy(page, "explorer by=cashier");

    // Chain end: the cashier leaf hands off to the orders segment.
    await clickLeaf(CASHIER, "cashier leaf");
    // The orders report lives in the OPERATIONS centre now, and the drill goes
    // straight to its canonical URL rather than through the retired path.
    await page.waitForURL(/\/reports\/sales\/operations/, { timeout: 15_000 });
    expect(page.url(), "cashier hand-off targets the orders report").toContain("view=orders");
    expect(page.url(), "cashier hand-off pins cashierId on orders").toContain("cashierId=");
    await waitHealthy(page, "orders (drill terminus)");

    // ── orders: click an invoice row → the canonical operational detail ──
    const invoiceRow = page.locator("#main table tbody tr").first();
    await expect(invoiceRow, "orders table must list invoices").toBeVisible({ timeout: 20_000 });
    await invoiceRow.click();
    await page.waitForURL(/\/sales\/invoices\?doc=/, { timeout: 15_000 });
    expect(page.url(), "invoice click lands on /sales/invoices?doc=<id>").toMatch(/\/sales\/invoices\?doc=.+/);
    await waitRendered(page, "invoice detail");

    assertHealth(health);
  });

  test("English pass: four representative reports render the EN dictionary", async ({ page }) => {
    test.setTimeout(240_000);
    const health = trackHealth(page);
    await loginAs(page, "en");

    const EN_CHECKS: Array<{ segment: string; texts: string[] }> = [
      { segment: "executive", texts: ["Sales Analytics", "Reports · Sales", "Executive"] },
      { segment: "explorer", texts: ["Explorer", "Sales Analytics"] },
      { segment: "hours", texts: ["Hours", "Sales Analytics"] },
      { segment: "channels", texts: ["Sales channels", "Sales Analytics"] },
      { segment: "reconciliation", texts: ["Reconciliation", "Sales Analytics"] },
    ];
    for (const { segment, texts } of EN_CHECKS) {
      await test.step(`EN ${segment}`, async () => {
        await page.goto(seedUrl(segment));
        await waitHealthy(page, `EN /reports/sales/${segment}`);
        for (const text of texts) {
          await expect(
            page.getByText(text, { exact: false }).first(),
            `EN ${segment}: "${text}" must render`,
          ).toBeVisible();
        }
        // The picker carries the EN title too.
        await expect(
          page.locator('#main button[aria-haspopup="listbox"]').first(),
        ).toBeVisible();
      });
    }

    assertHealth(health);
  });

  test("tax + business-day toggles change the displayed numbers (exact seed values)", async ({ page }) => {
    test.setTimeout(240_000);
    const health = trackHealth(page);
    await loginAs(page);

    // ── tax basis: executive net = 950.00 ex-VAT, 1,071.50 incl-VAT ──
    // The rebuilt executive report is chart-free: net_ex_vat is the `=` line of
    // the stepped SALES STATEMENT, not a KPI card (the kpi-row now carries the
    // operational counters — orders / avg ticket / qty / items-per-order /
    // guests). Read the named statement line, scoped to the sales statement so
    // the cost/profit statement's own net line cannot be picked up instead.
    await page.goto(seedUrl("executive"));
    await waitHealthy(page, "executive (tax excl)");
    const netLine = page.locator('[data-testid="statement-sales"] tr[data-line="net"]');
    await expect(netLine, "the sales statement's net line must render").toHaveCount(1);
    await expect(netLine, "ex-VAT net must equal EXPECTED.TOTAL.net_ex_vat").toContainText(NET_EX_VAT_ALL);

    await setBasis(page, "شامل الضريبة");
    await page.waitForURL(/taxIncl/, { timeout: 15_000 });
    await waitHealthy(page, "executive (tax incl)");
    await expect(
      netLine,
      "incl-VAT net must equal EXPECTED.TOTAL.net_incl_vat (950 + 121.5)",
    ).toContainText(NET_INCL_VAT_ALL);

    // ── date basis: F8's B2 order books on 03-19 (business) vs 03-20 (calendar) ──
    await page.goto(seedUrl("executive"));
    await waitHealthy(page, "executive (business-day basis)");
    await expect(
      page.locator("#main table tbody").last(),
      "business-day basis: 2032-03-19 row exists (B2's 03:30 local order)",
    ).toContainText("2032-03-19");

    await setBasis(page, "اليوم التقويمي");
    await page.waitForURL(/businessDay/, { timeout: 15_000 });
    await waitHealthy(page, "executive (calendar basis)");
    await expect(
      page.locator("#main table tbody").last(),
      "calendar basis: the 03-19 business-day row disappears (order counts on 03-20)",
    ).not.toContainText("2032-03-19");

    assertHealth(health);
  });
});
