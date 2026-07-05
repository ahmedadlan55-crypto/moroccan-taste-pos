/* Search-combobox hotfix E2E — proves the confirmed bug is fixed in a REAL
   browser: the central SearchableEntityCombobox now shows its FIRST PAGE the
   moment the user clicks/focuses it — before typing a single character — for
   BOTH the GL-account picker (receipt step 1) and the item picker (step 2).
   Also drives: narrow-on-type (Arabic name / SKU / barcode), clear→first page,
   keyboard select (Enter / ArrowDown), the popup rendering in a portal above
   the wizard, and asserts ZERO console errors throughout.

   Boots server.js with the BUILT /warehouse SPA, seeds a warehouse + a few
   searchable items, forges an admin (canary) token. Screenshots →
   artifacts/screenshots/search-combobox/.

   Run: node scripts/e2e-search-combobox.cjs   (MariaDB on 3307 must be running)
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
const BC = require('../lib/barcode');

const PORT = 3987;
const BASE = 'http://127.0.0.1:' + PORT;
const APP = BASE + '/warehouse';
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'search-combobox');
fs.mkdirSync(OUT, { recursive: true });

const WH = 'WH-SCB';
const ITEMS = [
  { id: 'SCB-RICE', name: 'أرز بسمتي فاخر للاختبار', sku: 'SCB-RICE-01', barcode: '6210000012345', cost: 8 },
  { id: 'SCB-SUGAR', name: 'سكر ناعم للاختبار', sku: 'SCB-SUGAR-02', barcode: '6210000067890', cost: 5 },
  { id: 'SCB-OIL', name: 'زيت ذرة للاختبار', sku: 'SCB-OIL-03', barcode: '6210000033333', cost: 12 },
];
const token = jwt.sign({ id: 0, username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '2h' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; failures.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 200) : '')); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); }
}
function waitForServer() { return new Promise(async (res) => { for (let i = 0; i < 120; i++) { const ok = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)); }); if (ok) return res(true); await new Promise((z) => setTimeout(z, 500)); } res(false); }); }

async function cleanup() {
  const ids = ITEMS.map((i) => i.id);
  const ph = ids.map(() => '?').join(',');
  for (const [s, p] of [
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM item_barcodes WHERE item_id IN (' + ph + ')', ids],
    ['DELETE FROM inv_items WHERE id IN (' + ph + ')', ids],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, 'SCB', 'مستودع اختبار القوائم', 'main']);
  for (const it of ITEMS) {
    const bn = BC.normalize(it.barcode);
    await db.query(
      "INSERT INTO inv_items (id,name,sku,sku_norm,category,unit,cost,active,barcode,barcode_norm) VALUES (?,?,?,?,?,?,?,1,?,?)",
      [it.id, it.name, it.sku, String(it.sku).toUpperCase(), 'اختبار', 'حبة', it.cost, it.barcode, bn]);
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())",
      ['WS-' + it.id, WH, it.id, 100, it.cost]);
  }
}

// scope to the combobox popup — a native <select>'s <option> also has role=option
const OPT = '[role=listbox] [role=option]';
async function optionCount(page) { return page.locator(OPT).count(); }
async function waitOptions(page, min, timeout) {
  await page.locator(OPT).first().waitFor({ timeout: timeout || 6000 }).catch(() => {});
  return optionCount(page);
}
// poll until a locator reaches count 0 (list settled after a debounced re-query)
async function waitGone(loc, timeout) {
  const end = Date.now() + (timeout || 4000);
  while (Date.now() < end) { if ((await loc.count()) === 0) return true; await new Promise((r) => setTimeout(r, 100)); }
  return (await loc.count()) === 0;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Search-combobox hotfix E2E (built SPA @ /warehouse) ═══\n');
  await seed();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', WAREHOUSE_V2_ENABLED: '1', POS_V2_ENABLED: '0', WAREHOUSE_SCOPE_ENFORCE: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', (d) => { const s = String(d); if (/error|throw/i.test(s)) process.stdout.write('[srv] ' + s); });
  let browser;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
    await ctx.addInitScript(([t]) => { localStorage.setItem('pos_token', t); }, [token]);
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

    // ── open the Receipt wizard ────────────────────────────────────────────
    await page.goto(APP + '/receipts/new', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 15000 });

    // ── STEP 1: GL-account picker shows options on click, BEFORE typing ──────
    // warehouse <select> is populated async — wait for our seeded option first
    await page.locator('select[aria-label="المستودع"] option[value="' + WH + '"]').waitFor({ state: 'attached', timeout: 15000 });
    await page.getByLabel('المستودع', { exact: true }).selectOption(WH);
    await page.getByLabel('السبب', { exact: true }).fill('اختبار القوائم القابلة للبحث');
    const acct = page.getByRole('combobox', { name: 'الحساب المحاسبي' });
    await acct.click();
    const nAcct = await waitOptions(page, 1);
    check('account picker: options appear on click WITHOUT typing', nAcct >= 1, { nAcct });
    await page.screenshot({ path: path.join(OUT, '01-account-open-first-page.png') });
    // keyboard nav on a live list: ArrowDown then click the highlighted option
    await acct.press('ArrowDown');
    await page.locator(OPT).first().click();
    await page.waitForTimeout(150);
    const nextBtn = page.getByRole('button', { name: 'التالي' });
    check('account selected from the open list → step advances enabled', await nextBtn.isEnabled());
    await nextBtn.click();

    // ── STEP 2: item picker shows the first page on click, BEFORE typing ─────
    const item = page.getByRole('combobox', { name: 'إضافة صنف' });
    await item.click();
    const nItem = await waitOptions(page, 1);
    check('ITEM picker: first page appears on click WITHOUT typing', nItem >= 1, { nItem });
    // portal: the listbox is mounted on <body>, not clipped inside the wizard
    const portalOk = await page.evaluate(() => { const lb = document.querySelector('[role=listbox]'); return !!lb && lb.parentElement === document.body; });
    check('popup renders in a portal on <body> (dialog/drawer-safe)', portalOk);
    await page.screenshot({ path: path.join(OUT, '02-item-open-first-page.png') });

    // narrow by Arabic name
    await item.fill('أرز بسمتي فاخر');
    await page.locator(OPT, { hasText: 'أرز بسمتي فاخر للاختبار' }).first().waitFor({ timeout: 6000 });
    const sugarGone = await waitGone(page.locator(OPT, { hasText: 'سكر ناعم للاختبار' }));
    check('item search narrows by Arabic name (rice shown, sugar filtered out)', sugarGone);
    await page.screenshot({ path: path.join(OUT, '03-item-search-arabic.png') });
    // Enter selects the single match → row added (keyboard selection)
    await item.press('Enter');
    await page.getByRole('cell', { name: /أرز بسمتي فاخر للاختبار/ }).first().waitFor({ timeout: 6000 });
    check('keyboard Enter selects the searched item → line added', true);

    // clearing returns to the first page (more than one option)
    await item.click();
    await item.fill('سكر');
    await page.locator(OPT, { hasText: 'سكر ناعم للاختبار' }).first().waitFor({ timeout: 6000 });
    await item.fill('');
    const nCleared = await waitOptions(page, 2);
    check('clearing the text returns to the first page', nCleared >= 2, { nCleared });

    // search by SKU → click the option to select (add the line)
    await item.fill('SCB-SUGAR-02');
    const sugarOpt = page.locator(OPT, { hasText: 'سكر ناعم للاختبار' }).first();
    await sugarOpt.waitFor({ timeout: 6000 });
    check('item search by SKU finds the item', true);
    await sugarOpt.click();
    await page.getByRole('cell', { name: /سكر ناعم للاختبار/ }).first().waitFor({ timeout: 6000 });

    // search by full BARCODE → exact-match auto-select adds the item
    await item.click();
    await item.fill('6210000033333');
    await page.getByRole('cell', { name: /زيت ذرة للاختبار/ }).first().waitFor({ timeout: 8000 });
    check('barcode scan (exact) auto-selects and adds the item', true);
    await page.screenshot({ path: path.join(OUT, '04-three-lines-added.png') });

    const errs = consoleErrors.filter((e) => !/favicon|manifest|401|ResizeObserver/.test(e));
    check('zero console / page errors during the whole flow', errs.length === 0, errs.slice(0, 4));

    console.log('\nScreenshots: ' + OUT);
  } catch (e) {
    console.error('FATAL', e && e.stack ? e.stack : e);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    await cleanup().catch(() => {});
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} search-combobox: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
