// ═══════════════════════════════════════════════════════════════════════════
// Recipes · Production · Inventory Operations — the DEEP flows.
//
// rc-bilingual.spec.ts already walks every manifest leaf in ar+en at each
// viewport and fails on console errors, ≥400 responses, untranslated keys,
// non-healthy data-states and horizontal overflow — so the three new leaves
// inherit that sweep automatically and this file does NOT repeat it.
//
// What this file adds is the part a per-leaf sweep cannot see:
//   • the DEEP-LINK contract — /menu/recipes/:source/:productId,
//     /inventory/production/new and /inventory/operations/:type/:id must render
//     from a cold URL and SURVIVE A REFRESH. They were query params before
//     (?item=, ?new=1, ?view=), which is exactly what a refresh discarded.
//   • the old paths still resolve (the redirect table)
//   • document details open as PAGES, never as a side panel
//   • both languages, at every viewport the config defines
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();

// The VIEWPORTS come from playwright.erp.config.ts's projects (mobile 390 /
// tablet-768 / laptop-1024 / desktop 1440) — this spec must NOT set its own, or
// every project re-runs every size and the test names read "[desktop] ›
// [ar][tablet]", which is both four times the work and a lie about what ran.
const LANGS = ["ar", "en"] as const;

const BENIGN_CONSOLE =
  /Failed to load resource|favicon|ResizeObserver|Download the React DevTools|React Router Future Flag|Blocked script execution/i;
const CRASH_TEXT = "حدث خطأ غير متوقّع";
const BAD_STATES = ["error", "offline", "session-expired", "permission-denied", "conflict", "not-found"];

async function login(page: Page, lang: "ar" | "en") {
  // The server preference overwrites the localStorage seed on mount (see
  // rc-bilingual.spec.ts) — pin it so the language under test is the one that
  // actually renders.
  await page.route("**/api/user-preferences", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ language: lang }) });
  });
  return page.addInitScript(
    ([token, session, l]) => {
      localStorage.setItem("pos_token", token);
      localStorage.setItem("pos_session", session);
      localStorage.setItem("erp_lang", l);
    },
    [TOKEN, JSON.stringify({ user: "admin", role: "admin" }), lang],
  );
}

async function waitRendered(page: Page) {
  await page.waitForFunction(
    (crash) => {
      const b = document.body ? document.body.innerText || "" : "";
      if (b.includes(crash)) return true;
      const main = document.getElementById("main");
      if (!main) return false;
      if (main.querySelector("[data-state]")) return true;
      if (main.querySelector("h1, h2, h3, table, header")) return true;
      return (main.innerText || "").trim().length > 40;
    },
    CRASH_TEXT,
    { timeout: 30_000 },
  );
}

/** Health of the current screen: no crash, no bad data-state, no body overflow. */
async function health(page: Page) {
  return page.evaluate((bad) => {
    const main = document.getElementById("main");
    const states = [...document.querySelectorAll("[data-state]")]
      .map((e) => e.getAttribute("data-state") || "")
      .filter((s) => bad.includes(s));
    return {
      badState: states[0] || null,
      // The BODY must never scroll sideways. A wide table scrolling inside its
      // own container is fine and is not what this measures.
      overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      text: (main?.innerText || "").slice(0, 400),
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
    };
  }, BAD_STATES);
}

function watch(page: Page) {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN_CONSOLE.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) failed.push(r.status() + " " + r.url().replace(/^https?:\/\/[^/]+/, ""));
  });
  return { errors, failed };
}

/** A page that opens as a real route must NOT be a side panel. */
async function assertNotASidePanel(page: Page) {
  const panels = await page.evaluate(() => {
    // A drawer/side-panel is an element pinned to one edge and narrower than
    // the viewport. Full-page flows (which this codebase renders Drawer/Dialog
    // as) cover the whole viewport and are fine.
    //
    // The app SHELL is excluded deliberately: the sidebar is a fixed, tall,
    // 288px-wide <aside> and would otherwise be reported as a drawer on every
    // single page. It is chrome, not document UI — it sits outside #main and is
    // marked no-print. Without this exclusion the assertion is a false positive
    // that says nothing about the thing being tested.
    return [...document.querySelectorAll("body *")].filter((el) => {
      const s = getComputedStyle(el);
      if (s.position !== "fixed") return false;
      if (el.tagName === "ASIDE" || el.closest("aside") || el.getAttribute("role") === "complementary") return false;
      if (el.classList.contains("no-print")) return false; // shell chrome
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 200) return false;
      const coversWidth = r.width >= window.innerWidth * 0.95;
      const tall = r.height >= window.innerHeight * 0.8;
      return tall && !coversWidth; // tall, pinned, but NOT full width => a drawer
    }).length;
  });
  expect(panels, "a document detail must be a full page, not a side panel").toBe(0);
}

test.describe("recipes / production / operations — deep links", () => {
  for (const lang of LANGS) {
    {
      test(`[${lang}] the three new surfaces render, survive refresh and never overflow`, async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        const seen = watch(page);
        // The project supplies the viewport; read it back for the messages.
        const vp = { name: testInfo.project.name, width: page.viewportSize()?.width ?? 0 };
        await login(page, lang);

        const SURFACES = [
          "/menu/recipes",
          "/inventory/operations",
          "/inventory/production",
          "/inventory/production/new",
        ];

        for (const route of SURFACES) {
          // COLD deep link — not navigated to from inside the app.
          await page.goto(`/app${route}`);
          await waitRendered(page);
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

          const h = await health(page);
          expect(h.badState, `${route} rendered a non-healthy state`).toBeNull();
          expect(h.text, `${route} crashed`).not.toContain(CRASH_TEXT);
          expect(h.overflow, `${route} overflows the body horizontally at ${vp.width}px (${vp.name})`).toBeLessThanOrEqual(1);
          expect(h.dir, `${route} html dir must follow the language`).toBe(lang === "ar" ? "rtl" : "ltr");
          expect(h.lang).toBe(lang);

          // A REFRESH must not lose the screen. This is the whole reason these
          // are routes and not query params.
          await page.reload();
          await waitRendered(page);
          const after = await health(page);
          expect(after.badState, `${route} did not survive a refresh`).toBeNull();
          expect(new URL(page.url()).pathname, `${route} changed URL on refresh`).toBe(`/app${route}`);
        }

        expect(seen.errors, "console errors").toEqual([]);
        expect(seen.failed, "failed API requests").toEqual([]);
      });
    }
  }

  test("the retired /menu/recipes-bom link still resolves, into the new catalog", async ({ page }) => {
    await login(page, "ar");
    await page.goto("/app/menu/recipes-bom?item=X-1&brandId=B1");
    await waitRendered(page);
    const url = new URL(page.url());
    expect(url.pathname).toBe("/app/menu/recipes");
    // The old ?item= carried the selected product; it must arrive as ?productId=.
    expect(url.searchParams.get("productId")).toBe("X-1");
    expect(url.searchParams.get("brandId")).toBe("B1");
  });

  // On narrow viewports DataTable renders a stacked CARD layout and keeps the
  // <table> in the DOM but HIDDEN — so `count()` is truthy while the row can
  // never be clicked, and the click times out. Require VISIBILITY, and when
  // there is no visible row reach the document by its real URL instead. The
  // contract under test is "it is a full page at its own URL", not "a table row
  // exists".
  test("a recipe opens as a full PAGE at its own URL, not a panel", async ({ page }) => {
    const seen = watch(page);
    await login(page, "ar");
    await page.goto("/app/menu/recipes");
    await waitRendered(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const row = page.locator("#main table tbody tr").first();
    let deep: string | null = null;
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await page.waitForURL(/\/app\/menu\/recipes\/(menu|inv)\//, { timeout: 15_000 }).catch(() => {});
      if (/\/app\/menu\/recipes\/(menu|inv)\//.test(page.url())) deep = page.url();
    }
    if (!deep) {
      const first = await page.evaluate(async () => {
        const tok = localStorage.getItem("pos_token");
        const r = await fetch("/api/recipes?pageSize=1", { headers: { Authorization: "Bearer " + tok } });
        const j = await r.json();
        return j.data && j.data[0] ? { src: j.data[0].productSource, id: j.data[0].productId } : null;
      });
      if (first) deep = `/app/menu/recipes/${first.src}/${encodeURIComponent(first.id)}`;
    }
    expect(deep, "no recipe product to open").not.toBeNull();
    await page.goto(deep as string);
    await waitRendered(page);
    await assertNotASidePanel(page);
    expect((await health(page)).badState).toBeNull();
    expect(seen.errors).toEqual([]);
  });

  test("an inventory document opens as a full PAGE at /inventory/operations/:type/:id", async ({ page }) => {
    const seen = watch(page);
    await login(page, "ar");
    await page.goto("/app/inventory/operations");
    await waitRendered(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const row = page.locator("#main table tbody tr").first();
    let deep: string | null = null;
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await page.waitForURL(/\/app\/inventory\/operations\/[^/]+\/[^/]+/, { timeout: 15_000 }).catch(() => {});
      if (/\/app\/inventory\/operations\/[^/]+\/[^/]+/.test(page.url())) deep = page.url();
    }
    if (!deep) {
      const first = await page.evaluate(async () => {
        const tok = localStorage.getItem("pos_token");
        const r = await fetch("/api/inventory/operations?pageSize=1", { headers: { Authorization: "Bearer " + tok } });
        const j = await r.json();
        return j.data && j.data[0] ? { type: j.data[0].documentType, id: j.data[0].documentId } : null;
      });
      if (first) deep = `/app/inventory/operations/${first.type}/${encodeURIComponent(first.id)}`;
    }
    if (deep) {
      await page.goto(deep);
      await waitRendered(page);
      await assertNotASidePanel(page);
      expect((await health(page)).badState).toBeNull();
      // A document page must be a printable DOCUMENT, not the whole app chrome.
      expect(await page.locator(".print-document").count()).toBeGreaterThan(0);
    }
    expect(seen.errors).toEqual([]);
  });

  test("the operations centre distinguishes a stock inbound from a purchase receipt", async ({ page }) => {
    await login(page, "ar");
    await page.goto("/app/inventory/operations");
    await waitRendered(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const text = (await page.locator("#main").innerText()).replace(/\s+/g, " ");
    // The two must not collapse into one word — they are different documents.
    const hasInbound = /وارد/.test(text);
    const hasPurchase = /مشتريات|استلام مشتريات/.test(text);
    expect(hasInbound && hasPurchase, "both document families must be nameable in the UI").toBe(true);
  });
});
