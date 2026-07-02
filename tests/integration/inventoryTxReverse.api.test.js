/**
 * Phase 3C closure — reverse-after-later-movements correctness (ENFORCE=0).
 *
 * The 3B reverse uses the FROZEN posted_unit_cost. This test proves a reverse
 * stays correct when OTHER movements happened between post and reverse, and that
 * an illogical reverse (one that would drive qty/value negative) is blocked.
 *
 *   chain 1  receipt → issue → reverse-receipt   (decrease after a later issue)
 *   chain 2  issue → receipt → reverse-issue     (add-back recomputes WAC)
 *   chain 3  adjustment(−) → receipt → reverse-adjustment
 *   chain 4  adjustment(+) → issue → reverse-adjustment BLOCKED (would go negative)
 *
 * Run: node tests/integration/inventoryTxReverse.api.test.js
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.INVTX_REV_TEST_PORT || 3219);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-REV';
const I1 = 'REV-I1', I2 = 'REV-I2', I3 = 'REV-I3', I4 = 'REV-I4';
const ACC_REV = '4910', ACC_EXP = '5300';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.02 : tol); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function qty(item) { const [r] = await db.query('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].qty) : 0; }
async function wac(item) { const [r] = await db.query('SELECT avg_cost FROM warehouse_stock WHERE warehouse_id=? AND item_id=?', [WH, item]); return r.length ? Number(r[0].avg_cost) : 0; }
async function glBalanced(journalId) { const [r] = await db.query('SELECT total_debit, total_credit FROM gl_journals WHERE id=?', [journalId]); return r.length ? near(r[0].total_debit, r[0].total_credit, 0.01) : false; }

const R = '/api/inventory/v2/receipts', I = '/api/inventory/v2/issues', A = '/api/inventory/v2/adjustments';
async function postReceipt(token, item, qy, cost) {
  const c = await req('POST', R, token, { warehouseId: WH, reason: 'اختبار', counterAccountCode: ACC_REV, items: [{ itemId: item, qty: qy, unitCost: cost }] });
  await req('POST', `${R}/${c.body.id}/approve`, token, {});
  await req('POST', `${R}/${c.body.id}/post`, token, {});
  return c.body.id;
}
async function postIssue(token, item, qy) {
  const c = await req('POST', I, token, { warehouseId: WH, reason: 'صرف اختبار', expenseAccountCode: ACC_EXP, items: [{ itemId: item, qty: qy }] });
  await req('POST', `${I}/${c.body.id}/approve`, token, {});
  await req('POST', `${I}/${c.body.id}/post`, token, {});
  return c.body.id;
}
async function postAdjustment(token, item, counted) {
  const c = await req('POST', A, token, { warehouseId: WH, reason: 'جرد اختبار', referenceEvidence: 'EVID', items: [{ itemId: item, countedQty: counted }] });
  await req('POST', `${A}/${c.body.id}/approve`, token, {});
  await req('POST', `${A}/${c.body.id}/post`, token, {});
  return c.body.id;
}

async function cleanup() {
  const sqls = [
    ["DELETE e FROM inv_tx_events e JOIN inv_receipts d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE e FROM inv_tx_events e JOIN inv_issues d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WH]],
    ["DELETE e FROM inv_tx_events e JOIN inv_adjustments d ON d.id=e.doc_id WHERE d.warehouse_id=?", [WH]],
    ['DELETE i FROM inv_receipt_items i JOIN inv_receipts d ON d.id=i.receipt_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE i FROM inv_issue_items i JOIN inv_issues d ON d.id=i.issue_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE i FROM inv_adjustment_items i JOIN inv_adjustments d ON d.id=i.adjustment_id WHERE d.warehouse_id=?', [WH]],
    ['DELETE FROM inv_receipts WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_issues WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_adjustments WHERE warehouse_id=?', [WH]],
    ["DELETE FROM inventory_movements WHERE reference_type LIKE 'inv\\_%' AND warehouse_id=?", [WH]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inv_items WHERE id IN (?,?,?,?)', [I1, I2, I3, I4]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, 'REV', 'مستودع العكس', 'main']);
  for (const it of [I1, I2, I3, I4]) await db.query('INSERT INTO inv_items (id,name,category,unit,cost,min_stock,active) VALUES (?,?,?,?,?,?,1)', [it, 'صنف ' + it, 'خام', 'كجم', 5, 0]);
  for (const [it, q] of [[I1, 100], [I2, 100], [I3, 100], [I4, 10]]) {
    await db.query('INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost,first_added_date) VALUES (?,?,?,?,?,NOW())', ['WS-' + it, WH, it, q, 5]);
  }
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Reverse-after-later-movements — integration ═══\n');
  await seed();
  const admin = tok(0, 'invtxrev_admin', 'admin', true);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), WAREHOUSE_SCOPE_ENFORCE: '0' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── chain 1: receipt(50@7) → issue(30) → reverse receipt ──────────────
    const r1 = await postReceipt(admin, I1, 50, 7);   // qty 150, WAC 5.6667
    check('c1 receipt → qty 150, WAC 5.6667', (await qty(I1)) === 150 && near(await wac(I1), 5.6667, 0.0002), { q: await qty(I1), w: await wac(I1) });
    await postIssue(admin, I1, 30);                    // qty 120
    check('c1 issue → qty 120', (await qty(I1)) === 120, await qty(I1));
    const rev1 = await req('POST', `${R}/${r1}/reverse`, admin, { reason: 'عكس بعد صرف' });
    check('c1 reverse receipt → 200, qty 70 (−50 frozen)', rev1.status === 200 && (await qty(I1)) === 70, { st: rev1.status, q: await qty(I1) });
    check('c1 WAC stays 5.6667 (decrease leaves WAC), carrying ≥ 0', near(await wac(I1), 5.6667, 0.0002) && (await qty(I1)) * (await wac(I1)) >= 0, { w: await wac(I1) });
    check('c1 reverse GL balanced', rev1.body && rev1.body.journalId ? await glBalanced(rev1.body.journalId) : false, rev1.body && rev1.body.journalId);

    // ── chain 2: issue(30) → receipt(20@8) → reverse issue ────────────────
    const i2 = await postIssue(admin, I2, 30);         // qty 70, WAC 5.0
    await postReceipt(admin, I2, 20, 8);               // qty 90, WAC (350+160)/90=5.6667
    check('c2 after issue+receipt → qty 90, WAC 5.6667', (await qty(I2)) === 90 && near(await wac(I2), 5.6667, 0.0002), { q: await qty(I2), w: await wac(I2) });
    const rev2 = await req('POST', `${I}/${i2}/reverse`, admin, { reason: 'إرجاع صرف بعد استلام' });
    // add 30 back at frozen 5.0 → WAC=(90*5.6667+30*5)/120 = 660/120 = 5.5
    check('c2 reverse issue → qty 120, WAC 5.5 (add-back recomputes)', rev2.status === 200 && (await qty(I2)) === 120 && near(await wac(I2), 5.5, 0.01), { st: rev2.status, q: await qty(I2), w: await wac(I2) });
    check('c2 reverse GL balanced', rev2.body && rev2.body.journalId ? await glBalanced(rev2.body.journalId) : false, rev2.body && rev2.body.journalId);

    // ── chain 3: adjustment(counted 90 → −10) → receipt(40@6) → reverse adj ─
    const a3 = await postAdjustment(admin, I3, 90);    // qty 90, WAC 5.0
    check('c3 adjustment −10 → qty 90', (await qty(I3)) === 90, await qty(I3));
    await postReceipt(admin, I3, 40, 6);               // qty 130, WAC (450+240)/130=5.3077
    const rev3 = await req('POST', `${A}/${a3}/reverse`, admin, { reason: 'عكس تعديل بعد استلام' });
    // undo −10 → +10 at frozen 5.0 → qty 140
    check('c3 reverse adjustment → qty 140 (+10 frozen)', rev3.status === 200 && (await qty(I3)) === 140, { st: rev3.status, q: await qty(I3) });
    check('c3 reverse GL balanced', rev3.body && rev3.body.journalId ? await glBalanced(rev3.body.journalId) : false, rev3.body && rev3.body.journalId);

    // ── chain 4: adjustment(counted 30 → +20) → issue(25) → reverse BLOCKED ─
    const a4 = await postAdjustment(admin, I4, 30);    // qty 30 (10 + 20)
    check('c4 positive adjustment +20 → qty 30', (await qty(I4)) === 30, await qty(I4));
    await postIssue(admin, I4, 25);                    // qty 5
    const qBefore = await qty(I4);
    const rev4 = await req('POST', `${A}/${a4}/reverse`, admin, { reason: 'محاولة عكس غير منطقية' });
    check('c4 reverse +20 after consuming down to 5 → BLOCKED (422 INSUFFICIENT_STOCK)', rev4.status === 422 && rev4.body.code === 'INSUFFICIENT_STOCK', rev4.body && rev4.body.code);
    check('c4 blocked reverse left stock unchanged (rollback)', (await qty(I4)) === qBefore, { before: qBefore, after: await qty(I4) });

  } catch (e) {
    _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e);
  } finally {
    try { server.kill(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
