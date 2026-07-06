import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const TOKEN = fs.readFileSync(path.join(process.cwd(), "e2e", ".token"), "utf8").trim();
const SHOT = (name: string) => path.join("artifacts", "e2e", "dormant", `${name}.png`);

async function authed(page: Page) {
  await page.addInitScript((tok) => { try { localStorage.setItem("pos_token", tok as string); } catch { /* ignore */ } }, TOKEN);
}

test.describe("Dormant cutover (flag OFF)", () => {
  test("flag is OFF and /api/procurement is not mounted (not writable)", async ({ request }) => {
    const ver = await (await request.get("/api/version")).json();
    expect(ver.procurementP2P, "procurementP2P flag").toBe(false);

    // reads: not mounted → not 200 (404/handled), and definitely not a procurement payload
    const dash = await request.get("/api/procurement/dashboard", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(dash.status(), "GET /api/procurement/dashboard").not.toBe(200);
    // writes: not mounted → not 2xx, and NOT the 409 gate (gate only exists when ON)
    const create = await request.post("/api/procurement/orders", { headers: { Authorization: `Bearer ${TOKEN}` }, data: { supplierId: "x", lines: [] } });
    expect(create.status(), "POST /api/procurement/orders").toBeGreaterThanOrEqual(400);
    expect(create.status(), "must not be the flag-ON 409 gate").not.toBe(409);
  });

  test("legacy purchasing API still works (gate inactive when OFF)", async ({ request }) => {
    const list = await request.get("/api/purchases", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(list.status(), "GET /api/purchases").toBe(200);
    // a legacy mutation is NOT gated (no 409) when the flag is OFF
    const post = await request.post("/api/purchases", { headers: { Authorization: `Bearer ${TOKEN}` }, data: {} });
    expect(post.status(), "legacy POST /api/purchases not gated").not.toBe(409);
  });

  test("procurement UI is hidden in the warehouse shell", async ({ page }) => {
    await authed(page);
    await page.goto("/warehouse");
    // wait for the shell sidebar to render, then assert the procurement entry is absent
    const nav = page.getByLabel("التنقل الرئيسي");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "المستودعات والهيكل" })).toBeVisible(); // a known nav item
    await expect(nav.getByRole("link", { name: "المشتريات والموردون" })).toHaveCount(0);
    await page.screenshot({ path: SHOT("01-shell-no-procurement-nav"), fullPage: true });

    // deep-linking /purchasing shows the "not enabled" notice, never a broken section
    await page.goto("/warehouse/purchasing");
    await expect(page.getByText("وحدة المشتريات والموردون غير مفعّلة")).toBeVisible();
    await page.screenshot({ path: SHOT("02-purchasing-dormant-notice"), fullPage: true });
  });
});
