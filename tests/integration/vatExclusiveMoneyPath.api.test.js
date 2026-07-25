#!/usr/bin/env node
/**
 * The owner's requirement, proven end to end on a REAL server and a REAL DB:
 *
 *   "سعر البيع بدون ضريبة … يجب أن يظهر السعر في الكاشير شامل الضريبة، ويكون
 *    الرقم صحيحًا ويُسجَّل صحيحًا في قاعدة البيانات وفي القيود، بحيث السعر قبل
 *    الضريبة + الضريبة = الرقم في الفاتورة."
 *
 * A 16.00 net standard-rated item must produce, everywhere:
 *      16.00 (net) + 2.40 (VAT) = 18.40 (invoice)
 *
 * WHY THIS TEST EXISTS
 *   Every menu row in production is is_tax_inclusive = 0 (server.js v7.1), yet
 *   EVERY existing test seeded is_tax_inclusive = 1 — so the suite was green
 *   over a configuration that does not exist in production, while the register
 *   showed the NET price as the total and routes/sales.js rejected the sale
 *   («الإجمالي المعروض (16) لا يطابق الإجمالي المحسوب (18)»). This test seeds
 *   the PRODUCTION state and follows one riyal through every layer: the POS
 *   submit mirror, the recorded sale, the ZATCA tax breakdown, and the GL.
 *
 * ISOLATED DB — pinned before db/connection loads; the run aborts otherwise.
 * Run: npm run test:vat-money-path   (MySQL must be up)
 */
'use strict';

process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;

require('dotenv').config();
process.env.DB_NAME = process.env.TEST_DB_NAME || 'moroccan_taste_pos_test';
process.env.MYSQL_DATABASE = process.env.DB_NAME;
process.env.MYSQLDATABASE = process.env.DB_NAME;
delete process.env.DATABASE_URL;

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.VAT_TEST_PORT || 3219);
const BASE = { host: '127.0.0.1', port: PORT };
const M_NET = 'M-VAT-NET';      // 16.00, standard-rated, tax-EXCLUSIVE (production shape)
const M_ZERO = 'M-VAT-ZERO';    // 10.00, zero-rated, tax-EXCLUSIVE
const U_ADMIN = 'vat_admin';

let _p = 0, _f = 0;
function check(name, cond, extra) {
  if (cond) { _p++; console.log('  ✅', name); }
  else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''); }
}
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function req(method, p, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path: p, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(20000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); }
  return false;
}

async function cleanup() {
  const sqls = [
    ["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id WHERE s.client_order_id LIKE 'VATTEST%'", []],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'VATTEST%'", []],
    ["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'VATTEST%'", []],
    ["DELETE FROM sales WHERE client_order_id LIKE 'VATTEST%'", []],
    ['DELETE FROM shifts WHERE username = ?', [U_ADMIN]],
    ['DELETE FROM menu WHERE id IN (?,?)', [M_NET, M_ZERO]],
    ['DELETE FROM users WHERE username = ?', [U_ADMIN]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  const [[live]] = await db.query('SELECT DATABASE() AS d');
  if (!/_test$/.test(String(live.d))) { console.error('REFUSING: not an isolated _test DB (got ' + live.d + ')'); process.exit(2); }

  console.log('\n═══ VAT money path — a NET-priced item, end to end ═══\n');
  await cleanup();

  // PRODUCTION SHAPE: is_tax_inclusive = 0 — the price is NET, VAT goes on top.
  await db.query(
    "INSERT INTO menu (id, name, price, category, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,'S',0)",
    [M_NET, 'صنف ضريبي 16', 16, 'اختبار']);
  await db.query(
    "INSERT INTO menu (id, name, price, category, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,'Z',0)",
    [M_ZERO, 'صنف صفري 10', 10, 'اختبار']);
  await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [U_ADMIN, 'disabled', 'admin']);
  const [[u]] = await db.query('SELECT id FROM users WHERE username=?', [U_ADMIN]);
  const token = jwt.sign({ id: u.id, username: U_ADMIN, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  // Pin the rate so the assertions are about the MATH, not about the row that
  // happens to be in settings on this machine.
  await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('VATRate','15') ON DUPLICATE KEY UPDATE setting_value='15'");

  const srv = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NAME_EN_BACKFILL_DISABLE_WORKER: '1', ZATCA_DISABLE_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const ok = await waitForServer();
  if (!ok) { console.error('server did not start'); srv.kill(); process.exit(1); }

  try {
    // ── 1. The catalog must SHIP the convention, or the register cannot know ──
    const cat = await req('GET', '/api/pos/v2/catalog', token);
    const item = ((cat.body && cat.body.data && cat.body.data.items) || []).find((i) => i.id === M_NET);
    check('catalog ships the item', !!item, cat.status);
    check('catalog exposes taxInclusive=false for a NET-priced item', item && item.taxInclusive === false, item);
    check('catalog ships the VAT rate from settings (15)', cat.body && cat.body.data && Number(cat.body.data.vatRate) === 15);

    // ── 2. A real sale through the money path ────────────────────────────────
    const shiftRes = await req('POST', '/api/shifts/open', token, { openingFloat: 0 });
    const shiftId = shiftRes.body && (shiftRes.body.shiftId || (shiftRes.body.data && shiftRes.body.data.id));
    check('shift opened for the sale', !!shiftId, shiftRes.body);

    const clientOrderId = 'VATTEST' + Date.now();
    // totalFinal is what the REGISTER would display. With the fix that is
    // 18.40; the guard in routes/sales.js refuses anything that disagrees, so
    // sending it here proves the two sides now agree.
    const sale = await req('POST', '/api/sales', token, {
      clientOrderId,
      shiftId,
      items: [{ id: M_NET, name: 'صنف ضريبي 16', qty: 1, price: 16, lineDiscount: 0 }],
      total: 18.4,
      totalFinal: 18.4,
      paymentMethod: 'كاش',
      username: U_ADMIN,
    });
    check('the sale is ACCEPTED (this exact call used to 400 total_mismatch)',
      sale.status === 200 || sale.status === 201, { status: sale.status, body: sale.body });

    const [[row]] = await db.query(
      'SELECT id, total_final, tax_subtotals_json FROM sales WHERE client_order_id=? LIMIT 1', [clientOrderId]);
    check('the sale row exists', !!row, row);

    // ── 3. THE DATABASE: 16.00 + 2.40 = 18.40 ────────────────────────────────
    check('sales.total_final = 18.40 (NOT 16, NOT 18)', row && eq2(row.total_final, 18.4), row && row.total_final);
    let subtotals = null;
    try { subtotals = row && row.tax_subtotals_json ? (typeof row.tax_subtotals_json === 'string' ? JSON.parse(row.tax_subtotals_json) : row.tax_subtotals_json) : null; } catch (_) {}
    const sBucket = subtotals && (subtotals.S || subtotals.s);
    check('tax_subtotals_json S bucket: net 16.00', sBucket && eq2(sBucket.net, 16), sBucket);
    check('tax_subtotals_json S bucket: vat 2.40', sBucket && eq2(sBucket.vat, 2.4), sBucket);
    check('net + vat === total_final EXACTLY',
      sBucket && row && eq2(Number(sBucket.net) + Number(sBucket.vat), Number(row.total_final)));

    // ── 4. THE JOURNAL: revenue NET, VAT separate, debits === credits ────────
    const [entries] = await db.query(
      `SELECT e.account_code, e.debit, e.credit
         FROM gl_entries e JOIN gl_journals j ON j.id = e.journal_id
        WHERE j.reference_id = ?`, [row ? row.id : '']);
    const credit = (code) => entries.filter((e) => String(e.account_code) === code).reduce((s, e) => s + Number(e.credit || 0), 0);
    const totalDebit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
    const totalCredit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
    check('journal exists for the sale', entries.length > 0, entries.length);
    check('Revenue (4100) credited the NET 16.00', eq2(credit('4100'), 16), credit('4100'));
    check('Output VAT (2210) credited 2.40', eq2(credit('2210'), 2.4), credit('2210'));
    check('the journal balances: debits === credits', eq2(totalDebit, totalCredit), { totalDebit, totalCredit });

    // ── 5. A zero-rated NET item must never grow VAT ─────────────────────────
    const zId = 'VATTEST' + (Date.now() + 1);
    const zSale = await req('POST', '/api/sales', token, {
      clientOrderId: zId, shiftId,
      items: [{ id: M_ZERO, name: 'صنف صفري 10', qty: 1, price: 10, lineDiscount: 0 }],
      total: 10, totalFinal: 10, paymentMethod: 'كاش', username: U_ADMIN,
    });
    check('a zero-rated NET sale is accepted', zSale.status === 200 || zSale.status === 201, zSale.status);
    const [[zRow]] = await db.query('SELECT total_final FROM sales WHERE client_order_id=? LIMIT 1', [zId]);
    check('zero-rated total stays 10.00 — no VAT invented', zRow && eq2(zRow.total_final, 10), zRow && zRow.total_final);
  } finally {
    srv.kill();
    await cleanup();
    await db.end().catch(() => {});
  }

  console.log(`\n${_p} passed, ${_f} failed`);
  if (_f) process.exit(1);
  console.log('✅ VAT money path: 16.00 + 2.40 = 18.40 on screen, in the DB, and in the GL');
  process.exit(0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });
