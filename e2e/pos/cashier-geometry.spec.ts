/**
 * Geometry regressions the owner hit on his own tablet, measured rather than
 * eyeballed:
 *
 *  1. «الشريط العلوي ياكل العدد» — the in-cart quantity badge sits OUTSIDE its
 *     card (-top-1.5) so it can never change a card's measured height and
 *     disturb the virtualizer. That also means the scroll container clips it on
 *     the FIRST ROW: the count was sliced in half by the search bar above.
 *  2. «ضبط المحاذة في الايقونات» — the three order-type chips share an equal
 *     3-column grid inside a narrow cart panel. With no min-w-0 a flex item
 *     refuses to shrink below its content, so icon + label overflowed the cell
 *     and the icon was sliced down the middle.
 *
 * Both are WIDTH-DEPENDENT, which is why they survived a desktop-only run.
 */
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function signIn(page: import("@playwright/test").Page, lang: "ar" | "en") {
  const env = readEnv();
  const token = jwt.sign(
    { id: 33, username: "seed_manager", role: "manager", name: "Seed Manager", tokenVersion: 1 },
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
}

/** Widths that bracket the owner's tablet and the panel breakpoints. */
const WIDTHS = [1024, 1100, 1280, 1440];

for (const lang of ["ar", "en"] as const) {
  for (const width of WIDTHS) {
    test(`order-type chips do not overflow their cell (${lang}, ${width}px)`, async ({ page }) => {
      await signIn(page, lang);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/pos/");
      await expect(page.getByTestId("pos-header")).toBeVisible({ timeout: 30_000 });

      const chips = page.getByRole("radio");
      await expect(chips.first()).toBeVisible({ timeout: 15_000 });

      const overflow = await chips.evaluateAll((els) =>
        els.map((el) => ({
          text: (el.textContent || "").trim(),
          over: el.scrollWidth - el.clientWidth,
        })),
      );
      for (const chip of overflow) {
        // 1px of tolerance for sub-pixel rounding; anything more is a slice.
        expect(chip.over, `chip "${chip.text}" overflows by ${chip.over}px at ${width}px`).toBeLessThanOrEqual(1);
      }

      // …and the ICON specifically must keep its full 16px box: when something
      // has to give it must be the label, never a glyph squashed to a sliver.
      const iconWidths = await page.getByRole("radio").locator("svg").evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().width)),
      );
      for (const w of iconWidths) expect(w).toBeGreaterThanOrEqual(15);
    });
  }
}

test("the in-cart quantity badge is not clipped by the top of the grid", async ({ page }) => {
  await signIn(page, "en");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/pos/");
  await expect(page.getByTestId("pos-header")).toBeVisible({ timeout: 30_000 });

  // Add the FIRST card — the row where the badge overhangs into the container's
  // top edge and used to be cut.
  const firstCard = page.getByRole("region", { name: /Items|الأصناف/ }).getByRole("button").first();
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
  await firstCard.click();

  const badge = page.getByTestId("card-qty-badge").first();
  await expect(badge).toBeVisible({ timeout: 10_000 });

  const clipped = await badge.evaluate((el) => {
    const scroller = el.closest(".overflow-y-auto");
    if (!scroller) return { badgeTop: 0, scrollerTop: 0, cut: 0 };
    const b = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return { badgeTop: b.top, scrollerTop: s.top, cut: s.top - b.top };
  });
  expect(clipped.cut, "badge is cut off by the scroll container's top edge").toBeLessThanOrEqual(0);
});
