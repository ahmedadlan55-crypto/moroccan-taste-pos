import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";

/* eslint-disable @typescript-eslint/no-var-requires */
const jwt = require("jsonwebtoken");

function readEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

// Same assertion logic as before, now parameterized across pos_lang (ar/en)
// so it runs once per language at every existing viewport project — the
// overflow/overlap/44px-touch-target checks themselves are UNCHANGED, just
// looped. Quick-action + more-menu label text is read from the exact strings
// the merged i18n barrels render (frontend/pos/src/i18n/dictionaries/{ar,en}
// /header.ts) so this test fails loudly if either dictionary's copy drifts
// from what Header.tsx actually shows.
const LABELS: Record<"ar" | "en", { quick: string[]; more: string; backToSystem: string }> = {
  ar: { quick: ["فواتيري", "جرد المخزون", "طلب النواقص", "المزيد"], more: "المزيد", backToSystem: "العودة للنظام الرئيسي" },
  en: { quick: ["My invoices", "Stocktake", "Requisitions", "More"], more: "More", backToSystem: "Back to main system" },
};

for (const lang of ["ar", "en"] as const) {
  test(`cashier header stays labelled, contained and touch-safe (${lang})`, async ({ page }) => {
    const env = readEnv();
    const token = jwt.sign(
      { id: 1, username: "admin", role: "admin", name: "المدير", tokenVersion: 1 },
      env.JWT_SECRET,
      { expiresIn: "30m" },
    );
    await page.addInitScript(
      ({ tok, l }) => {
        localStorage.setItem("pos_token", tok);
        localStorage.setItem("pos_lang", l);
      },
      { tok: token, l: lang },
    );
    await page.goto("/pos/");

    const header = page.getByTestId("pos-header");
    await expect(header).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("cashier-identity")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");

    const quick = page.getByTestId("pos-quick-actions");
    for (const label of LABELS[lang].quick) {
      await expect(quick.getByText(label, { exact: true })).toBeVisible();
    }

    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const headerEl = document.querySelector<HTMLElement>('[data-testid="pos-header"]');
      const actions = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="pos-quick-actions"] > button, [data-testid="pos-quick-actions"] > details > summary'),
      ).map((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      const overlaps = actions.some((a, index) => actions.slice(index + 1).some((b) =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
      ));
      return {
        overflow: root.scrollWidth - root.clientWidth,
        headerBottom: headerEl?.getBoundingClientRect().bottom ?? 0,
        viewportHeight: window.innerHeight,
        actions,
        overlaps,
      };
    });

    expect(metrics.overflow, "no horizontal page overflow").toBeLessThanOrEqual(1);
    expect(metrics.overlaps, "quick actions must not overlap").toBe(false);
    expect(metrics.headerBottom, "header must not consume most of the till").toBeLessThan(metrics.viewportHeight * 0.45);
    for (const action of metrics.actions) {
      expect(action.width, "touch action width").toBeGreaterThanOrEqual(44);
      expect(action.height, "touch action height").toBeGreaterThanOrEqual(44);
    }

    await quick.getByText(LABELS[lang].more, { exact: true }).click();
    await expect(page.getByRole("link", { name: LABELS[lang].backToSystem })).toBeVisible();
    const menuContained = await page.getByRole("link", { name: LABELS[lang].backToSystem }).evaluate((link) => {
      const menu = link.closest("div");
      if (!menu) return false;
      const rect = menu.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth + 1;
    });
    expect(menuContained, "more menu must stay inside the viewport").toBe(true);
  });
}
