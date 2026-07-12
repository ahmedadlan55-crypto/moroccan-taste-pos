// ═══════════════════════════════════════════════════════════════════
// Stage C — BASELINE screenshots of the 10 legacy accounting screens.
//
// Run with:  npx playwright test --config=playwright.accounting.config.ts
//
// Auth: silent auto-login. public/js/app.js (~line 621) reads
//   localStorage.pos_token  (JWT)
//   localStorage.pos_session — parsed with JSON.parse(saved).role at the
//   TOP level and state.user = s.user || s.username, i.e. the shape is
//   { user: "admin", role: "admin" }  (user is a STRING, role top-level).
// Any role except cashier/custody/employee proceeds to the admin shell:
// refresh-token → fetchAppTemplate → injectAppTemplate → loadCoreData →
// initViews → #adminView becomes visible.
//
// Each view is captured in its own test.step with try/catch so one broken
// screen never aborts the run — we always screenshot whatever rendered
// (that IS the honest baseline, e.g. the AR/AP aging perpetual loading row
// caused by the api-bridge calling /api/erp/ar-aging while the server only
// serves /api/erp/reports/ar-aging).
// ═══════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
// SHOT_PHASE selects the output folder. Default is "after" so an accidental
// run can never overwrite the pre-redesign baseline; pass SHOT_PHASE=before
// deliberately to (re)capture a baseline.
const PHASE = process.env.SHOT_PHASE || "after";
const OUT_ROOT = path.join(process.cwd(), "artifacts", "e2e", "accounting", PHASE);

// Known-acceptable failures (documented; PRE-EXISTING — verified untouched by
// every Stage C commit via git diff e13cfcc..HEAD):
// - /api/erp/cost-centers        → 500: local DB still has the pre-name_ar schema
// - /api/erp/projects            → 404: journals dims filter caller (erp.js) hits
//                                   a route not mounted on this server config
// - /api/sse/inbox               → 401: notifications SSE rejects the synthetic
//                                   e2e JWT (no server-side session row)
// - /api/auth/users-list         → 404: boot-path caller predates Stage C
const NETWORK_WHITELIST = [
  /\/api\/erp\/cost-centers/,
  /\/api\/erp\/projects(\?|$)/,
  /\/api\/sse\/inbox/,
  /\/api\/auth\/users-list/,
];

test.describe.configure({ mode: "serial" });

// small settle helper — fonts/paint
const SETTLE_MS = 500;

async function shoot(page: Page, project: string, file: string, fullPage = true) {
  const dir = path.join(OUT_ROOT, project);
  fs.mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: path.join(dir, file), fullPage });
}

async function erpNavTo(page: Page, key: string) {
  await page.evaluate((k) => (window as any).erpNav(k), key);
  await expect(page.locator(`#${key}`)).toBeVisible({ timeout: 15_000 });
}

test("accounting screens baseline", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const results: string[] = [];

  // ── console / network evidence collectors ──
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    // Resource-load failures are judged by the network collector below (which
    // carries the documented whitelist); here we keep only REAL JS errors.
    if (msg.type() === "error" && !/^Failed to load resource/.test(msg.text())) {
      consoleErrors.push(msg.text().slice(0, 200));
    }
  });
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + String(err).slice(0, 200)));
  page.on("response", (res) => {
    if (res.status() >= 400 && !NETWORK_WHITELIST.some((re) => re.test(res.url()))) {
      failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`.slice(0, 220));
    }
  });

  await page.addInitScript(
    ([token, session]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("pos_last_section", "home");
      // Flag caches read SYNCHRONOUSLY by the nav guards — pin both OFF so
      // erpARAging / erpAPAging stay in the legacy shell (matches the
      // server env P2P='' / O2C='' this config boots with).
      localStorage.setItem("procurement_p2p_flag", "0");
      localStorage.setItem("order_to_cash_flag", "0");
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" })]
  );

  await page.goto("/");
  await expect(page.locator("#adminView")).toBeVisible({ timeout: 60_000 });
  // let core data + sidebar hydration finish
  await page.waitForTimeout(1500);

  // ── helper wrapping each capture so failures never abort the run ──
  async function capture(
    nn: string,
    key: string,
    file: string,
    ready: (() => Promise<void>) | null,
    opts: { fullPage?: boolean; pre?: () => Promise<void> } = {}
  ) {
    await test.step(`${nn}-${key}`, async () => {
      let status = "ok";
      try {
        await erpNavTo(page, key);
        if (opts.pre) await opts.pre();
        if (ready) await ready();
      } catch (e: any) {
        status = "degraded: " + String(e && e.message ? e.message.split("\n")[0] : e).slice(0, 140);
      }
      // ALWAYS screenshot whatever is on screen — that is the baseline.
      await shoot(page, project, file, opts.fullPage !== false);
      results.push(`${file}  [${status}]`);
    });
  }

  // 01 — Chart of accounts (anchor: #coaTreeBody has children)
  await capture("01", "erpGLAccounts", "01-erpGLAccounts.png", async () => {
    await page.waitForFunction(
      () => {
        const b = document.getElementById("coaTreeBody");
        return !!b && b.children.length > 0;
      },
      { timeout: 20_000 }
    );
  });

  // 02 — Journals list (anchor: seeded rows in #erpJournalsBody)
  await capture("02", "erpGLJournals", "02-erpGLJournals.png", async () => {
    await page.waitForFunction(
      () => {
        const b = document.getElementById("erpJournalsBody");
        return !!b && b.querySelectorAll("tr").length > 0 && (b.textContent || "").indexOf("JV-") !== -1;
      },
      { timeout: 20_000 }
    );
  });

  // 03 — Journal detail modal (open a seeded posted journal via erpViewJournal)
  await test.step("03-journal-detail", async () => {
    let status = "ok";
    try {
      const journalId = await page.evaluate(async () => {
        const r = await fetch("/api/erp/gl/journals", {
          headers: { Authorization: "Bearer " + (localStorage.getItem("pos_token") || "") },
        });
        const list = await r.json();
        const j =
          (list || []).find((x: any) => x.referenceType === "STAGECDEMO" && x.status === "posted") ||
          (list || [])[0];
        return j ? j.id : null;
      });
      if (!journalId) throw new Error("no seeded journal found");
      await page.evaluate((id) => (window as any).erpViewJournal(id), journalId);
      await page.waitForFunction(
        () => {
          const m = document.getElementById("erpJournalDetailModal");
          return !!m && !m.classList.contains("hidden");
        },
        { timeout: 15_000 }
      );
    } catch (e: any) {
      status = "degraded: " + String(e && e.message ? e.message.split("\n")[0] : e).slice(0, 140);
    }
    // modal is a fixed overlay → viewport shot (fullPage would scroll past it)
    await shoot(page, project, "03-journal-detail.png", false);
    results.push(`03-journal-detail.png  [${status}]`);
    try {
      await page.evaluate(() => (window as any).erpCloseDetailModal());
    } catch {}
  });

  // 04 — GL ledger report (user must run it: widen dates to cover the seed,
  //      then call erpLoadGLLedgerReport — the «عرض التقرير» button's handler)
  await capture(
    "04",
    "erpGLLedgerReport",
    "04-erpGLLedgerReport.png",
    async () => {
      await page.waitForFunction(
        () => {
          const c = document.getElementById("erpGLLedgerContent");
          if (!c) return false;
          if (c.querySelector(".gl-account-section")) return true; // data rendered
          const t = c.textContent || "";
          return t.length > 0 && !c.querySelector(".fa-spin"); // empty/error state settled
        },
        { timeout: 25_000 }
      );
    },
    {
      pre: async () => {
        await page.evaluate(() => {
          const from = new Date();
          from.setDate(from.getDate() - 70);
          (document.getElementById("erpGLFrom") as HTMLInputElement).value = from.toISOString().slice(0, 10);
          (document.getElementById("erpGLTo") as HTMLInputElement).value = new Date().toISOString().slice(0, 10);
          (window as any).erpLoadGLLedgerReport();
        });
      },
    }
  );

  // helper for the four standard reports (they auto-load on nav; re-run the
  // loader if the container is still in its pristine "press view" state)
  const reportReady = (containerId: string, loaderName: string) => async () => {
    await page.waitForFunction(
      (cid) => {
        const c = document.getElementById(cid);
        return !!c && (c.textContent || "").trim().length > 0 && !c.querySelector(".fa-spin");
      },
      containerId,
      { timeout: 25_000 }
    );
    const pristine = await page.evaluate((cid) => {
      const c = document.getElementById(cid);
      return !!c && (c.textContent || "").indexOf("اضغط") !== -1;
    }, containerId);
    if (pristine) {
      await page.evaluate((fn) => (window as any)[fn](), loaderName);
      await page.waitForFunction(
        (cid) => {
          const c = document.getElementById(cid);
          return !!c && !c.querySelector(".fa-spin");
        },
        containerId,
        { timeout: 25_000 }
      );
    }
  };

  // 05 — Trial balance (anchor: #tbBody rows / tb-empty settled)
  await capture("05", "erpRptTrialBalance", "05-erpRptTrialBalance.png", reportReady("tbBody", "erpLoadTrialBalance"));

  // 06 — Profit & loss (anchor: #plDetails settled)
  await capture("06", "erpRptPnL", "06-erpRptPnL.png", reportReady("plDetails", "erpLoadPnL"));

  // 07 — Balance sheet (loader erpLoadBalanceSheet runs on nav — verified in
  //      erpNav's switch; anchor: #bsDetails settled)
  await capture("07", "erpRptBalanceSheet", "07-erpRptBalanceSheet.png", reportReady("bsDetails", "erpLoadBalanceSheet"));

  // 08 — Cash flow (anchor: #cfDetails settled)
  await capture("08", "erpRptCashFlow", "08-erpRptCashFlow.png", reportReady("cfDetails", "erpLoadCashFlow"));

  // 09 — AR aging. KNOWN-BROKEN today: api-bridge GETs /api/erp/ar-aging but
  // the server serves /api/erp/reports/ar-aging → 404 → the loading row never
  // resolves. Screenshot after ~3s: that IS the honest baseline.
  await capture("09", "erpARAging", "09-erpARAging.png", async () => {
    await page.waitForTimeout(3000);
  });

  // 10 — AP aging (same broken bridge endpoint → same perpetual loading row)
  await capture("10", "erpAPAging", "10-erpAPAging.png", async () => {
    await page.waitForTimeout(3000);
  });

  // 11 — Cost centers. NOTE: on this local DB the GET endpoint 500s
  // (route selects p.name_ar; the local table still has the old name/type
  // schema), so rows may not render even though 6 demo centers are seeded —
  // capture whatever the screen shows after settling.
  await capture("11", "erpCostCenters", "11-erpCostCenters.png", async () => {
    await page
      .waitForFunction(
        () => {
          const b = document.getElementById("erpCCBody");
          return !!b && b.querySelectorAll("tr").length > 0;
        },
        { timeout: 8_000 }
      )
      .catch(() => {});
    await page.waitForTimeout(1500);
  });

  // 12 — Dimensions hub (anchor: generated cards in #dimGrid, spinner gone)
  await capture("12", "erpDimensionsHub", "12-erpDimensionsHub.png", async () => {
    await page.waitForFunction(
      () => {
        const g = document.getElementById("dimGrid");
        return !!g && g.children.length > 0 && !g.querySelector(".fa-spin");
      },
      { timeout: 25_000 }
    );
  });

  console.log(`\n[${project}] captured:\n  ` + results.join("\n  "));
  console.log(`[${project}] console errors: ${consoleErrors.length}`);
  consoleErrors.forEach((e) => console.log(`  [console] ${e}`));
  console.log(`[${project}] failed requests (non-whitelisted): ${failedRequests.length}`);
  failedRequests.forEach((r) => console.log(`  [network] ${r}`));
  // Hard evidence for the verification report — fail the run on real errors.
  expect(consoleErrors, "zero console errors expected").toEqual([]);
  expect(failedRequests, "zero non-whitelisted failed requests expected").toEqual([]);
});
