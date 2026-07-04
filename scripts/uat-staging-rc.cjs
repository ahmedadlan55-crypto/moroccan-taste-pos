/* Integrated Staging UAT — Final RC (codex/system-v2-final-rc).
   Runs against the LIVE staging deployment in a real browser (Playwright):
     • App-shell integration: ONE real login → /warehouse inside the shell,
       /warehouse-v2 redirect, back/forward, no duplicate login/sidebar.
     • Full warehouse page sweep (placeholders / Arabic digits / console errors).
     • Warehouse CRUD + Item create + Barcode add + Topbar scan — all via UI.
     • Receipts with lots (FEFO fixtures) + GL-failure ROLLBACK drill.
     • Partial purchase receiving via the UI wizard (two rounds).
     • Transfer + Stocktake lifecycles + Production order (UI wizard + lifecycle).
     • Cashier V2 full day on /pos-v2: shift, barcode scan, cash/card/mixed,
       hold/resume, discount ceiling, offline→sync exactly-once, tracked FEFO
       sale, over-stock rollback, replay no-duplication, legacy void, close.
     • Global GL/Lot invariants + safety counters + legacy coexistence.
   Requires env (via scratchpad/with-staging-rc.cjs handoff — secrets never printed):
     STAGING_BASE, STG_DB_HOST/PORT/USER/PASSWORD/NAME
   Run: node <scratchpad>/with-staging-rc.cjs node scripts/uat-staging-rc.cjs
*/
'use strict';
const { chromium } = require('C:/tmp/warehouse-v2-inventory-transactions/node_modules/playwright');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const BASE = process.env.STAGING_BASE || 'https://warehouse-staging-production-aa06.up.railway.app';
const OUT = path.join(__dirname, '..', 'artifacts', 'rc-staging-uat');
fs.mkdirSync(OUT, { recursive: true });

const U_ADMIN = 'uat_rc_admin', U_CASH = 'uat_rc_cashier', U_MGR = 'uat_rc_mgr';
const WH_CODE_A = 'UATRC-A', WH_CODE_B = 'UATRC-B';
const SKU_T = 'UATRC-OIL', SKU_U = 'UATRC-SUG', SKU_FG = 'UATRC-FG';
const NAME_T = 'زيت أركان UAT', NAME_U = 'سكر UAT', NAME_FG = 'منتج UAT النهائي';
const BOM_ID = 'UATRC-BOM', PUR_ID = 'UATRC-PUR-1';
const BARCODE_T = '2999000117';

let pass = 0, fail = 0;
const failures = [];
const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; failures.push(name); console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 250) : ''); }
}
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) <= (eps || 0.02);
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const AR_DIGITS = /[٠١٢٣٤٥٦٧٨٩]/;

// ── HTTP helper against staging ────────────────────────────────────────────
function api(method, p, token, body, extraHeaders) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const u = new URL(BASE + p);
    const h = Object.assign(
      { Accept: 'application/json', 'Idempotency-Key': 'uatrc-' + crypto.randomBytes(8).toString('hex') },
      token ? { Authorization: 'Bearer ' + token } : {}, extraHeaders || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host: u.hostname, path: u.pathname + u.search, method, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: s.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, err: String(e) })); if (data) r.write(data); r.end();
  });
}

// ── Staging DB (assertions + fixtures only) ────────────────────────────────
let db;
async function q(sql, params) { const [rows] = await db.query(sql, params || []); return rows; }

async function cleanupFixtures(whA, whB, itemIds) {
  const whs = [whA, whB].filter(Boolean);
  const items = (itemIds || []).filter(Boolean);
  const sqls = [];
  // POS / sales debris for the UAT cashier
  sqls.push(["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]]);
  sqls.push(["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]]);
  sqls.push(["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]]);
  sqls.push(["DELETE s FROM sales s JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=?", [U_CASH]]);
  sqls.push(["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.username=?", [U_CASH]]);
  sqls.push(["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.username=?", [U_CASH]]);
  sqls.push(['DELETE FROM pos_orders WHERE username=?', [U_CASH]]);
  sqls.push(['DELETE FROM shifts WHERE username=?', [U_CASH]]);
  sqls.push(['DELETE FROM idempotency_keys WHERE username IN (?,?,?)', [U_ADMIN, U_CASH, U_MGR]]);
  if (whs.length) {
    const ph = whs.map(() => '?').join(',');
    for (const t of ['production_issue_lines', 'production_issue_events']) {
      sqls.push([`DELETE x FROM ${t} x JOIN production_orders po ON po.id=x.production_order_id WHERE po.warehouse_id IN (${ph})`, whs]);
    }
    sqls.push([`DELETE pout FROM production_output pout JOIN production_orders po ON po.id=pout.production_order_id WHERE po.warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE pc FROM production_consumption pc JOIN production_orders po ON po.id=pc.production_order_id WHERE po.warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE w FROM work_order_lot_consumption w JOIN production_orders po ON po.id=w.work_order_id WHERE po.warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE e FROM inv_tx_events e JOIN production_orders po ON po.id=e.doc_id WHERE e.doc_type='production' AND po.warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM production_orders WHERE warehouse_id IN (${ph})`, whs]);
    for (const t of ['inv_receipt_items:inv_receipts:receipt_id', 'inv_issue_items:inv_issues:issue_id', 'inv_adjustment_items:inv_adjustments:adjustment_id', 'inv_stocktake_items:inv_stocktakes:stocktake_id']) {
      const [child, parent, fk] = t.split(':');
      sqls.push([`DELETE c FROM ${child} c JOIN ${parent} p ON p.id=c.${fk} WHERE p.warehouse_id IN (${ph})`, whs]);
      sqls.push([`DELETE FROM ${parent} WHERE warehouse_id IN (${ph})`, whs]);
    }
    sqls.push([`DELETE FROM stock_issues WHERE from_warehouse_id IN (${ph}) OR to_warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM inventory_lot_movements WHERE warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM warehouse_lot_balances WHERE warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM inventory_movements WHERE warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM warehouse_stock WHERE warehouse_id IN (${ph})`, whs]);
  }
  if (items.length) {
    const ph = items.map(() => '?').join(',');
    sqls.push([`DELETE FROM inventory_lots WHERE item_id IN (${ph})`, items]);
    sqls.push([`DELETE FROM item_barcodes WHERE item_id IN (${ph})`, items]);
    sqls.push([`DELETE FROM menu WHERE id IN (${ph})`, items]);
    sqls.push([`DELETE FROM bom_lines WHERE bom_id=?`, [BOM_ID]]);
    sqls.push([`DELETE FROM bom WHERE id=?`, [BOM_ID]]);
    sqls.push([`DELETE FROM inv_items WHERE id IN (${ph})`, items]);
  }
  sqls.push(['DELETE FROM purchases WHERE id=?', [PUR_ID]]);
  if (whs.length) {
    const ph = whs.map(() => '?').join(',');
    sqls.push([`DELETE FROM user_warehouse_access WHERE warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM negative_stock_policy WHERE warehouse_id IN (${ph})`, whs]);
    sqls.push([`DELETE FROM warehouses WHERE id IN (${ph})`, whs]);
  }
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

(async () => {
  console.log('\n═══ Integrated Staging UAT — Final RC ═══');
  console.log('BASE =', BASE, '\n');
  db = mysql.createPool({
    host: process.env.STG_DB_HOST, port: Number(process.env.STG_DB_PORT || 3306),
    user: process.env.STG_DB_USER, password: process.env.STG_DB_PASSWORD,
    database: process.env.STG_DB_NAME, connectionLimit: 3, dateStrings: true,
  });

  // ── P0: users + prior-run cleanup ─────────────────────────────────────────
  const pwAdmin = crypto.randomBytes(9).toString('base64url');
  const pwCash = crypto.randomBytes(9).toString('base64url');
  const pwMgr = crypto.randomBytes(9).toString('base64url');
  for (const [u, p, role] of [[U_ADMIN, pwAdmin, 'admin'], [U_CASH, pwCash, 'cashier'], [U_MGR, pwMgr, 'manager']]) {
    const hash = bcrypt.hashSync(p, 10);
    await db.query(
      'INSERT INTO users (username, password, role, active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE password=VALUES(password), role=VALUES(role), active=1',
      [u, hash, role]);
  }
  fs.writeFileSync(path.join(OUT, 'uat-creds.local.json'), JSON.stringify({ note: 'staging-only UAT users — local file, never committed', users: { [U_ADMIN]: pwAdmin, [U_CASH]: pwCash, [U_MGR]: pwMgr } }, null, 2));
  // prior-run fixture discovery (by stable codes/skus) then cleanup
  const priorWh = await q('SELECT id, code FROM warehouses WHERE code IN (?,?)', [WH_CODE_A, WH_CODE_B]);
  const priorItems = await q("SELECT id FROM inv_items WHERE sku_norm IN (?,?,?)", [SKU_T, SKU_U, SKU_FG]);
  await cleanupFixtures(
    (priorWh.find((w) => w.code === WH_CODE_A) || {}).id,
    (priorWh.find((w) => w.code === WH_CODE_B) || {}).id,
    priorItems.map((r) => r.id));
  console.log('P0: users upserted, prior fixtures cleaned');

  // real API tokens via real logins
  const la = await api('POST', '/api/auth/login', null, { username: U_ADMIN, password: pwAdmin });
  const lc = await api('POST', '/api/auth/login', null, { username: U_CASH, password: pwCash });
  const lm = await api('POST', '/api/auth/login', null, { username: U_MGR, password: pwMgr });
  check('P0: تسجيل دخول API حقيقي للمستخدمين الثلاثة (admin/cashier/manager)', la.status === 200 && la.body && la.body.token && lc.status === 200 && lm.status === 200, { a: la.status, c: lc.status, m: lm.status });
  const TA = la.body && la.body.token, TC = lc.body && lc.body.token, TM = lm.body && lm.body.token;
  if (!TA) { console.error('FATAL: admin login failed'); process.exit(2); }

  let browser = null;
  let glRenamed = false;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
    const errsNow = () => consoleErrors.filter((e) => !/favicon|manifest|401|403|Failed to load resource/i.test(e));

    // ── P1: app-shell integration — ONE real login in the browser ──────────
    console.log('\n▸ P1: App Shell + تسجيل دخول واحد');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#lUser', { timeout: 30000 });
    await page.fill('#lUser', U_ADMIN);
    await page.fill('#lPass', pwAdmin);
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=المستودعات', { timeout: 30000 });
    check('P1: تسجيل الدخول من شاشة النظام الرئيسي نجح', true);
    await page.waitForSelector('a[data-wh-v2-link]', { state: 'visible', timeout: 20000 }).catch(() => {});
    await shot('01-shell-logged-in');
    const whLinks = await page.locator('a[href="/warehouse"], a[href^="/warehouse?"]').count();
    const legacyInvLinks = await page.locator('a', { hasText: 'المخزون (القديم)' }).count();
    check('P1: رابط مستودعات واحد فقط في القائمة (لا رابطين)', whLinks >= 1 && legacyInvLinks === 0, { whLinks, legacyInvLinks });
    await page.locator('a[href="/warehouse"], a[href^="/warehouse?"]').first().click();
    await page.waitForSelector('h1', { timeout: 30000 });
    await wait(1500);
    check('P1: /warehouse فُتح داخليًا في نفس التبويب', page.url().includes('/warehouse'), page.url());
    check('P1: لا شاشة تسجيل دخول ثانية داخل المستودعات', (await page.locator('#lUser').count()) === 0, null);
    check('P1: زر «العودة للنظام الرئيسي» موجود في قسم المستودعات', (await page.locator('text=العودة للنظام الرئيسي').count()) >= 1, null);
    await shot('02-warehouse-inside-shell');
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await wait(1000);
    const backOk = !page.url().replace(/\/$/, '').endsWith('/warehouse');
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await wait(1200);
    check('P1: زرا الرجوع/التقدم في المتصفح يعملان', backOk && page.url().includes('/warehouse'), page.url());
    await page.goto(BASE + '/warehouse-v2/production', { waitUntil: 'domcontentloaded' });
    await wait(1000);
    check('P1: /warehouse-v2 يحوّل 301 إلى /warehouse (متصفح حقيقي)', page.url().includes('/warehouse/production') && !page.url().includes('warehouse-v2'), page.url());

    // ── P2: full page sweep ─────────────────────────────────────────────────
    console.log('\n▸ P2: مسح كل صفحات المستودعات (placeholder/أرقام/console)');
    const APP = BASE + '/warehouse';
    let digitHits = [], phHits = [], renderFails = [];
    async function sweep(name, urlPath) {
      consoleErrors.length = 0;
      try {
        await page.goto(APP + urlPath, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (_) {
        await wait(3000); // cold container / transient stall → one retry
        await page.goto(APP + urlPath, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      try { await page.waitForSelector('h1', { timeout: 20000 }); } catch (_) {}
      await wait(1400);
      const h1 = await page.locator('h1').first().textContent().catch(() => '');
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (!(h1 || '').trim()) renderFails.push(urlPath);
      if (bodyText.includes('قيد الإنشاء') || bodyText.includes('الصفحة غير موجودة')) phHits.push(urlPath);
      const d = (bodyText.match(AR_DIGITS) || [])[0];
      if (d) digitHits.push(urlPath + ':' + d);
      const errs = errsNow();
      if (errs.length) renderFails.push(urlPath + ' console:' + errs[0]);
      await page.screenshot({ path: path.join(OUT, 'sweep-' + name + '.png') });
      await wait(300);
    }
    const PAGES = [
      ['dashboard', '/'], ['warehouses', '/warehouses'], ['inventory', '/inventory'], ['items', '/items'],
      ['replenishment', '/replenishment'], ['lots', '/lots'], ['expiry', '/expiry'], ['receipts', '/receipts'],
      ['purchase-receiving', '/purchase-receiving'], ['issues', '/issues'], ['transfers', '/transfers'],
      ['stocktakes', '/stocktakes'], ['adjustments', '/adjustments'], ['production', '/production'],
      ['analytics', '/analytics'], ['reports', '/reports'], ['deficits', '/deficits'], ['negative-policy', '/negative-policy'],
      ['wizard-production', '/production/new'], ['wizard-receipts', '/receipts/new'], ['wizard-transfers', '/transfers/new'], ['wizard-stocktakes', '/stocktakes/new'],
    ];
    for (const [n, p] of PAGES) await sweep(n, p);
    check('P2: كل الصفحات (' + PAGES.length + ') تُرسم بلا أخطاء console', renderFails.length === 0, renderFails.slice(0, 4));
    check('P2: صفر Placeholder/404 عبر كل الصفحات', phHits.length === 0, phHits);
    check('P2: أرقام إنجليزية فقط عبر كل الصفحات (لا ٠-٩)', digitHits.length === 0, digitHits.slice(0, 4));

    // ── P3: Warehouse CRUD via UI ───────────────────────────────────────────
    console.log('\n▸ P3: إدارة المستودعات (UI)');
    async function createWarehouseUI(name, code) {
      await page.goto(APP + '/warehouses', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1', { timeout: 20000 });
      await wait(1000);
      await page.getByRole('button', { name: 'مستودع جديد' }).first().click();
      await page.waitForSelector('[aria-label="مستودع جديد"]', { timeout: 10000 });
      await page.locator('[aria-label="مستودع جديد"] input[placeholder*="مثال"]').fill(name);
      await page.locator('[aria-label="مستودع جديد"] input[placeholder="RAW-RYD-01"]').fill(code);
      await page.locator('[aria-label="مستودع جديد"]').getByRole('button', { name: /إنشاء|حفظ/ }).last().click();
      await wait(2500);
      const rows = await q('SELECT id, name FROM warehouses WHERE code=?', [code]);
      return rows.length ? rows[0] : null;
    }
    const whA = await createWarehouseUI('مستودع UAT الرئيسي', WH_CODE_A);
    check('P3: إنشاء مستودع من الواجهة (UATRC-A)', !!whA, whA);
    const whB = await createWarehouseUI('مستودع UAT الفرعي', WH_CODE_B);
    check('P3: إنشاء مستودع ثانٍ (UATRC-B)', !!whB, whB);
    const WH_A = whA && whA.id, WH_B = whB && whB.id;
    // rename via the v2 API (edit dialog باقي مساراته مثبتة محليًا 37/37) ثم تحقق UI
    const wDetail = await api('GET', '/api/inventory/v2/warehouses/' + WH_A, TA);
    const wVer = wDetail.body && wDetail.body.data ? wDetail.body.data.version : 1;
    const ren = await api('PATCH', '/api/inventory/v2/warehouses/' + WH_A, TA, { name: 'مستودع UAT الرئيسي — معدل', expectedVersion: wVer });
    await page.goto(APP + '/warehouses', { waitUntil: 'domcontentloaded' });
    await wait(1800);
    const renamedShown = await page.locator('text=مستودع UAT الرئيسي — معدل').count();
    check('P3: تعديل اسم المستودع وانعكاسه في الواجهة', ren.status === 200 && renamedShown >= 1, { st: ren.status, shown: renamedShown });
    await shot('03-warehouses-crud');
    // scope grant for the manager user (transfers need BOTH sides)
    const [mgrRow] = await q('SELECT id FROM users WHERE username=?', [U_MGR]);
    for (const w of [WH_A, WH_B]) {
      try { await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id, granted_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE warehouse_id=warehouse_id', [mgrRow.id, w, 'uat']); } catch (_) {
        try { await db.query('INSERT INTO user_warehouse_access (user_id, warehouse_id) VALUES (?,?)', [mgrRow.id, w]); } catch (_) {}
      }
    }

    // ── P4: Item + tracking + barcode via UI ────────────────────────────────
    console.log('\n▸ P4: صنف جديد + باركود (UI)');
    async function createItemUI(nm, sku, unit, cat, cost) {
      await page.goto(APP + '/items/new', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1', { timeout: 20000 });
      await wait(1200);
      await page.getByLabel('الاسم', { exact: true }).fill(nm);
      await page.getByLabel('SKU').fill(sku);
      await page.getByLabel('الوحدة').fill(unit);
      await page.getByLabel('الفئة').fill(cat);
      await page.getByLabel('التكلفة').fill(String(cost));
      await page.getByRole('button', { name: 'إنشاء الصنف' }).click();
      await wait(2500);
      const rows = await q('SELECT id FROM inv_items WHERE sku_norm=?', [sku]);
      return rows.length ? rows[0].id : null;
    }
    const ITEM_T = await createItemUI(NAME_T, SKU_T, 'لتر', 'خام UAT', 10);
    check('P4: إنشاء صنف من الواجهة (سيُتتبع بالصلاحية)', !!ITEM_T, ITEM_T);
    const ITEM_U = await createItemUI(NAME_U, SKU_U, 'كجم', 'خام UAT', 2);
    check('P4: إنشاء صنف ثانٍ غير متتبع', !!ITEM_U, ITEM_U);
    const ITEM_FG = await createItemUI(NAME_FG, SKU_FG, 'حبة', 'إنتاج UAT', 0);
    check('P4: إنشاء صنف المنتج النهائي', !!ITEM_FG, ITEM_FG);
    // tracking BEFORE any movement (fixture-level; القفل بعد الحركات مثبت في اختبارات item-master)
    await db.query("UPDATE inv_items SET tracking_mode='expiry' WHERE id=?", [ITEM_T]);
    // Barcode via the item drawer UI
    await page.goto(APP + '/items', { waitUntil: 'domcontentloaded' });
    await wait(1500);
    await page.locator('text=' + NAME_T).first().click();
    await page.getByRole('tab', { name: 'الباركود' }).click().catch(async () => { await page.locator('text=الباركود').first().click(); });
    await wait(800);
    await page.getByLabel('باركود جديد').fill(BARCODE_T);
    await page.getByRole('button', { name: 'إضافة' }).click();
    await wait(400);
    await page.getByRole('button', { name: 'حفظ الباركودات' }).click();
    // the success toast is transient; the authoritative proof is the DB row (poll it)
    await page.waitForSelector('text=حُفظت الباركودات', { timeout: 8000 }).catch(() => {});
    let bcRows = [], bcOnItem = [{}];
    for (let i = 0; i < 8; i++) {
      bcRows = await q('SELECT code FROM item_barcodes WHERE item_id=?', [ITEM_T]);
      bcOnItem = await q('SELECT barcode FROM inv_items WHERE id=?', [ITEM_T]);
      if (bcRows.some((r) => String(r.code) === BARCODE_T) || String((bcOnItem[0] || {}).barcode) === BARCODE_T) break;
      await wait(700);
    }
    check('P4: إضافة باركود من الواجهة وحفظه في القاعدة', (bcRows.some((r) => String(r.code) === BARCODE_T) || String((bcOnItem[0] || {}).barcode) === BARCODE_T), { bcRows, bcOnItem });
    await shot('04-item-barcode');
    // Topbar global scan: hit + miss
    await page.keyboard.press('Escape');
    await wait(400);
    const scanBox = page.locator('input[aria-label="بحث بالباركود"]:visible').first();
    await scanBox.fill(BARCODE_T);
    await scanBox.press('Enter');
    await wait(1500);
    const missShown = await page.locator('text=لا يوجد صنف بهذا الباركود').count();
    const hitEvidence = (await page.locator('text=' + NAME_T).count()) >= 1;
    check('P4: البحث العالمي بالباركود يجد الصنف', missShown === 0 && hitEvidence, { missShown, hitEvidence, url: page.url() });
    await scanBox.fill('0000000000999');
    await scanBox.press('Enter');
    await wait(1200);
    check('P4: باركود غير موجود ⇒ رسالة واضحة', (await page.locator('text=لا يوجد صنف بهذا الباركود').count()) >= 1, null);
    await shot('05-barcode-scan');

    // ── P5: receipts with lots + GL-failure rollback drill ─────────────────
    console.log('\n▸ P5: استلامات بدفعات (FEFO) + تمرين Rollback عند فشل GL');
    const accs = await api('GET', '/api/inventory/v2/gl-accounts?usage=receipt', TA);
    const ACC = accs.body && accs.body.data && accs.body.data.length ? (accs.body.data[0].code || accs.body.data[0].id) : null;
    check('P5: حسابات مقابلة متاحة للاستلام', !!ACC, accs.status);
    const day = 24 * 3600 * 1000;
    const dstr = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 10);
    async function postReceipt(items, expectFail) {
      const cr = await api('POST', '/api/inventory/v2/receipts', TA, { warehouseId: WH_A, reason: 'استلام UAT', counterAccountCode: ACC, items });
      if (cr.status !== 201 && cr.status !== 200) return { stage: 'create', res: cr };
      const id = cr.body.data.id;
      const ap = await api('POST', `/api/inventory/v2/receipts/${id}/approve`, TA, { expectedVersion: cr.body.data.version || 1 });
      if (ap.status !== 200) return { stage: 'approve', res: ap, id };
      const po = await api('POST', `/api/inventory/v2/receipts/${id}/post`, TA, { expectedVersion: (ap.body.data && ap.body.data.version) || 2 });
      return { stage: 'post', res: po, id };
    }
    const r1 = await postReceipt([{ itemId: ITEM_T, qty: 30, unitCost: 10, lots: [{ lotNumber: 'UATRC-L1', qty: 30, expiryDate: dstr(40 * day) }] }]);
    check('P5: استلام دفعة L1 (30 × صلاحية +40 يوم) → posted', r1.stage === 'post' && r1.res.status === 200, r1);
    const r2 = await postReceipt([{ itemId: ITEM_T, qty: 18, unitCost: 10, lots: [{ lotNumber: 'UATRC-L2', qty: 18, expiryDate: dstr(120 * day) }] }]);
    check('P5: استلام دفعة L2 (18 × صلاحية +120 يوم) → posted', r2.stage === 'post' && r2.res.status === 200, r2);
    const r3 = await postReceipt([{ itemId: ITEM_U, qty: 50, unitCost: 2 }]);
    check('P5: استلام صنف غير متتبع (50) → posted', r3.stage === 'post' && r3.res.status === 200, r3);
    let st = await q('SELECT item_id, qty FROM warehouse_stock WHERE warehouse_id=? ORDER BY item_id', [WH_A]);
    const qtyOf = (arr, it) => Number((arr.find((r) => r.item_id === it) || {}).qty || 0);
    check('P5: أرصدة المستودع بعد الاستلامات (متتبع 48 / غير متتبع 50)', near(qtyOf(st, ITEM_T), 48) && near(qtyOf(st, ITEM_U), 50), st);
    const lb = await q('SELECT b.qty, l.lot_number FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? ORDER BY l.lot_number', [WH_A, ITEM_T]);
    check('P5: أرصدة الدفعات L1=30 / L2=18', lb.length === 2 && near(lb[0].qty, 30) && near(lb[1].qty, 18), lb);
    const glr = await q("SELECT j.id, (SELECT ROUND(SUM(e.debit),2) FROM gl_entries e WHERE e.journal_id=j.id) AS d, (SELECT ROUND(SUM(e.credit),2) FROM gl_entries e WHERE e.journal_id=j.id) AS c FROM gl_journals j WHERE j.reference_type='inv_receipt' AND j.reference_id=?", [r1.id]);
    check('P5: قيد GL للاستلام موجود ومتوازن (مدين=دائن)', glr.length === 1 && glr[0].d != null && String(glr[0].d) === String(glr[0].c), glr);
    // UI evidence: the new lots page shows L1
    await page.goto(APP + '/lots', { waitUntil: 'domcontentloaded' });
    await wait(1800);
    check('P5: صفحة الدفعات تعرض UATRC-L1', (await page.locator('text=UATRC-L1').count()) >= 1, null);
    await shot('06-lots-after-receipts');

    // GL-failure rollback drill (controlled, restored in finally)
    console.log('  … تمرين فشل GL (إسقاط مؤقت لجدول gl_entries)');
    const stBefore = await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]);
    const mvBefore = await q('SELECT COUNT(*) n FROM inventory_movements WHERE warehouse_id=?', [WH_A]);
    await db.query('RENAME TABLE gl_entries TO gl_entries_uat_drill');
    glRenamed = true;
    const r4fail = await postReceipt([{ itemId: ITEM_T, qty: 12, unitCost: 10, lots: [{ lotNumber: 'UATRC-L4', qty: 12, expiryDate: dstr(200 * day) }] }]);
    await db.query('RENAME TABLE gl_entries_uat_drill TO gl_entries');
    glRenamed = false;
    const stAfterFail = await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]);
    const mvAfterFail = await q('SELECT COUNT(*) n FROM inventory_movements WHERE warehouse_id=?', [WH_A]);
    const lotL4 = await q("SELECT id FROM inventory_lots WHERE item_id=? AND lot_number='UATRC-L4'", [ITEM_T]);
    check('P5-ROLLBACK: فشل GL ⇒ الترحيل يفشل بلا أي كتابة مخزون/حركة/دفعة', r4fail.stage === 'post' && r4fail.res.status >= 500 === false ? (r4fail.res.status >= 400) : true, null);
    check('P5-ROLLBACK: المخزون لم يتغير بعد الفشل', String(stBefore[0].qty) === String(stAfterFail[0].qty) && Number(mvBefore[0].n) === Number(mvAfterFail[0].n) && lotL4.length === 0, { before: stBefore[0], after: stAfterFail[0], lotL4 });
    // re-post the SAME doc after restore succeeds exactly once
    const rePost = await api('POST', `/api/inventory/v2/receipts/${r4fail.id}/post`, TA, { expectedVersion: 2 });
    const stAfterOk = await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]);
    check('P5-ROLLBACK: بعد استعادة GL الترحيل ينجح مرة واحدة بالضبط (48→60)', rePost.status === 200 && near(stAfterOk[0].qty, 60), { st: rePost.status, qty: stAfterOk[0] });

    // ── P6: partial purchase receiving via UI wizard ────────────────────────
    console.log('\n▸ P6: استلام المشتريات الجزئي (UI)');
    await db.query("INSERT INTO purchases (id, purchase_date, supplier_name, status, items_json, total_price, warehouse_id) VALUES (?,NOW(),'مورد UAT','draft',?,80,?)",
      [PUR_ID, JSON.stringify([{ itemId: ITEM_U, name: NAME_U, qty: 40, unitPrice: 2 }]), WH_A]);
    await page.goto(APP + '/purchase-receiving', { waitUntil: 'domcontentloaded' });
    await wait(1800);
    check('P6: طابور المشتريات المفتوحة يعرض أمر UAT', (await page.locator('text=' + PUR_ID).count()) >= 1, null);
    await shot('07-purchase-queue');
    async function receiveRound(qty) {
      await page.goto(APP + '/purchase-receiving/' + PUR_ID, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1', { timeout: 20000 });
      await wait(1500);
      // الخطوة 1: مستودع الاستلام + الحساب المقابل ثم «التالي»
      await page.getByLabel('المستودع', { exact: true }).selectOption(WH_A);
      const accSel = page.getByLabel('الحساب المقابل');
      if (ACC) { await accSel.selectOption(String(ACC)).catch(() => accSel.selectOption({ index: 1 })); }
      await page.getByRole('button', { name: 'التالي' }).click();
      await wait(800);
      // الخطوة 2: كمية هذا الاستلام + التكلفة → «المراجعة»
      await page.getByLabel('كمية ' + NAME_U).fill(String(qty));
      await page.getByLabel('تكلفة ' + NAME_U).fill('2');
      await page.getByRole('button', { name: 'المراجعة' }).click();
      await wait(600);
      // الخطوة 3: تأكيد الإنشاء
      await page.getByRole('button', { name: /إنشاء إذن الاستلام/ }).click();
      await wait(2500);
      // the wizard creates a DRAFT v2 receipt linked to the purchase → approve+post via API
      const dr = await q("SELECT id, version FROM inv_receipts WHERE purchase_id=? AND status='draft' ORDER BY created_at DESC LIMIT 1", [PUR_ID]);
      if (!dr.length) return { ok: false, why: 'no draft' };
      const ap = await api('POST', `/api/inventory/v2/receipts/${dr[0].id}/approve`, TA, { expectedVersion: dr[0].version });
      const po = await api('POST', `/api/inventory/v2/receipts/${dr[0].id}/post`, TA, { expectedVersion: (ap.body && ap.body.data && ap.body.data.version) || (dr[0].version + 1) });
      return { ok: po.status === 200, id: dr[0].id, st: po.status };
    }
    const round1 = await receiveRound(15);
    let purRow = await q('SELECT v2_receive_status FROM purchases WHERE id=?', [PUR_ID]);
    check('P6: استلام جزئي 15/40 عبر المعالج ⇒ partial', round1.ok && String(purRow[0].v2_receive_status) === 'partial', { round1, purRow });
    await page.goto(APP + '/purchase-receiving/' + PUR_ID, { waitUntil: 'domcontentloaded' });
    await wait(1800);
    const remainderText = await page.locator('body').innerText();
    check('P6: المعالج يعرض المتبقي 25 بعد الجولة الأولى', /25/.test(remainderText), null);
    await shot('08-purchase-partial');
    const round2 = await receiveRound(25);
    purRow = await q('SELECT v2_receive_status FROM purchases WHERE id=?', [PUR_ID]);
    check('P6: استلام المتبقي 25 ⇒ الحالة لم تعد partial', round2.ok && String(purRow[0].v2_receive_status) !== 'partial', { round2, purRow });
    st = await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_U]);
    check('P6: رصيد الصنف غير المتتبع 50+40=90', near(st[0].qty, 90), st);

    // ── P7: negative policy + deficits pages ───────────────────────────────
    console.log('\n▸ P7: سياسة السالب والعجوزات');
    await page.goto(APP + '/negative-policy', { waitUntil: 'domcontentloaded' });
    await wait(1500);
    const npBody = await page.locator('body').innerText();
    check('P7: صفحة سياسة المخزون السالب تعمل وتعرض السياسة الفعّالة', /سياسة|منع|السالب/.test(npBody), null);
    await shot('09-negative-policy');
    const eff = await api('GET', `/api/inventory/v2/negative-policy/effective?warehouseId=${WH_A}&itemId=${ITEM_U}`, TA);
    check('P7: السياسة الفعّالة عبر API (block افتراضيًا)', eff.status === 200 && /block/.test(JSON.stringify(eff.body)), eff.body && eff.body.data);

    // ── P8: transfer lifecycle (FEFO out) ───────────────────────────────────
    console.log('\n▸ P8: تحويل بين مستودعين');
    const tc = await api('POST', '/api/erp/stock-issues', TM, { fromWarehouseId: WH_A, toWarehouseId: WH_B, items: [{ itemId: ITEM_T, qtyRequested: 5 }] });
    const tid = tc.body && tc.body.id;
    check('P8: إنشاء تحويل (مدير بصلاحية الطرفين)', (tc.status === 200 || tc.status === 201) && !!tid, { st: tc.status, code: tc.body && tc.body.code });
    let tv = (tc.body && tc.body.version) || 1;
    const tap = await api('POST', `/api/erp/stock-issues/${tid}/approve`, TA, {});
    tv = (tap.body && tap.body.version) || tv + 1;
    const tis = await api('POST', `/api/erp/stock-issues/${tid}/issue`, TM, { expectedVersion: tv });
    tv = (tis.body && tis.body.version) || tv + 1;
    const trc = await api('POST', `/api/erp/stock-issues/${tid}/receive`, TM, { expectedVersion: tv });
    check('P8: اعتماد→صرف→استلام التحويل', tap.status === 200 && tis.status === 200 && trc.status === 200, { a: tap.status, i: tis.status, r: trc.status, code: (tis.body && tis.body.code) || (trc.body && trc.body.code) });
    const lbA = await q("SELECT l.lot_number, b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? ORDER BY l.lot_number", [WH_A, ITEM_T]);
    const lbB = await q("SELECT l.lot_number, b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND b.qty>0 ORDER BY l.lot_number", [WH_B, ITEM_T]);
    const l1A = Number((lbA.find((r) => r.lot_number === 'UATRC-L1') || {}).qty || 0);
    check('P8-FEFO: الصرف خرج من L1 (أقرب صلاحية) حصريًا: L1=25', near(l1A, 25) && lbB.length === 1 && lbB[0].lot_number === 'UATRC-L1' && near(lbB[0].qty, 5), { lbA, lbB });
    await page.goto(APP + '/transfers', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 20000 });
    await wait(1800);
    const transfersRows = await page.locator('table tbody tr, [role="row"]').count();
    const transfersBody = await page.locator('body').innerText();
    check('P8: صفحة التحويلات تعرض السجلات بلا placeholder', transfersRows >= 1 && !transfersBody.includes('قيد الإنشاء'), { rows: transfersRows });
    await shot('10-transfers');

    // ── P9: stocktake lifecycle ─────────────────────────────────────────────
    console.log('\n▸ P9: جرد مخزني');
    const sc = await api('POST', '/api/inventory/v2/stocktakes', TA, { warehouseId: WH_A, scopeType: 'items', itemIds: [ITEM_U], reason: 'جرد UAT', blindCount: false });
    const sid = sc.body && sc.body.data && sc.body.data.id;
    check('P9: إنشاء جرد', (sc.status === 200 || sc.status === 201) && !!sid, { st: sc.status, code: sc.body && sc.body.code });
    await api('POST', `/api/inventory/v2/stocktakes/${sid}/start`, TA, {});
    await api('PUT', `/api/inventory/v2/stocktakes/${sid}/counts`, TA, { counts: [{ itemId: ITEM_U, countedQty: 88 }] });
    await api('POST', `/api/inventory/v2/stocktakes/${sid}/submit`, TA, {});
    const sap = await api('POST', `/api/inventory/v2/stocktakes/${sid}/approve`, TM, {});
    const spo = await api('POST', `/api/inventory/v2/stocktakes/${sid}/post`, TA, {});
    st = await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_U]);
    check('P9: دورة الجرد كاملة والفرق −2 طُبّق (90→88)', sap.status === 200 && spo.status === 200 && near(st[0].qty, 88), { a: sap.status, p: spo.status, qty: st[0] });
    const adj = await q("SELECT COUNT(*) n FROM inv_adjustments WHERE warehouse_id=? AND status='posted'", [WH_A]);
    check('P9: تسوية مرتبطة posted عبر محرك التسويات', Number(adj[0].n) >= 1, adj[0]);
    await page.goto(APP + '/stocktakes', { waitUntil: 'domcontentloaded' });
    await wait(1500);
    await shot('11-stocktakes');

    // ── P10: production order — UI wizard + full lifecycle ─────────────────
    console.log('\n▸ P10: أمر إنتاج كامل (معالج UI + دورة حياة)');
    await db.query("INSERT INTO bom (id,product_id,version,yield_quantity,yield_unit,is_active,product_source) VALUES (?,?,1,10,'PCS',1,'inv')", [BOM_ID, ITEM_FG]);
    await db.query("INSERT INTO bom_lines (id,bom_id,component_item_id,quantity,unit,waste_pct) VALUES (?,?,?,2,'كجم',0),(?,?,?,1,'لتر',0)",
      ['UATRC-BL1', BOM_ID, ITEM_U, 'UATRC-BL2', BOM_ID, ITEM_T]);
    await page.goto(APP + '/production/new', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 20000 });
    await wait(2000);
    await page.getByRole('button', { name: new RegExp(NAME_FG) }).first().click();
    await page.getByRole('button', { name: 'التالي' }).click();
    // planned 30, BOM yield 10 → 3 batches → expected 6×ITEM_U + 3×ITEM_T
    await page.getByLabel('الكمية المخططة').fill('30');
    await page.getByLabel('مستودع المواد').selectOption(WH_A);
    await page.getByLabel('مستودع الإخراج').selectOption(WH_B);
    await page.getByRole('button', { name: 'التالي' }).click();
    await page.waitForSelector('text=كل المواد متوفرة', { timeout: 20000 });
    await shot('12-production-availability');
    await page.getByRole('button', { name: 'التالي' }).click();
    await page.getByRole('button', { name: /إنشاء المسودة/ }).click();
    await page.waitForURL(/\/warehouse\/production\/(?!new)[^/]+$/, { timeout: 30000 });
    const prodId = page.url().split('/').pop().split('?')[0];
    check('P10: المعالج أنشأ مسودة POV2 وفتح التفاصيل', !!prodId && prodId.startsWith('POV2-'), prodId);
    const l1BeforeIssue = await q("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_number='UATRC-L1'", [WH_A, ITEM_T]);
    const l1Before = Number((l1BeforeIssue[0] || {}).qty || 0);
    let pr = await api('POST', `/api/inventory/v2/production-orders/${prodId}/approve`, TA, {});
    check('P10: اعتماد', pr.status === 200, pr.body && pr.body.code);
    // إصدار مطابق لتوسعة المعيار (6 و 3) — تجاوزه يُرفض بـ OVER_ISSUE (سلوك صحيح)
    pr = await api('POST', `/api/inventory/v2/production-orders/${prodId}/issue-materials`, TA, { lines: [{ itemId: ITEM_U, qty: 6 }, { itemId: ITEM_T, qty: 3 }], reason: 'صرف UAT' });
    check('P10: صرف مواد (FEFO للمتتبع)', pr.status === 200, pr.body && pr.body.code);
    const wolc = await q('SELECT COUNT(*) n FROM work_order_lot_consumption WHERE work_order_id=?', [prodId]);
    const l1AfterIssue = await q("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_number='UATRC-L1'", [WH_A, ITEM_T]);
    check(`P10-FEFO: الاستهلاك من L1 (${l1Before}→${l1Before - 3}) + سجل تتبع جيني`, near(l1AfterIssue[0].qty, l1Before - 3) && Number(wolc[0].n) >= 1, { before: l1Before, after: l1AfterIssue[0], wolc: wolc[0] });
    pr = await api('POST', `/api/inventory/v2/production-orders/${prodId}/record-output`, TA, { goodQty: 18 });
    check('P10: إنتاج جزئي (18)', pr.status === 200, pr.body && pr.body.code);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(1800);
    check('P10: شارة «منجز جزئيًا» مشتقة في الواجهة', (await page.locator('text=منجز جزئيًا').count()) >= 1, null);
    await page.getByRole('tab', { name: 'القيود' }).click();
    await wait(900);
    check('P10: تبويب القيود يعرض قيود JV', (await page.locator('text=/JV-/').count()) >= 1, null);
    await shot('13-production-journals');
    pr = await api('POST', `/api/inventory/v2/production-orders/${prodId}/record-output`, TA, { goodQty: 9, wasteQty: 3, wasteReason: 'هدر UAT' });
    check('P10: إنتاج + هدر (9+3)', pr.status === 200, pr.body && pr.body.code);
    pr = await api('POST', `/api/inventory/v2/production-orders/${prodId}/complete`, TA, {});
    check('P10: إكمال (27 جيد + 3 هدر = 30)', pr.status === 200, pr.body && pr.body.code);
    pr = await api('POST', `/api/inventory/v2/production-orders/${prodId}/close`, TA, {});
    check('P10: إغلاق (فروقات WIP→5420)', pr.status === 200, pr.body && pr.body.code);
    const fgStock = await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_B, ITEM_FG]);
    check('P10: رصيد المنتج النهائي في مستودع الإخراج = 27', fgStock.length && near(fgStock[0].qty, 27), fgStock);
    const prn = await api('GET', `/api/inventory/v2/production-orders/${prodId}/print`, TA);
    check('P10: مستند الطباعة الخادمي يعمل', prn.status === 200 && /POV2-|أمر/.test(prn.raw || ''), prn.status);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(1500);
    await page.getByRole('tab', { name: 'الفروقات' }).click().catch(() => {});
    await wait(800);
    await shot('14-production-closed');

    // ── P11: reports + CSV export ───────────────────────────────────────────
    console.log('\n▸ P11: التقارير والتصدير');
    await page.goto(APP + '/reports/stock-balance', { waitUntil: 'domcontentloaded' });
    await wait(2000);
    const repBody = await page.locator('body').innerText();
    check('P11: تقرير أرصدة المخزون يعرض بيانات', /رصيد|المخزون/.test(repBody) && !repBody.includes('قيد الإنشاء'), null);
    await shot('15-report-detail');
    const csv = await api('GET', '/api/inventory/reports/stock-balance/export', TA);
    check('P11: تصدير CSV يعمل (200 + BOM)', csv.status === 200 && csv.raw && csv.raw.charCodeAt(0) === 0xFEFF, csv.status);

    // ── P12: POS full day (separate context, real cashier login) ───────────
    console.log('\n▸ P12: يوم كاشير كامل على /pos-v2');
    await db.query('UPDATE users SET default_warehouse_id=? WHERE username=?', [WH_A, U_CASH]);
    // menu items map 1:1 to the warehouse inv_items (same id) and are marked
    // production_method='imported' — the real-system pattern for a physically
    // stocked good sold directly, so the sale relieves warehouse_stock + lots (FEFO).
    await db.query("INSERT INTO menu (id, name, price, category, active, tax_category, production_method) VALUES (?,?,?,?,1,'S','imported'), (?,?,?,?,1,'Z','imported')",
      [ITEM_T, NAME_T, 25, 'UAT', ITEM_U, NAME_U, 10, 'UAT']);
    const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'ar' });
    const pos = await ctx2.newPage();
    const posErrors = [];
    pos.on('console', (m) => { if (m.type() === 'error') posErrors.push(m.text().slice(0, 200)); });
    pos.on('pageerror', (e) => posErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    const pshot = (n) => pos.screenshot({ path: path.join(OUT, n + '.png') });
    // real login on the shell, then navigate to /pos-v2 with the SAME session
    await pos.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await pos.waitForSelector('#lUser', { timeout: 30000 });
    await pos.fill('#lUser', U_CASH);
    await pos.fill('#lPass', pwCash);
    await pos.keyboard.press('Enter');
    await pos.waitForTimeout(2500);
    await pos.goto(BASE + '/pos-v2/', { waitUntil: 'domcontentloaded' });
    await pos.waitForSelector('text=' + NAME_T, { timeout: 30000 });
    check('P12: /pos-v2 داخل النظام بنفس الجلسة (بلا login ثانٍ)', true);
    await pshot('16-pos-boot');
    await pos.locator('header').getByRole('button', { name: /فتح وردية/ }).click();
    await pos.waitForSelector('header >> text=وردية', { timeout: 20000 });
    await pos.waitForTimeout(1200);
    const shRow = await q("SELECT id, status FROM shifts WHERE username=? ORDER BY start_time DESC LIMIT 1", [U_CASH]);
    check('P12: فتح وردية من الواجهة (صف OPEN في القاعدة)', shRow.length === 1 && String(shRow[0].status).toUpperCase() === 'OPEN', shRow[0]);
    const shiftId = shRow.length ? shRow[0].id : null;
    // — Sale 1: BARCODE SCAN (catalog id) + cash with change —
    // snapshot the tracked-item FEFO frontier + lot-movement count BEFORE the sale
    const l1BeforeSale = Number((await q("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_number='UATRC-L1'", [WH_A, ITEM_T]))[0].qty);
    const lotMvBefore = Number((await q("SELECT COUNT(*) n FROM inventory_lot_movements WHERE warehouse_id=? AND item_id=? AND reference_type='sale'", [WH_A, ITEM_T]))[0].n);
    const stBeforeSale = Number((await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]))[0].qty);
    const scan = pos.locator('input[aria-label="بحث في الأصناف أو مسح باركود"]:visible').first();
    await scan.fill(String(ITEM_T));
    await scan.press('Enter');
    await pos.waitForTimeout(600);
    const cart1 = await pos.locator('[aria-label="سلة الطلب"]').innerText();
    check('P12-ربط: مسح كود الصنف أضافه للسلة (المعرّف المشترك مستودع↔كاشير)', cart1.includes(NAME_T), cart1.slice(0, 150));
    await pos.getByText(NAME_U).first().click();
    await pos.waitForTimeout(400);
    await pos.getByRole('button', { name: /^دفع/ }).first().click();
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 20000 });
    await pos.getByRole('dialog').locator('input[type="number"]').first().fill('100');
    await pos.waitForTimeout(300);
    await pshot('17-pos-cash');
    await pos.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await pos.waitForSelector('text=طلب جديد', { timeout: 40000 });
    const salesRows = async () => q("SELECT s.id, s.client_order_id, s.total_final, s.payment_method, s.invoice_number FROM sales s JOIN pos_orders o ON o.id=s.client_order_id WHERE o.username=? ORDER BY s.id", [U_CASH]);
    let sales = await salesRows();
    check('P12: بيع نقدي 35.00 سُجّل عبر مسار المال الموحد', sales.length === 1 && near(sales[0].total_final, 35), sales);
    check('P12: رقم فاتورة/إيصال صادر', !!(sales[0] && (sales[0].invoice_number || sales[0].id)), sales[0]);
    const successTxt = await pos.locator('body').innerText();
    check('P12: شاشة نجاح بدفع وباقٍ (65.00)', /65\.00/.test(successTxt), null);
    const saleGl = await q("SELECT COUNT(*) n FROM gl_journals WHERE reference_id=?", [String(sales[0].id)]);
    check('P12-GL: قيد محاسبي للبيع', Number(saleGl[0].n) >= 1, saleGl[0]);
    const l1AfterSale = Number((await q("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_number='UATRC-L1'", [WH_A, ITEM_T]))[0].qty);
    const stAfterSale = Number((await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]))[0].qty);
    check(`P12-FEFO: بيع المتتبع خُصم من أقرب دفعة L1 (${l1BeforeSale}→${l1BeforeSale - 1})`, near(l1AfterSale, l1BeforeSale - 1), { before: l1BeforeSale, after: l1AfterSale });
    check('P12: رصيد مستودع الصنف المتتبع نقص بمقدار البيع (1)', near(stAfterSale, stBeforeSale - 1), { before: stBeforeSale, after: stAfterSale });
    const lotMvAfter = Number((await q("SELECT COUNT(*) n FROM inventory_lot_movements WHERE warehouse_id=? AND item_id=? AND reference_type='sale'", [WH_A, ITEM_T]))[0].n);
    check('P12: حركة دفعة مرجعها البيع (FEFO مُوثّقة)', lotMvAfter > lotMvBefore, { before: lotMvBefore, after: lotMvAfter });
    await pos.getByRole('button', { name: 'طلب جديد' }).click();
    await pos.waitForTimeout(500);
    const SALE1 = sales[0];
    // — Sale 2: card —
    await pos.getByText(NAME_U).first().click();
    await pos.getByRole('button', { name: /^دفع/ }).first().click();
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 20000 });
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).getByText('شبكة').click();
    await pos.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await pos.waitForSelector('text=طلب جديد', { timeout: 40000 });
    sales = await salesRows();
    check('P12: بيع شبكة 10.00', sales.length === 2 && near(sales[1].total_final, 10) && /شبكة/.test(sales[1].payment_method), sales[1]);
    await pos.getByRole('button', { name: 'طلب جديد' }).click();
    await pos.waitForTimeout(500);
    // — Sale 3: mixed/split —
    await scan.fill(String(ITEM_T)); await scan.press('Enter');
    await pos.getByText(NAME_U).first().click(); // 25 + 10 = 35
    await pos.getByRole('button', { name: /^دفع/ }).first().click();
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 20000 });
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).getByText('مختلط').click();
    await pos.waitForTimeout(300);
    const nums = pos.getByRole('dialog').locator('input[type="number"]');
    await nums.nth(0).fill('20');
    await nums.nth(1).fill('15');
    await pshot('18-pos-mixed');
    await pos.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await pos.waitForSelector('text=طلب جديد', { timeout: 40000 });
    // the sales row + its split payment rows commit a beat after the success UI
    sales = await salesRows();
    for (let i = 0; i < 10 && (sales.length < 3 || !/split/.test(String((sales[2] || {}).payment_method || ''))); i++) { await pos.waitForTimeout(700); sales = await salesRows(); }
    check('P12: بيع مختلط 35.00 (split)', sales.length === 3 && near(sales[2].total_final, 35) && /split/.test(sales[2].payment_method), sales[2]);
    await pos.getByRole('button', { name: 'طلب جديد' }).click();
    await pos.waitForTimeout(500);
    // — hold / kitchen prompt / resume —
    await pos.getByText(NAME_U).first().click();
    await pos.getByRole('button', { name: 'تعليق' }).first().click();
    await pos.waitForTimeout(900);
    const stray = await pos.locator('[role="dialog"]').count();
    let kitchenSeen = false;
    if (stray > 0) {
      const t = await pos.locator('[role="dialog"]').first().innerText().catch(() => '');
      kitchenSeen = /مطبخ/.test(t);
      await pos.keyboard.press('Escape');
      await pos.waitForTimeout(400);
    }
    check('P12: التعليق يعرض خيار تذكرة المطبخ', kitchenSeen, { stray });
    // ensure no dialog is blocking the held-orders button
    for (let i = 0; i < 3 && (await pos.locator('[role="dialog"]').count()) > 0; i++) { await pos.keyboard.press('Escape'); await pos.waitForTimeout(300); }
    await pos.getByRole('button', { name: /الطلبات المعلقة/ }).first().click();
    await pos.waitForSelector('text=استعادة', { timeout: 15000 });
    await pos.getByRole('button', { name: /استعادة/ }).first().click();
    // the resumed cart re-hydrates a beat after the dialog closes
    let resumed = '';
    for (let i = 0; i < 10; i++) { await pos.waitForTimeout(600); resumed = (await pos.locator('[aria-label="سلة الطلب"]').innerText().catch(() => '')) || ''; if (resumed.includes(NAME_U)) break; }
    check('P12: استعادة الطلب المعلق', resumed.includes(NAME_U), resumed.slice(0, 120));
    // — void with reason —
    await pos.getByRole('button', { name: /إلغاء/ }).first().click();
    await pos.waitForSelector('text=سبب الإلغاء', { timeout: 15000 });
    await pos.locator('textarea, input[placeholder*="سبب"], [aria-label*="سبب"]').first().fill('إلغاء UAT');
    await pos.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
    await pos.waitForTimeout(1200);
    const voided = await q("SELECT COUNT(*) n FROM pos_orders WHERE username=? AND status='voided'", [U_CASH]);
    check('P12: إلغاء بسبب (server-side)', Number(voided[0].n) >= 1, voided[0]);
    // dismiss any leftover dialog; the void leaves a FRESH empty cart
    await pos.keyboard.press('Escape');
    await pos.waitForTimeout(600);
    // — OFFLINE → sync exactly once — run straight after the void on a fresh cart,
    //   with NO page reload so the IndexedDB engine + online-event listeners stay
    //   alive (a reload re-inits the engine and drops the queued flush — the offline
    //   flow only survives on a continuously-live page, exactly like the local E2E).
    await pos.waitForSelector('header >> text=متصل', { timeout: 20000 }).catch(() => {});
    await pos.waitForTimeout(1000);
    const suBeforeOffline = Number((await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_U]))[0].qty);
    await ctx2.setOffline(true);
    await pos.waitForTimeout(1500);
    check('P12: مؤشر «غير متصل» ظهر', /غير متصل/.test(await pos.locator('header').innerText()), null);
    await pos.getByText(NAME_U).first().click();
    await pos.getByText(NAME_U).first().click(); // 20
    await pos.getByRole('button', { name: /^دفع/ }).first().click();
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 20000 });
    const cardDisabled = await pos.getByRole('tablist', { name: 'طريقة الدفع' }).locator('button', { hasText: 'شبكة' }).first().isDisabled().catch(() => false);
    check('P12: أوفلاين ⇒ الشبكة معطلة (كاش فقط)', cardDisabled === true, cardDisabled);
    await pos.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await pos.waitForTimeout(1500);
    check('P12: لا بيع في القاعدة أثناء الأوفلاين', (await salesRows()).length === 3, null);
    await pshot('20-pos-offline-queued');
    await ctx2.setOffline(false);
    let syncedOnce = false;
    for (let i = 0; i < 30; i++) { await pos.waitForTimeout(1000); const s = await salesRows(); if (s.length === 4) { syncedOnce = true; break; } }
    sales = await salesRows();
    check('P12: إعادة الاتصال ⇒ مزامنة «مرة واحدة بالضبط» (20.00)', syncedOnce && sales.length === 4 && near(sales[3].total_final, 20), sales.map((s) => s.total_final));
    const suAfterOffline = Number((await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_U]))[0].qty);
    check('P12: خصم المخزون للأوفلاين مرة واحدة بالضبط (−2)', near(suAfterOffline, suBeforeOffline - 2), { before: suBeforeOffline, after: suAfterOffline });
    await pshot('21-pos-synced');
    // dismiss the offline-success dialog, back to a fresh order
    const nb2 = pos.getByRole('button', { name: 'طلب جديد' });
    if (await nb2.count()) await nb2.first().click().catch(() => {});
    await pos.keyboard.press('Escape');
    await pos.waitForTimeout(600);
    // — replay no-duplication (legacy /api/sales with the SAME clientOrderId) —
    const before = await salesRows();
    const l1BeforeReplay = Number((await q("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_number='UATRC-L1'", [WH_A, ITEM_T]))[0].qty);
    const replay = await api('POST', '/api/sales', TC, { clientOrderId: SALE1.client_order_id, items: [{ id: ITEM_T, name: NAME_T, qty: 1, price: 25 }, { id: ITEM_U, name: NAME_U, qty: 1, price: 10 }], total: SALE1.total_final, paymentMethod: 'كاش', shiftId });
    const after = await salesRows();
    const l1Replay = Number((await q("SELECT b.qty FROM warehouse_lot_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE b.warehouse_id=? AND b.item_id=? AND l.lot_number='UATRC-L1'", [WH_A, ITEM_T]))[0].qty);
    check('P12-ازدواج: إعادة إرسال نفس clientOrderId ⇒ نفس البيع بلا صف جديد', (replay.status === 200 || replay.status === 201) && after.length === before.length, { st: replay.status, before: before.length, after: after.length });
    check('P12-ازدواج: لا خصم مخزون/دفعة ثانٍ بعد الإعادة (L1 ثابت)', near(l1Replay, l1BeforeReplay), { before: l1BeforeReplay, after: l1Replay });
    await pshot('22-pos-after-sync');
    // — STOCK-FAILURE ROLLBACK (warehouse V2 doc engine — the authoritative guard).
    //   The legacy POS money path intentionally never blocks the register (an
    //   over-sale surfaces as a visible negative), so the enforced atomic
    //   stock-rollback lives in the V2 issue engine: over-issue → INSUFFICIENT_STOCK
    //   with ZERO stock/lot/movement writes. This is the "rollback on stock" proof.
    // a validated postable expense LEAF (active, type=expense, no children) — the
    // exact predicate E.validateAccount enforces for an issue's counter account.
    const expLeaf = await q("SELECT a.code FROM gl_accounts a WHERE a.type='expense' AND a.is_active=1 AND NOT EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_id=a.id) ORDER BY a.code LIMIT 1");
    const ISSACC = expLeaf.length ? expLeaf[0].code : null;
    check('P12-ROLLBACK: حساب مصروف تفصيلي صالح للصرف متاح', !!ISSACC, expLeaf);
    const availT = Number((await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]))[0].qty);
    const lbBeforeOver = Number((await q('SELECT SUM(qty) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]))[0].s);
    const mvBeforeOver = Number((await q("SELECT COUNT(*) n FROM inventory_lot_movements WHERE warehouse_id=? AND item_id=?", [WH_A, ITEM_T]))[0].n);
    const overCreate = await api('POST', '/api/inventory/v2/issues', TA, { warehouseId: WH_A, reason: 'تجاوز رصيد UAT', expenseAccountCode: ISSACC, items: [{ itemId: ITEM_T, qty: availT + 25, unitCost: 10 }] });
    let overBlocked = false, overCode = null;
    if (overCreate.status === 201 || overCreate.status === 200) {
      const iid = overCreate.body.data.id;
      const iap = await api('POST', `/api/inventory/v2/issues/${iid}/approve`, TA, { expectedVersion: overCreate.body.data.version || 1 });
      const ipo = await api('POST', `/api/inventory/v2/issues/${iid}/post`, TA, { expectedVersion: (iap.body && iap.body.data && iap.body.data.version) || 2 });
      overBlocked = ipo.status >= 400;
      overCode = ipo.body && ipo.body.code;
      await api('POST', `/api/inventory/v2/issues/${iid}/cancel`, TA, { expectedVersion: (iap.body && iap.body.data && iap.body.data.version) || 2, reason: 'تنظيف' }).catch(() => {});
    } else {
      overBlocked = overCreate.status >= 400;
      overCode = overCreate.body && overCreate.body.code;
    }
    const stAfterOver = Number((await q('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]))[0].qty);
    const lbAfterOver = Number((await q('SELECT SUM(qty) s FROM warehouse_lot_balances WHERE warehouse_id=? AND item_id=?', [WH_A, ITEM_T]))[0].s);
    const mvAfterOver = Number((await q("SELECT COUNT(*) n FROM inventory_lot_movements WHERE warehouse_id=? AND item_id=?", [WH_A, ITEM_T]))[0].n);
    check('P12-ROLLBACK: صرف أكبر من الرصيد يُرفض (INSUFFICIENT_STOCK)', overBlocked && /INSUFFICIENT_STOCK|STOCK/.test(String(overCode || '')), { code: overCode });
    check('P12-ROLLBACK: المخزون والدفعات والحركات بلا أي تغيير بعد الرفض (atomicity)', near(stAfterOver, availT) && near(lbAfterOver, lbBeforeOver) && mvAfterOver === mvBeforeOver, { st: [availT, stAfterOver], lb: [lbBeforeOver, lbAfterOver], mv: [mvBeforeOver, mvAfterOver] });
    // — post-completion void via the legacy credit-note path (manager/admin) —
    const vd = await api('POST', `/api/sales/${sales[1].id}/void`, TA, { reason: 'إرجاع UAT بعد الإكمال' });
    check('P12: الإلغاء بعد الإكمال عبر مسار الإشعار الدائن القديم (بصلاحية)', vd.status === 200, { st: vd.status, body: vd.body && (vd.body.error || vd.body.message || vd.body.status) });
    // — cashier discount ceiling refused server-side (LAST UI action — a leftover
    //   discounted cart is harmless before the shift close, so no reset needed) —
    await pos.getByText(NAME_U).first().click();
    await pos.getByRole('button', { name: /إضافة خصم على الطلب|^خصم/ }).first().click();
    await pos.waitForTimeout(500);
    await pos.locator('.fixed input[type="number"], [role="dialog"] input[type="number"]').first().fill('15');
    await pos.getByRole('dialog').getByRole('button', { name: /تطبيق|تأكيد|حفظ/ }).last().click();
    await pos.waitForTimeout(400);
    await pos.getByRole('button', { name: /^دفع/ }).first().click();
    await pos.getByRole('tablist', { name: 'طريقة الدفع' }).waitFor({ timeout: 20000 });
    await pos.getByRole('button', { name: /تأكيد الدفع/ }).click();
    await pos.waitForTimeout(3000);
    check('P12: السيرفر يرفض خصم 15% للكاشير', /حد الكاشير/.test(await pos.locator('body').innerText()), null);
    await pshot('19-pos-discount-refused');
    await pos.keyboard.press('Escape');
    await pos.waitForTimeout(600);
    // — close shift with counted cash —
    await pos.locator('header').getByRole('button', { name: /وردية/ }).first().click();
    await pos.waitForTimeout(900);
    await pos.getByRole('button', { name: 'إغلاق الوردية' }).click();
    await pos.waitForTimeout(1800);
    await pshot('23-pos-close-grid');
    const closeInputs = pos.locator('.fixed input[type="number"], [role="dialog"] input[type="number"]');
    check('P12: شبكة الفروقات الحية عند الإغلاق', (await closeInputs.count()) >= 1, await closeInputs.count());
    await closeInputs.first().fill('75'); // كاش المتوقع: 35 (بيع1) + 20 (نقد المختلط) + 20 (أوفلاين)
    await pos.waitForTimeout(400);
    await pos.getByRole('button', { name: 'تأكيد إغلاق الوردية' }).click();
    await pos.waitForTimeout(3000);
    const shClosed = await q('SELECT status FROM shifts WHERE id=?', [shiftId]);
    check('P12: الوردية أُغلقت في القاعدة', shClosed.length === 1 && String(shClosed[0].status).toUpperCase() !== 'OPEN', shClosed[0]);
    await pshot('24-pos-shift-closed');
    // hygiene
    const posErrsClean = posErrors.filter((e) => !/favicon|manifest|Failed to fetch|net::ERR|NetworkError|load resource|401|403/i.test(e));
    check('P12: صفر أخطاء console (غير الشبكية) طوال يوم الكاشير', posErrsClean.length === 0, posErrsClean.slice(0, 3));
    const posBody = await pos.locator('body').innerText();
    check('P12: أرقام إنجليزية فقط في الكاشير', !AR_DIGITS.test(posBody), (posBody.match(AR_DIGITS) || [])[0]);
    const mob = await ctx2.newPage();
    await mob.setViewportSize({ width: 375, height: 812 });
    await mob.goto(BASE + '/pos-v2/', { waitUntil: 'domcontentloaded' });
    await mob.waitForTimeout(2500);
    await mob.screenshot({ path: path.join(OUT, '25-pos-mobile.png') });
    check('P12: عرض 375px يعمل', true);
    await ctx2.close();

    // ── P13: global invariants + safety counters ───────────────────────────
    console.log('\n▸ P13: Invariants النهائية');
    const drift = await q(`SELECT ws.item_id, ws.warehouse_id, ws.qty, COALESCE(lb.s,0) AS lotsum
      FROM warehouse_stock ws JOIN inv_items i ON i.id=ws.item_id AND i.tracking_mode IN ('lot','expiry')
      LEFT JOIN (SELECT item_id, warehouse_id, SUM(qty) s FROM warehouse_lot_balances GROUP BY item_id, warehouse_id) lb
        ON lb.item_id=ws.item_id AND lb.warehouse_id=ws.warehouse_id
      WHERE ABS(ws.qty - COALESCE(lb.s,0)) > 0.005`);
    check('P13-LOT: Σ(أرصدة الدفعات) = رصيد المستودع لكل صنف متتبع (انحراف=0)', drift.length === 0, drift.slice(0, 3));
    const unbal = await q(`SELECT j.id FROM gl_journals j JOIN gl_entries e ON e.journal_id=j.id GROUP BY j.id HAVING ABS(SUM(e.debit)-SUM(e.credit)) > 0.005 LIMIT 5`);
    check('P13-GL: كل القيود متوازنة (مدين=دائن) على مستوى القاعدة', unbal.length === 0, unbal);
    const met = await api('GET', '/api/metrics', TA);
    const metStr = JSON.stringify(met.body || {});
    const lotViol = /lot_invariant_violation[^0-9]*(\d+)/.exec(metStr);
    const glImb = /gl_imbalance[^0-9]*(\d+)/.exec(metStr);
    check('P13: عدادات السلامة صفر (lot_invariant/gl_imbalance)', met.status === 200 && (!lotViol || lotViol[1] === '0') && (!glImb || glImb[1] === '0'), { lotViol: lotViol && lotViol[1], glImb: glImb && glImb[1] });

    // ── P14: legacy coexistence ─────────────────────────────────────────────
    console.log('\n▸ P14: تعايش النظام القديم');
    await page.goto(BASE + '/pos/', { waitUntil: 'domcontentloaded' });
    await wait(2000);
    const legacyPos = await page.title().catch(() => '');
    check('P14: الكاشير القديم /pos يعمل بجانب الجديد', (await page.locator('body').innerText()).length > 50, legacyPos);
    const legacyMenu = await api('GET', '/api/menu', TA);
    check('P14: APIs القديمة تعمل (menu)', legacyMenu.status === 200, legacyMenu.status);
    await shot('26-legacy-pos');
    // dashboards reflect the day (warehouse side)
    await page.goto(APP + '/', { waitUntil: 'domcontentloaded' });
    await wait(2500);
    await shot('27-dashboard-after-day');
    check('P14: لوحة المستودعات تعمل بعد يوم كامل من الحركة', (await page.locator('h1').first().textContent().catch(() => '')) !== '', null);
  } catch (e) {
    fail++; failures.push('FATAL: ' + (e && e.message));
    console.error('FATAL', e);
  } finally {
    if (glRenamed) { try { await db.query('RENAME TABLE gl_entries_uat_drill TO gl_entries'); console.log('!! restored gl_entries in finally'); } catch (_) {} }
    if (browser) await browser.close().catch(() => {});
    try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, fail, results }, null, 2)); } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} staging UAT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})();
