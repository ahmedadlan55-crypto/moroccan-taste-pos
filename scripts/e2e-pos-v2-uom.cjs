/* Cashier V2 + UoM browser E2E — REAL server + REAL DB + built SPA at /pos-v2.
   Proves the carton-barcode flow in a real browser:
     scan a PIECE barcode → 1 base ; scan a CARTON barcode → shows "1 كرتون"
     (not 12 pieces visually) and deducts 12 base ; scan carton twice → 24 base ;
     change the unit from the cart via a searchable picker ; OFFLINE carton sale
     → reconnect → syncs EXACTLY once (no double deduction). DB-verified base
     deduction + snapshot after each money step + screenshots + zero console errors.
   Run: node scripts/e2e-pos-v2-uom.cjs   (MariaDB on 3307)
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

const PORT = 3997;
const BASE = 'http://127.0.0.1:' + PORT;
const APP = BASE + '/pos-v2';
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'pos-uom');
fs.mkdirSync(OUT, { recursive: true });

const MU = 'M-UOM-E2E'; // imported item: base حبة, carton ×12
const U_CASH = 'pos_uom_e2e';
const BC_BASE = 'UOME2EPCS', BC_CTN = 'UOME2ECTN';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; failures.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 250) : ''); } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;

async function cleanup() {
  for (const [s, p] of [
    ["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE s FROM sales s JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]],
    ["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.username=?", [U_CASH]],
    ["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.username=?", [U_CASH]],
    ['DELETE FROM pos_orders WHERE username=?', [U_CASH]],
    ['DELETE FROM shifts WHERE username=?', [U_CASH]],
    ['DELETE FROM idempotency_keys WHERE username=?', [U_CASH]],
    ['DELETE FROM item_units WHERE item_id=?', [MU]],
    ['DELETE FROM item_barcodes WHERE item_id=?', [MU]],
    ['DELETE FROM menu WHERE id=?', [MU]],
    ['DELETE FROM users WHERE username=?', [U_CASH]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO menu (id,name,price,category,active,tax_category,production_method,stock) VALUES (?,?,?,?,1,'S','imported',1000)", [MU, 'شوكولاتة كرتون E2E', 5, 'حلويات']);
  await db.query("INSERT INTO item_units (id,item_id,unit_name,unit_code,is_base,conversion_to_base,allow_sale) VALUES ('IUE-B',?,'حبة','PCS',1,1,1),('IUE-C',?,'كرتون','CTN',0,12,1)", [MU, MU]);
  await db.query("INSERT INTO item_barcodes (id,item_id,code,code_norm,is_primary,created_by) VALUES ('BCE-B',?,?,?,1,'seed'),('BCE-C',?,?,?,0,'seed')", [MU, BC_BASE, BC_BASE, MU, BC_CTN, BC_CTN]);
  await db.query("UPDATE item_units SET barcode_id='BCE-C' WHERE id='IUE-C'");
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U_CASH, 'disabled', 'cashier']);
  const [r] = await db.query('SELECT id FROM users WHERE username=?', [U_CASH]);
  return r[0].id;
}
async function menuStock() { const [r] = await db.query('SELECT stock FROM menu WHERE id=?', [MU]); return r.length ? Number(r[0].stock) : 0; }
async function salesFor() { const [r] = await db.query("SELECT s.id, s.total_final, s.items_json FROM sales s JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=? ORDER BY s.id", [U_CASH]); return r; }
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode)).on('error', () => z(0)); }); if (r) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function pay(page) {
  await page.getByRole('button', { name: /^دفع/ }).first().click();
  await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
  await page.waitForSelector('text=طلب جديد', { timeout: 30000 });
}
async function scan(page, code) {
  const box = page.getByLabel('بحث في الأصناف أو مسح باركود');
  await box.fill(code);
  await box.press('Enter');
  await page.waitForTimeout(350);
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Cashier V2 + UoM — carton barcode in a real browser ═══\n');
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

    // boot + shift
    console.log('▸ boot + shift');
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=شوكولاتة كرتون E2E', { timeout: 20000 });
    check('catalog renders the multi-unit item', true);
    await page.locator('header').getByRole('button', { name: /فتح وردية/ }).click();
    await page.waitForSelector('header >> text=وردية', { timeout: 15000 });
    await shot('01-boot');

    // 1) scan a PIECE barcode → 1 base unit, no carton hint
    console.log('▸ scan piece barcode');
    await scan(page, BC_BASE);
    let cart = await page.locator('[aria-label="سلة الطلب"]').innerText();
    check('piece scan adds 1 base unit', /شوكولاتة كرتون E2E/.test(cart) && /حبة/.test(cart), cart.slice(0, 200));
    await pay(page);
    let sales = await salesFor();
    check('piece sale deducts 1 base (menu.stock 1000 → 999)', sales.length === 1 && (await menuStock()) === 999, { n: sales.length, stock: await menuStock() });
    check('piece sale total = 5 (1 × base price)', near(sales[0].total_final, 5), sales[0] && sales[0].total_final);
    await page.getByRole('button', { name: 'طلب جديد' }).click(); await page.waitForTimeout(300);

    // 2) scan a CARTON barcode → shows "1 كرتون" (not 12 حبة) + deducts 12 base
    console.log('▸ scan carton barcode');
    await scan(page, BC_CTN);
    cart = await page.locator('[aria-label="سلة الطلب"]').innerText();
    check('carton scan shows «كرتون» visually (qty 1, not 12 pieces)', /كرتون/.test(cart), cart.slice(0, 240));
    check('carton line shows the base equivalent «= 12 حبة»', /12/.test(cart) && /حبة/.test(cart), cart.slice(0, 240));
    check('carton line total = 60 (12 × 5)', /60\.00/.test(cart), cart.slice(-260));
    await shot('02-carton-scanned');
    await pay(page);
    sales = await salesFor();
    check('carton sale deducts 12 base (999 → 987)', sales.length === 2 && (await menuStock()) === 987, { stock: await menuStock() });
    let its = null; try { its = JSON.parse(sales[1].items_json); } catch (_) {}
    check('carton sale items_json: base qty 12 + enteredUnitCode CTN', its && near(its[0].qty, 12) && its[0].enteredUnitCode === 'CTN', its && its[0]);
    check('carton sale total = 60', near(sales[1].total_final, 60), sales[1] && sales[1].total_final);
    await page.getByRole('button', { name: 'طلب جديد' }).click(); await page.waitForTimeout(300);

    // 3) scan carton TWICE → 2 cartons = 24 base
    console.log('▸ two cartons');
    await scan(page, BC_CTN);
    await scan(page, BC_CTN);
    cart = await page.locator('[aria-label="سلة الطلب"]').innerText();
    check('two carton scans merge to qty 2 → 24 base', /24/.test(cart), cart.slice(0, 260));
    await shot('03-two-cartons');
    await pay(page);
    sales = await salesFor();
    check('two-carton sale deducts 24 base (987 → 963)', sales.length === 3 && (await menuStock()) === 963, { stock: await menuStock() });
    await page.getByRole('button', { name: 'طلب جديد' }).click(); await page.waitForTimeout(300);

    // 4) change the unit from the cart (searchable picker): base → carton
    console.log('▸ change unit in cart');
    await scan(page, BC_BASE); // add 1 piece
    // expand the line, open the unit picker, pick "كرتون"
    await page.locator('[aria-label="سلة الطلب"]').getByRole('button', { name: /تفاصيل/ }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'اختيار الوحدة' }).first().click();
    await page.getByRole('option', { name: /كرتون/ }).first().click();
    await page.waitForTimeout(300);
    cart = await page.locator('[aria-label="سلة الطلب"]').innerText();
    check('changing the unit to carton updates the line (= 12 حبة)', /كرتون/.test(cart) && /12/.test(cart), cart.slice(0, 260));
    await shot('04-change-unit');
    await pay(page);
    sales = await salesFor();
    check('unit-changed line sells 12 base (963 → 951)', sales.length === 4 && (await menuStock()) === 951, { stock: await menuStock() });
    await page.getByRole('button', { name: 'طلب جديد' }).click(); await page.waitForTimeout(300);

    // 5) OFFLINE carton sale → reconnect → sync EXACTLY once
    console.log('▸ offline carton → sync once');
    await ctx.setOffline(true);
    await page.waitForTimeout(1200);
    await scan(page, BC_CTN);
    await page.getByRole('button', { name: /^دفع/ }).first().click();
    await page.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await page.waitForTimeout(1500);
    const beforeSync = (await salesFor()).length;
    check('offline: carton sale queued, not posted (still 4 sales)', beforeSync === 4, beforeSync);
    await shot('05-offline-queued');
    await ctx.setOffline(false);
    let synced = false;
    for (let i = 0; i < 25; i++) { await page.waitForTimeout(1000); if ((await salesFor()).length === 5) { synced = true; break; } }
    sales = await salesFor();
    check('reconnect → offline carton synced EXACTLY once (12 base: 951 → 939)', synced && sales.length === 5 && (await menuStock()) === 939, { synced, n: sales.length, stock: await menuStock() });
    check('synced carton sale total = 60', near(sales[4].total_final, 60), sales[4] && sales[4].total_final);
    await shot('06-synced');

    // hygiene
    const errs = consoleErrors.filter((e) => !/favicon|manifest|Failed to fetch|net::ERR|NetworkError|load resource/i.test(e));
    check('zero non-network console errors across the session', errs.length === 0, errs.slice(0, 3));
    console.log(`\nScreenshots: ${OUT}`);
  } catch (e) { fail++; failures.push('FATAL: ' + (e && e.message)); console.error('FATAL', e); } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} pos-v2-uom E2E: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
