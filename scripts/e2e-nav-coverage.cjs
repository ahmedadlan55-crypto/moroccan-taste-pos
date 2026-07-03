/* Navigation coverage E2E — warehouse completion gate.
   Boots server.js with the BUILT SPA at /warehouse, seeds realistic data
   (tracked+untracked items, lots, a BOM, an open purchase, a legacy production
   order), then opens EVERY navigation page + every wizard and asserts:
     • no console errors / page errors,
     • no placeholder text ("قيد الإنشاء") and no 404 shell,
     • the PageHeader H1 actually rendered (not a blank screen),
     • Arabic-Indic digits ٠-٩ never appear (English-digits policy),
   and captures a screenshot per page into artifacts/screenshots/nav/.
   Then drives the PRODUCTION workflow: create the order through the REAL
   wizard UI (click-through), then approve→issue→output→complete→close via the
   API with UI verification + screenshots of the detail tabs at each stage,
   plus the mobile viewport and the /warehouse-v2 → /warehouse redirect.

   Run: node scripts/e2e-nav-coverage.cjs   (MariaDB on 3307 must be running)
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

const PORT = 3986;
const BASE = 'http://127.0.0.1:' + PORT;
const APP = BASE + '/warehouse';
const OUT = path.join(__dirname, '..', 'artifacts', 'screenshots', 'nav');
fs.mkdirSync(OUT, { recursive: true });

const WH = 'WH-NAV-A', WHB = 'WH-NAV-B';
const RAW1 = 'NAV-RAW1', RAW2 = 'NAV-RAW2', FG = 'NAV-FG';
const BOM = 'BOM-NAV-1', PUR = 'PUR-NAV-1';
const token = jwt.sign({ id: 0, username: 'admin', role: 'admin', isDeveloper: true }, process.env.JWT_SECRET, { expiresIn: '2h' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; failures.push(name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 200) : '')); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 200) : ''); }
}

function api(method, p, body, extraHeaders) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + token, 'Idempotency-Key': 'nav-' + Math.random().toString(36).slice(2) }, extraHeaders || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => { let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j }); }); });
    r.on('error', () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await new Promise((z) => { http.get(BASE + '/api/version', (s) => z(s.statusCode)).on('error', () => z(0)); }); if (r) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }

async function cleanup() {
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN production_orders po ON po.id=e.doc_id WHERE e.doc_type='production' AND po.warehouse_id=?", [WH]],
    ['DELETE pil FROM production_issue_lines pil JOIN production_orders po ON po.id=pil.production_order_id WHERE po.warehouse_id=?', [WH]],
    ['DELETE pie FROM production_issue_events pie JOIN production_orders po ON po.id=pie.production_order_id WHERE po.warehouse_id=?', [WH]],
    ['DELETE pout FROM production_output pout JOIN production_orders po ON po.id=pout.production_order_id WHERE po.warehouse_id=?', [WH]],
    ['DELETE pc FROM production_consumption pc JOIN production_orders po ON po.id=pc.production_order_id WHERE po.warehouse_id=?', [WH]],
    ['DELETE wolc FROM work_order_lot_consumption wolc JOIN production_orders po ON po.id=wolc.work_order_id WHERE po.warehouse_id=?', [WH]],
    ['DELETE FROM production_orders WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_movements WHERE warehouse_id IN (?,?)', [WH, WHB]],
    ['DELETE FROM inventory_lot_movements WHERE warehouse_id IN (?,?)', [WH, WHB]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id IN (?,?)', [WH, WHB]],
    ['DELETE FROM inventory_lots WHERE item_id IN (?,?,?)', [RAW1, RAW2, FG]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id IN (?,?)', [WH, WHB]],
    ['DELETE FROM purchases WHERE id=?', [PUR]],
    ['DELETE FROM bom_lines WHERE bom_id=?', [BOM]],
    ['DELETE FROM bom WHERE id=?', [BOM]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?)', [RAW1, RAW2, FG]],
    ['DELETE FROM warehouses WHERE id IN (?,?)', [WH, WHB]],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id WHERE j.reference_type LIKE 'prod\\_%'", []],
    ["DELETE FROM gl_journals WHERE reference_type LIKE 'prod\\_%'", []],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)", [WH, 'NAVA', 'مستودع التغطية الرئيسي', 'main']);
  await db.query("INSERT INTO warehouses (id,code,name,type,is_active) VALUES (?,?,?,?,1)", [WHB, 'NAVB', 'مستودع الإخراج', 'branch']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,4,1)", [RAW1, 'دقيق التغطية', 'خام', 'كجم']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,tracking_mode) VALUES (?,?,?,?,6,1,'expiry')", [RAW2, 'زبدة متتبعة', 'خام', 'كجم']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active,tracking_mode,kind) VALUES (?,?,?,?,0,1,'lot','semi')", [FG, 'معجنات التغطية', 'إنتاج', 'حبة']);
  await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES ('WS-NAV1',?,?,100,4,NOW()),('WS-NAV2',?,?,50,6,NOW())", [WH, RAW1, WH, RAW2]);
  const L = require('../lib/lotLedger');
  await L.openingLot(db, { warehouseId: WH, itemId: RAW2, qty: 30, lotNumber: 'NAV-L1', expiryDate: '2026-11-01', unitCost: 6, actor: 'seed', occurredAt: new Date() });
  await L.openingLot(db, { warehouseId: WH, itemId: RAW2, qty: 20, lotNumber: 'NAV-L2', expiryDate: '2027-03-01', unitCost: 6, actor: 'seed', occurredAt: new Date() });
  await db.query("INSERT INTO bom (id,product_id,version,yield_quantity,yield_unit,is_active,product_source) VALUES (?,?,1,10,'PCS',1,'inv')", [BOM, FG]);
  await db.query("INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct) VALUES ('BLN-1',?,?,2,'كجم',0),('BLN-2',?,?,1,'كجم',0)", [BOM, RAW1, BOM, RAW2]);
  await db.query("INSERT INTO purchases (id, purchase_date, supplier_name, status, items_json, total_price, warehouse_id) VALUES (?,NOW(),'مورد التغطية','draft',?,410,?)",
    [PUR, JSON.stringify([{ itemId: RAW1, name: 'دقيق التغطية', qty: 40, unitPrice: 4 }, { itemId: RAW2, name: 'زبدة متتبعة', qty: 25, unitPrice: 6 }]), WH]);
  // A legacy production order so the list shows the read-only badge.
  await db.query("INSERT INTO production_orders (id, order_number, bom_id, product_id, warehouse_id, output_warehouse_id, qty_planned, status, source, created_by) VALUES ('PO-NAV-LEG','PRD-NAV-LEG',?,?,?,?,10,'planned','legacy','legacy_user')", [BOM, FG, WH, WHB]);
}

const AR_DIGITS = /[٠١٢٣٤٥٦٧٨٩]/;

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Navigation coverage E2E (built SPA @ /warehouse) ═══\n');
  await seed();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '1', INV_MAKER_CHECKER: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let browser = null;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
    await ctx.addInitScript(([t]) => { localStorage.setItem('pos_token', t); }, [token]);
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

    async function visit(name, urlPath, expectH1) {
      consoleErrors.length = 0;
      await page.goto(APP + urlPath, { waitUntil: 'domcontentloaded' });
      try { await page.waitForSelector('h1', { timeout: 15000 }); } catch (_) {}
      await page.waitForTimeout(1200); // let queries settle
      const h1 = await page.locator('h1').first().textContent().catch(() => '');
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const errs = consoleErrors.filter((e) => !/favicon|manifest|401/.test(e));
      check(`${name}: renders (h1="${(h1 || '').trim().slice(0, 30)}")`, !!(h1 || '').trim(), { path: urlPath });
      if (expectH1) check(`${name}: h1 matches`, (h1 || '').includes(expectH1), h1);
      check(`${name}: no console errors`, errs.length === 0, errs.slice(0, 3));
      check(`${name}: no placeholder/404`, !bodyText.includes('قيد الإنشاء') && !bodyText.includes('الصفحة غير موجودة'), null);
      const digitHit = (bodyText.match(AR_DIGITS) || [])[0];
      check(`${name}: English digits only`, !digitHit, digitHit);
      await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
    }

    // ── 1) Every navigation destination ─────────────────────────────────────
    console.log('▸ pages');
    await visit('01-dashboard', '/', 'مركز');
    await visit('02-warehouses', '/warehouses');
    await visit('03-inventory', '/inventory');
    await visit('04-items', '/items');
    await visit('05-replenishment', '/replenishment');
    await visit('06-lots', '/lots');
    await visit('07-expiry', '/expiry');
    await visit('08-receipts', '/receipts');
    await visit('09-purchase-receiving', '/purchase-receiving', 'استلام المشتريات');
    await visit('10-issues', '/issues');
    await visit('11-transfers', '/transfers');
    await visit('12-stocktakes', '/stocktakes');
    await visit('13-adjustments', '/adjustments');
    await visit('14-production', '/production', 'أوامر الإنتاج');
    await visit('15-analytics', '/analytics');
    await visit('16-reports', '/reports');
    await visit('17-deficits', '/deficits', 'العجوزات');
    await visit('18-negative-policy', '/negative-policy');
    console.log('▸ wizards');
    await visit('20-production-new', '/production/new', 'أمر إنتاج جديد');
    await visit('21-receipts-new', '/receipts/new');
    await visit('22-issues-new', '/issues/new');
    await visit('23-adjustments-new', '/adjustments/new');
    await visit('24-transfers-new', '/transfers/new');
    await visit('25-stocktakes-new', '/stocktakes/new');
    await visit('26-items-new', '/items/new');
    await visit('27-purchase-receive-wizard', '/purchase-receiving/' + PUR, 'استلام ' + PUR);

    // system-map must be GONE (removed page → NotFound shell, not a placeholder)
    await page.goto(APP + '/system-map', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const smText = await page.locator('body').innerText().catch(() => '');
    check('system-map removed → NotFound', smText.includes('الصفحة غير موجودة'), null);

    // ── 2) /warehouse-v2 → /warehouse redirect in the real browser ─────────
    await page.goto(BASE + '/warehouse-v2/production', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    check('redirect: /warehouse-v2/production lands on /warehouse/production', page.url().includes('/warehouse/production') && !page.url().includes('warehouse-v2'), page.url());

    // ── 3) Production workflow — wizard click-through, then full lifecycle ──
    console.log('▸ production workflow (UI wizard + lifecycle)');
    await page.goto(APP + '/production/new', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /معجنات التغطية/ }).first().click();
    await page.getByRole('button', { name: 'التالي' }).click();
    await page.getByLabel('الكمية المخططة').fill('50');
    await page.getByLabel('مستودع المواد').selectOption(WH);
    await page.getByLabel('مستودع الإخراج').selectOption(WHB);
    await page.getByLabel('سماحية الهدر').fill('10');
    await page.getByRole('button', { name: 'التالي' }).click();
    await page.waitForSelector('text=كل المواد متوفرة', { timeout: 15000 });
    await page.screenshot({ path: path.join(OUT, '30-production-wizard-availability.png') });
    await page.getByRole('button', { name: 'التالي' }).click();
    await page.getByRole('button', { name: /إنشاء المسودة/ }).click();
    await page.waitForURL(/\/warehouse\/production\/(?!new)[^/]+$/, { timeout: 20000 });
    const orderId = page.url().split('/').pop().split('?')[0];
    check('wizard created a draft and landed on detail', !!orderId && orderId.startsWith('POV2-'), orderId);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '31-production-detail-draft.png') });

    // Lifecycle via API (admin bypasses maker-checker), verify UI after each step.
    let r = await api('POST', '/api/inventory/v2/production-orders/' + orderId + '/approve', {});
    check('approve → 200', r.status === 200, r.body);
    r = await api('POST', '/api/inventory/v2/production-orders/' + orderId + '/issue-materials', { lines: [{ itemId: RAW1, qty: 10 }, { itemId: RAW2, qty: 5 }], laborCost: 15, reason: 'تغطية E2E' });
    check('issue-materials → 200 (FEFO on tracked)', r.status === 200, r.body && r.body.code);
    r = await api('POST', '/api/inventory/v2/production-orders/' + orderId + '/record-output', { goodQty: 30, batchNumber: 'FG-NAV-1' });
    check('record-output #1 (partial) → 200', r.status === 200, r.body && r.body.code);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const partialBadge = await page.locator('text=منجز جزئيًا').count();
    check('detail shows derived "منجز جزئيًا" badge', partialBadge > 0, null);
    await page.getByRole('tab', { name: 'المواد' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '32-production-materials-tab.png') });
    await page.getByRole('tab', { name: 'القيود' }).click();
    await page.waitForTimeout(600);
    const glRows = await page.locator('text=/JV-/').count();
    check('journals tab lists posted journals', glRows > 0, glRows);
    await page.screenshot({ path: path.join(OUT, '33-production-journals-tab.png') });
    r = await api('POST', '/api/inventory/v2/production-orders/' + orderId + '/record-output', { goodQty: 15, wasteQty: 5, wasteReason: 'هدر تغطية', batchNumber: 'FG-NAV-2' });
    check('record-output #2 (good+waste) → 200', r.status === 200, r.body && r.body.code);
    r = await api('POST', '/api/inventory/v2/production-orders/' + orderId + '/complete', {});
    check('complete → 200 (45+5=50)', r.status === 200, r.body && r.body.code);
    r = await api('POST', '/api/inventory/v2/production-orders/' + orderId + '/close', {});
    check('close → 200', r.status === 200, r.body && r.body.code);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.getByRole('tab', { name: 'الفروقات' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, '34-production-variance-closed.png') });
    const closedBadge = await page.locator('text=مغلق').count();
    check('detail shows closed status', closedBadge > 0, null);

    // ── 4) Mobile viewport spot-check ────────────────────────────────────────
    console.log('▸ mobile');
    const mob = await ctx.newPage();
    await mob.setViewportSize({ width: 375, height: 812 });
    const mobErrors = [];
    mob.on('pageerror', (e) => mobErrors.push(String(e).slice(0, 150)));
    for (const [nm, p] of [['40-mobile-dashboard', '/'], ['41-mobile-production', '/production'], ['42-mobile-items', '/items']]) {
      await mob.goto(APP + p, { waitUntil: 'domcontentloaded' });
      await mob.waitForTimeout(1500);
      await mob.screenshot({ path: path.join(OUT, nm + '.png') });
    }
    check('mobile pages render without page errors', mobErrors.length === 0, mobErrors.slice(0, 2));

    console.log(`\nScreenshots: ${OUT}`);
  } catch (e) {
    fail++; failures.push('FATAL: ' + (e && e.message));
    console.error('FATAL', e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} nav-coverage: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
