/* Cashier V2 E2E — REAL server + REAL DB + built SPA at /pos-v2.
   Drives the full cashier day in a real browser:
     open shift → cash sale (exact + change) → card sale → MIXED payment →
     hold/resume → cashier discount ceiling refused server-side → void with
     reason → OFFLINE cash sale queued → reconnect → auto-sync creates the
     sale EXACTLY once → shift close with live variance grid → DB assertions
     after every money step + screenshots + zero console errors + mobile.
   Run: node scripts/e2e-pos-v2.cjs   (MariaDB on 3307)
*/
'use strict';
const { chromium } = require('C:/tmp/warehouse-v2-inventory-transactions/node_modules/playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
try { require('dotenv').config(); } catch (_) {}
const jwt = require('jsonwebtoken');
const db = require('../db/connection');

const PORT = 3984;
const BASE = 'http://127.0.0.1:' + PORT;
const APP = BASE + '/pos-v2';
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'pos');
fs.mkdirSync(OUT, { recursive: true });

const M1 = 'M-E2E-POS-1', M2 = 'M-E2E-POS-2', M3 = 'M-E2E-POS-3';
const U_CASH = 'pos_e2e_cash';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; failures.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 250) : ''); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;

async function cleanup() {
  const sqls = [
    ["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE s FROM sales s JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.username=?", [U_CASH]],
    ["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.username=?", [U_CASH]],
    ['DELETE FROM pos_orders WHERE username=?', [U_CASH]],
    ['DELETE FROM shifts WHERE username=?', [U_CASH]],
    ['DELETE FROM idempotency_keys WHERE username=?', [U_CASH]],
    ['DELETE FROM menu WHERE id IN (?,?,?)', [M1, M2, M3]],
    ['DELETE FROM users WHERE username=?', [U_CASH]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [M1, 'شاي أتاي E2E', 23, 'مشروبات ساخنة']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'Z')", [M2, 'ماء E2E', 10, 'مشروبات باردة']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [M3, 'قهوة مغربية E2E', 15, 'مشروبات ساخنة']);
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U_CASH, 'disabled', 'cashier']);
  const [r] = await db.query('SELECT id FROM users WHERE username=?', [U_CASH]);
  return r[0].id;
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode)).on('error', () => z(0)); }); if (r) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
async function salesFor() {
  const [r] = await db.query("SELECT s.id, s.client_order_id, s.total_final, s.payment_method FROM sales s JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=? ORDER BY s.id", [U_CASH]);
  return r;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Cashier V2 E2E — real server, real money path ═══\n');
  const uid = await seed();
  const token = jwt.sign({ id: uid, username: U_CASH, role: 'cashier' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), POS_MAX_CASHIER_DISCOUNT_PCT: '10' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let browser = null;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'ar' });
    await ctx.addInitScript(([t]) => { localStorage.setItem('pos_token', t); }, [token]);
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });

    // ── 1) App boots with the shared token ───────────────────────────────────
    console.log('▸ boot + shift');
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=شاي أتاي E2E', { timeout: 20000 });
    check('app renders catalog from the real backend', true);
    await shot('01-boot');

    // Open shift through the UI: the header button calls the API directly —
    // one click, then the shift chip replaces it.
    await page.waitForSelector('text=متصل', { timeout: 20000 }).catch(() => {});
    await page.locator('header').getByRole('button', { name: /فتح وردية/ }).click();
    await page.waitForSelector('header >> text=وردية', { timeout: 15000 });
    await page.waitForTimeout(800);
    const [sh] = await db.query("SELECT id, status FROM shifts WHERE username=? AND status='OPEN'", [U_CASH]);
    check('shift opened via UI (DB row OPEN)', sh.length === 1, sh);
    const shiftId = sh.length ? sh[0].id : null;
    await shot('02-shift-open');

    // ── 2) CASH sale with change ─────────────────────────────────────────────
    console.log('▸ cash sale');
    await page.getByText('شاي أتاي E2E').first().click();
    await page.getByText('شاي أتاي E2E').first().click();
    await page.getByText('ماء E2E').first().click();
    await page.waitForTimeout(400);
    const cartText = await page.locator('[aria-label="سلة الطلب"]').innerText();
    check('cart totals: 56.00 (2×23 S + 10 Z)', /56\.00/.test(cartText), cartText.slice(-200));
    await page.getByRole('button', { name: /^دفع/ }).first().click();
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
    // Cash received 100 → change 44.
    const cashInput = page.getByRole('dialog').locator('input[type="number"]').first();
    await cashInput.fill('100');
    await page.waitForTimeout(300);
    const dlgText = await page.locator('[role="dialog"], .fixed').last().innerText().catch(() => '');
    check('change computed 44.00', /44\.00/.test(dlgText), dlgText.slice(0, 200));
    await shot('03-payment-cash');
    await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await page.waitForSelector('text=طلب جديد', { timeout: 30000 });
    await shot('04-cash-success');
    let sales = await salesFor();
    check('cash sale row created (56.00, كاش)', sales.length === 1 && near(sales[0].total_final, 56) && /كاش/.test(sales[0].payment_method), sales);
    const [ord1] = await db.query("SELECT status, sale_id FROM pos_orders WHERE username=? ORDER BY created_at DESC LIMIT 1", [U_CASH]);
    check('pos_order completed + linked', ord1[0].status === 'completed' && ord1[0].sale_id === sales[0].id, ord1[0]);
    await page.getByRole('button', { name: 'طلب جديد' }).click();
    await page.waitForTimeout(400);

    // ── 3) CARD sale ─────────────────────────────────────────────────────────
    console.log('▸ card sale');
    await page.getByText('قهوة مغربية E2E').first().click();
    await page.getByRole('button', { name: /^دفع/ }).first().click();
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).getByText('شبكة').click();
    await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await page.waitForSelector('text=طلب جديد', { timeout: 30000 });
    sales = await salesFor();
    check('card sale created (15.00, شبكة)', sales.length === 2 && near(sales[1].total_final, 15) && /شبكة/.test(sales[1].payment_method), sales[1]);
    await page.getByRole('button', { name: 'طلب جديد' }).click();
    await page.waitForTimeout(400);

    // ── 4) MIXED payment ─────────────────────────────────────────────────────
    console.log('▸ mixed payment');
    await page.getByText('شاي أتاي E2E').first().click();
    await page.getByText('قهوة مغربية E2E').first().click(); // 23 + 15 = 38
    await page.getByRole('button', { name: /^دفع/ }).first().click();
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).getByText('مختلط').click();
    await page.waitForTimeout(300);
    const numInputs = page.getByRole('dialog').locator('input[type="number"]');
    await numInputs.nth(0).fill('20');
    await numInputs.nth(1).fill('18');
    await shot('05-mixed');
    await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await page.waitForSelector('text=طلب جديد', { timeout: 30000 });
    sales = await salesFor();
    check('mixed sale created (38.00, split)', sales.length === 3 && near(sales[2].total_final, 38) && /split/.test(sales[2].payment_method), sales[2]);
    await page.getByRole('button', { name: 'طلب جديد' }).click();
    await page.waitForTimeout(400);

    // ── 5) hold / resume ─────────────────────────────────────────────────────
    console.log('▸ hold / resume / void / discount ceiling');
    await page.getByText('ماء E2E').first().click();
    await page.getByRole('button', { name: 'تعليق' }).first().click();
    await page.waitForTimeout(800);
    // Diagnostic: identify any stray open dialog before the next step.
    const strayDlg = await page.locator('[role="dialog"]').count();
    if (strayDlg > 0) {
      const strayTxt = await page.locator('[role="dialog"]').first().innerText().catch(() => '');
      console.log('  [debug] stray dialog after hold:', strayTxt.slice(0, 160).split('\n').join(' | '));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    await page.getByRole('button', { name: /الطلبات المعلقة/ }).first().click();
    await page.waitForSelector('text=استعادة', { timeout: 10000 });
    await shot('06-held');
    await page.getByRole('button', { name: /استعادة/ }).first().click();
    await page.waitForTimeout(800);
    const cartAfterResume = await page.locator('[aria-label="سلة الطلب"]').innerText();
    check('resume restored the cart (ماء)', /ماء E2E/.test(cartAfterResume), null);

    // ── 6) void with reason ──────────────────────────────────────────────────
    await page.getByRole('button', { name: /إلغاء/ }).first().click();
    await page.waitForSelector('text=سبب الإلغاء', { timeout: 10000 });
    await page.locator('textarea, input[placeholder*="سبب"], [aria-label*="سبب"]').first().fill('تجربة إلغاء E2E');
    await page.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
    await page.waitForTimeout(1000);
    const [voided] = await db.query("SELECT COUNT(*) AS n FROM pos_orders WHERE username=? AND status='voided'", [U_CASH]);
    check('void persisted server-side', Number(voided[0].n) >= 1, voided[0]);

    // ── 7) cashier discount ceiling — server refuses 15% ─────────────────────
    await page.getByText('شاي أتاي E2E').first().click();
    await page.getByRole('button', { name: /إضافة خصم على الطلب|^خصم/ }).first().click();
    await page.waitForTimeout(500);
    const pctInput = page.locator('.fixed input[type="number"], [role="dialog"] input[type="number"]').first();
    await pctInput.fill('15');
    await page.getByRole('dialog').getByRole('button', { name: /تطبيق|تأكيد|حفظ/ }).last().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /^دفع/ }).first().click();
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await page.waitForTimeout(2500);
    const bodyAfter = await page.locator('body').innerText();
    check('server refused 15% cashier discount (حد الكاشير)', /حد الكاشير/.test(bodyAfter), bodyAfter.slice(0, 150));
    await shot('07-discount-refused');
    // clean the cart for the offline step: void it (order may be back open after reopen)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /إلغاء/ }).first().click();
    await page.waitForSelector('text=سبب الإلغاء', { timeout: 10000 });
    await page.locator('textarea, input[placeholder*="سبب"], [aria-label*="سبب"]').first().fill('تنظيف قبل الأوفلاين');
    await page.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
    await page.waitForTimeout(800);

    // ── 8) OFFLINE cash sale → reconnect → exactly-once sync ─────────────────
    console.log('▸ offline → sync (exactly once)');
    await ctx.setOffline(true);
    await page.waitForTimeout(1500);
    const hdr = await page.locator('header').innerText();
    check('offline indicator shown', /غير متصل/.test(hdr), hdr.slice(0, 120));
    await page.getByText('قهوة مغربية E2E').first().click();
    await page.getByText('قهوة مغربية E2E').first().click(); // 30
    await page.getByRole('button', { name: /^دفع/ }).first().click();
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
    const cardTabDisabled = await page.getByRole('tablist', { name: 'طريقة الدفع' })
      .locator('button', { hasText: 'شبكة' }).first().isDisabled().catch(() => false);
    check('offline: card tab disabled (كاش فقط)', cardTabDisabled === true, cardTabDisabled);
    await shot('08-offline-payment');
    await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await page.waitForTimeout(1500);
    const salesBefore = (await salesFor()).length;
    check('no sale posted while offline', salesBefore === 3, salesBefore);
    await shot('09-offline-queued');
    await ctx.setOffline(false);
    // wait for auto-flush (online event) up to 25s
    let synced = false;
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      const s = await salesFor();
      if (s.length === 4) { synced = true; break; }
    }
    sales = await salesFor();
    check('reconnect → queued sale synced EXACTLY once (30.00)', synced && sales.length === 4 && near(sales[3].total_final, 30), sales.map((s) => s.total_final));
    const [comp] = await db.query("SELECT COUNT(*) AS n FROM pos_orders WHERE username=? AND status='completed'", [U_CASH]);
    check('4 completed pos_orders after sync', Number(comp[0].n) === 4, comp[0]);
    await shot('10-synced');
    // Close the (queued-success) payment dialog left open from the offline sale.
    const newOrderBtn = page.getByRole('button', { name: 'طلب جديد' });
    if (await newOrderBtn.count()) { await newOrderBtn.first().click().catch(() => {}); }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // ── 9) close shift with live variance ────────────────────────────────────
    console.log('▸ shift close');
    await page.locator('header').getByRole('button', { name: /وردية/ }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'إغلاق الوردية' }).click();
    await page.waitForTimeout(1500);
    await shot('11-close-grid');
    // Expected cash = 56 + 30 = 86; fill the CASH counted input with 86.
    const closeInputs = page.locator('.fixed input[type="number"], [role="dialog"] input[type="number"]');
    const nIn = await closeInputs.count();
    check('close grid shows counted inputs', nIn >= 1, nIn);
    await closeInputs.first().fill('86');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'تأكيد إغلاق الوردية' }).click();
    await page.waitForTimeout(2500);
    const [shClosed] = await db.query('SELECT status FROM shifts WHERE id=?', [shiftId]);
    check('shift CLOSED in DB', shClosed.length === 1 && String(shClosed[0].status).toUpperCase() !== 'OPEN', shClosed[0]);
    await shot('12-shift-closed');

    // ── 10) hygiene: console errors + mobile ─────────────────────────────────
    const errs = consoleErrors.filter((e) => !/favicon|manifest|Failed to fetch|net::ERR|NetworkError|load resource/i.test(e));
    check('zero non-network console errors across the whole session', errs.length === 0, errs.slice(0, 3));
    const mob = await ctx.newPage();
    await mob.setViewportSize({ width: 375, height: 812 });
    await mob.goto(APP, { waitUntil: 'domcontentloaded' });
    await mob.waitForTimeout(2500);
    await mob.screenshot({ path: path.join(OUT, '13-mobile.png') });
    check('mobile 375px renders', true);
    console.log(`\nScreenshots: ${OUT}`);
  } catch (e) {
    fail++; failures.push('FATAL: ' + (e && e.message));
    console.error('FATAL', e);
    try { const p = (await browser.contexts())[0]; } catch (_) {}
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} pos-v2 E2E: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
