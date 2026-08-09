/**
 * Cashier V2 — integration test (REAL server, REAL legacy sale composition).
 *
 * Boots server.js and exercises /api/pos/v2 end-to-end:
 *   • catalog (+ETag 304), server-computed totals (inclusive VAT S/Z),
 *   • upsert create/update with version guard (stale → 409), owner isolation
 *     (another cashier → 403, supervisor OK),
 *   • hold → resume, edit-while-held blocked, void needs a reason + terminal,
 *   • submit guards: no shift, payment mismatch, cashier discount ceiling,
 *     credit sale needs supervisor,
 *   • THE REAL CHECKOUT LOOP: submit → legacyPayload → POST /api/sales with
 *     clientOrderId (idempotent replay on double-POST) → complete link
 *     (idempotent; wrong saleId → conflict) → shift summary reflects it,
 *   • reopen clears payments, sync batch replay (opId dedupe, per-op errors),
 *   • RBAC: warehouse-only role gets 403 on POS endpoints.
 *
 * Run: node tests/integration/posV2.api.test.js  (MariaDB on 3307)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.POSV2_TEST_PORT || 3215);
const BASE = { host: '127.0.0.1', port: PORT };
const API = '/api/pos/v2';
const M1 = 'M-POS-1', M2 = 'M-POS-2', M3 = 'M-POS-3';
const U_C1 = 'pos_cash1', U_C2 = 'pos_cash2', U_MGR = 'pos_mgr', U_EMP = 'pos_emp';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } }
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;
function ulid(n) { return 'POSTEST' + String(n) + Math.random().toString(36).slice(2, 10).toUpperCase(); }

function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, headers: resp.headers }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 120; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function cleanup() {
  const sqls = [
    ["DELETE si FROM sales_items si JOIN sales s ON s.id=si.order_id WHERE s.client_order_id LIKE 'POSTEST%'", []],
    ["DELETE e FROM gl_entries e JOIN gl_journals j ON j.id=e.journal_id JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'POSTEST%'", []],
    ["DELETE j FROM gl_journals j JOIN sales s ON s.id=j.reference_id WHERE s.client_order_id LIKE 'POSTEST%'", []],
    ["DELETE FROM sales WHERE client_order_id LIKE 'POSTEST%'", []],
    ["DELETE p FROM pos_payments p JOIN pos_orders o ON o.id=p.order_id WHERE o.id LIKE 'POSTEST%'", []],
    ["DELETE l FROM pos_order_lines l JOIN pos_orders o ON o.id=l.order_id WHERE o.id LIKE 'POSTEST%'", []],
    ["DELETE FROM pos_orders WHERE id LIKE 'POSTEST%'", []],
    ['DELETE FROM shifts WHERE username IN (?,?,?)', [U_C1, U_C2, U_MGR]],
    ['DELETE FROM idempotency_keys WHERE username IN (?,?,?,?)', [U_C1, U_C2, U_MGR, U_EMP]],
    ['DELETE FROM menu WHERE id IN (?,?,?)', [M1, M2, M3]],
    ['DELETE FROM users WHERE username IN (?,?,?,?)', [U_C1, U_C2, U_MGR, U_EMP]],
  ];
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}

async function seed() {
  await cleanup();
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'S')", [M1, 'شاي أتاي', 23, 'مشروبات']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,1,'Z')", [M2, 'ماء', 10, 'مشروبات']);
  await db.query("INSERT INTO menu (id, name, price, category, active, tax_category) VALUES (?,?,?,?,0,'S')", [M3, 'صنف موقوف', 15, 'مشروبات']);
  const ids = {};
  for (const [u, role] of [[U_C1, 'cashier'], [U_C2, 'cashier'], [U_MGR, 'manager'], [U_EMP, 'employee']]) {
    await db.query('INSERT INTO users (username,password,role) VALUES (?,?,?)', [u, 'disabled', role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  return ids;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Cashier V2 — integration (real /api/sales composition) ═══\n');
  const ids = await seed();
  const c1 = tok(ids[U_C1], U_C1, 'cashier');
  const c2 = tok(ids[U_C2], U_C2, 'cashier');
  const mgr = tok(ids[U_MGR], U_MGR, 'manager');
  const emp = tok(ids[U_EMP], U_EMP, 'employee');

  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), POS_MAX_CASHIER_DISCOUNT_PCT: '10' }, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── 1) Catalog + ETag ────────────────────────────────────────────────────
    console.log('▸ catalog');
    let r = await req('GET', API + '/catalog', c1);
    check('catalog → items + vatRate + categories', r.status === 200 && r.body.data.items.some((i) => i.id === M1) && r.body.data.vatRate === 15, r.status);
    check('catalog marks inactive item', r.body.data.items.find((i) => i.id === M3).active === false, null);
    const etag = r.headers.etag;
    r = await req('GET', API + '/catalog', c1, undefined, { 'If-None-Match': etag });
    check('catalog If-None-Match → 304', r.status === 304, r.status);
    r = await req('GET', API + '/catalog', emp);
    check('warehouse-only role → 403 on POS', r.status === 403, r.status);

    // ── 2) Upsert + totals + version guard + ownership ──────────────────────
    console.log('▸ upsert / totals / ownership');
    const O1 = ulid(1);
    const cart1 = { id: O1, orderType: 'dine_in', tableNo: '5', lines: [{ menuId: M1, qty: 2 }, { menuId: M2, qty: 3 }] };
    r = await req('POST', API + '/orders', c1, cart1);
    check('create draft → 201 v1', r.status === 201 && r.body.data.version === 1, r.body);
    check('totals server-side: subtotal 76, vat 6 (S فقط)', near(r.body.data.totals.subtotal, 76) && near(r.body.data.totals.vatTotal, 6), r.body.data.totals);
    r = await req('POST', API + '/orders', c1, { ...cart1, lines: [{ menuId: M1, qty: 1 }], expectedVersion: 99 });
    check('stale version update → 409', r.status === 409 && r.body.code === 'VERSION_CONFLICT', r.body);
    r = await req('POST', API + '/orders', c2, { ...cart1, expectedVersion: 1 });
    check('another cashier updating → 403 ownership code', r.status === 403 && r.body.code === 'ORDER_OWNERSHIP_CONFLICT', r.body);
    r = await req('POST', API + '/orders', c1, { ...cart1, lines: [{ menuId: M1, qty: 2 }, { menuId: M2, qty: 3 }], expectedVersion: 1 });
    check('owner update → v2', r.status === 200 && r.body.data.version === 2, r.body);
    r = await req('POST', API + '/orders', c1, { id: ulid(9), lines: [{ menuId: M3, qty: 1 }] });
    check('inactive item rejected', r.status === 422, r.body && r.body.error);
    r = await req('POST', API + '/orders', c1, { id: ulid(8), lines: [{ menuId: M1, qty: 0 }] });
    check('zero qty rejected', r.status === 422, r.body && r.body.code);

    // ── 3) hold / resume / void rules ────────────────────────────────────────
    console.log('▸ hold / resume / void');
    r = await req('POST', API + `/orders/${O1}/hold`, c1, { expectedVersion: 2 });
    check('hold → held v3', r.status === 200 && r.body.status === 'held', r.body);
    r = await req('POST', API + '/orders', c1, { ...cart1, expectedVersion: 3 });
    check('edit while held → 422 INVALID_STATE_TRANSITION', r.status === 422 && r.body.code === 'INVALID_STATE_TRANSITION', r.body);
    r = await req('POST', API + `/orders/${O1}/resume`, c1, { deviceId: 'DEV-2' });
    check('resume → open (device stamped)', r.status === 200 && r.body.status === 'open', r.body);
    const OV = ulid(2);
    await req('POST', API + '/orders', c1, { id: OV, lines: [{ menuId: M2, qty: 1 }] });
    r = await req('POST', API + `/orders/${OV}/void`, c1, {});
    check('void without reason → 422', r.status === 422, r.body);
    r = await req('POST', API + `/orders/${OV}/void`, c1, { reason: 'خطأ إدخال' });
    check('void with reason → voided', r.status === 200 && r.body.status === 'voided', r.body);
    r = await req('POST', API + `/orders/${OV}/resume`, c1, {});
    check('voided is terminal', r.status === 422, r.body);

    // ── 4) submit guards ─────────────────────────────────────────────────────
    console.log('▸ submit guards');
    r = await req('POST', API + `/orders/${O1}/submit`, c1, { payments: [{ method: 'cash', amount: 76 }] });
    check('submit without shift → 422 (وردية)', r.status === 422 && /وردية/.test(r.body.error), r.body);
    // Open a REAL shift for the cashier via the legacy endpoint.
    r = await req('POST', '/api/shifts/open', c1, { device: { ua: 'posv2-test' } });
    const shiftId = r.body && (r.body.shiftId || (r.body.data && r.body.data.shiftId));
    check('legacy shift opened', r.status === 200 && !!shiftId, r.body);
    r = await req('POST', API + '/orders', c1, { ...cart1, shiftId, expectedVersion: 4 });
    check('attach shift to order → v5', r.status === 200 && r.body.data.version === 5, r.body);
    r = await req('POST', API + `/orders/${O1}/submit`, c1, { payments: [{ method: 'cash', amount: 50 }], expectedVersion: 5 });
    check('payment mismatch → PAYMENT_MISMATCH', r.status === 422 && r.body.code === 'PAYMENT_MISMATCH', r.body);
    // Cashier discount ceiling (10%): 15% order discount must be refused.
    const OD = ulid(3);
    await req('POST', API + '/orders', c1, { id: OD, shiftId, discountType: 'PERCENT', discountValue: 15, lines: [{ menuId: M1, qty: 2 }] });
    r = await req('POST', API + `/orders/${OD}/submit`, c1, { payments: [{ method: 'cash', amount: 39.1 }] });
    check('cashier 15% discount → 403 ceiling', r.status === 403 && /حد الكاشير/.test(r.body.error), r.body);
    r = await req('POST', API + `/orders/${OD}/void`, mgr, { reason: 'اختبار' });
    check('supervisor can void another cashier\'s order', r.status === 200, r.body);
    // Credit sale needs supervisor.
    const OC = ulid(4);
    await req('POST', API + '/orders', c1, { id: OC, shiftId, lines: [{ menuId: M2, qty: 2 }] });
    r = await req('POST', API + `/orders/${OC}/submit`, c1, { payments: [{ method: 'credit', amount: 20 }] });
    check('credit sale by cashier → 403', r.status === 403, r.body);
    await req('POST', API + `/orders/${OC}/void`, c1, { reason: 'اختبار' });

    // ── 5) THE REAL CHECKOUT LOOP ────────────────────────────────────────────
    console.log('▸ checkout loop (submit → /api/sales → complete)');
    r = await req('POST', API + `/orders/${O1}/submit`, c1, { payments: [{ method: 'cash', amount: 46 }, { method: 'card', amount: 30 }], cashTendered: 50, changeDue: 4 }, { 'Idempotency-Key': 'pos-sub-1' });
    check('submit (split cash+card) → submitted + legacyPayload', r.status === 200 && r.body.status === 'submitted' && r.body.data.legacyPayload, r.body && r.body.code);
    const payload = r.body.data.legacyPayload;
    check('legacyPayload: clientOrderId=order, split mapped', payload.clientOrderId === O1 && payload.paymentMethod === 'split' && payload.splitDetails.length === 2, payload);
    check('legacyPayload totals: 76/76', near(payload.total, 76) && near(payload.totalFinal, 76), payload);
    // Idempotency replay of submit
    const r2 = await req('POST', API + `/orders/${O1}/submit`, c1, { payments: [{ method: 'cash', amount: 46 }, { method: 'card', amount: 30 }], cashTendered: 50, changeDue: 4 }, { 'Idempotency-Key': 'pos-sub-1' });
    check('submit replay (same key) → 200 same payload', r2.status === 200 && r2.body.data.legacyPayload.clientOrderId === O1, r2.status);
    // POST the legacy sale — THE money write.
    r = await req('POST', '/api/sales', c1, payload);
    check('legacy /api/sales accepts the payload', r.status === 200 || r.status === 201, { status: r.status, body: r.body && (r.body.error || r.body.orderId) });
    const saleId = r.body && (r.body.orderId || r.body.id);
    check('sale id returned', !!saleId, r.body);
    // ── Root-cause fix for the inherited "byStatus.completed undefined @ ~228" red ──
    // The shift-summary handler (routes/pos-v2.js:542) is CORRECT: it groups
    // pos_orders by status for the shift, and the only completed order this flow
    // creates is O1 (total 76, payments cash 46 + card 30) — so the summary
    // expectation below is right and is NOT weakened. The actual defect was here:
    // when POST /api/sales fails (environment/config — the O2C-era checkout has
    // extra server-side legs), `saleId` is undefined, and every dependent step
    // then FAILS SOFTLY: `{ saleId: undefined }` serializes to `{}` (→ 422), and
    // mysql2's text protocol binds an undefined param as NULL (→ 0 rows, no
    // throw). The run limped on until the summary check's deep dereference —
    // `byStatus.completed.amount` — threw a TypeError that blamed shift-summary
    // for a checkout failure two sections earlier. Fail HERE, at the true first
    // divergence, with the server's actual error body.
    if (!saleId) {
      throw new Error('checkout leg failed: POST /api/sales returned no orderId — HTTP '
        + r.status + ' ' + JSON.stringify(r.body).slice(0, 500));
    }
    // Double-POST the SAME payload → idempotent replay, same sale.
    r = await req('POST', '/api/sales', c1, payload);
    check('duplicate /api/sales → idempotent same sale', (r.status === 200) && r.body.idempotent === true && (r.body.orderId === saleId), r.body);
    // Complete link is ownership-protected too. Before this fix the final
    // lifecycle endpoint had no owner guard at all.
    r = await req('POST', API + `/orders/${O1}/complete`, c2, { saleId });
    check('another cashier cannot complete the order', r.status === 403 && r.body.code === 'ORDER_OWNERSHIP_CONFLICT', r.body);
    // Complete link.
    r = await req('POST', API + `/orders/${O1}/complete`, c1, { saleId });
    check('complete → completed', r.status === 200 && r.body.status === 'completed', r.body);
    r = await req('POST', API + `/orders/${O1}/complete`, c1, { saleId });
    check('complete replay → idempotent', r.status === 200 && r.body.idempotent === true, r.body);
    r = await req('POST', API + `/orders/${O1}/complete`, c1, { saleId: 'SALE-WRONG' });
    check('complete with different saleId → conflict', r.status === 409 || r.status === 422, r.body && r.body.code);
    // The linked sale row really exists with our clientOrderId.
    const [saleRow] = await db.query('SELECT id, client_order_id, total_final FROM sales WHERE id=?', [saleId]);
    check('sales row exists + linked (total 76)', saleRow.length === 1 && saleRow[0].client_order_id === O1 && near(saleRow[0].total_final, 76), saleRow[0]);

    // ── 6) reopen clears payments ────────────────────────────────────────────
    console.log('▸ reopen / sync / summary');
    const OR = ulid(5);
    await req('POST', API + '/orders', c1, { id: OR, shiftId, lines: [{ menuId: M2, qty: 2 }] });
    await req('POST', API + `/orders/${OR}/submit`, c1, { payments: [{ method: 'cash', amount: 20 }] });
    r = await req('POST', API + `/orders/${OR}/reopen`, c1, {});
    check('reopen → open', r.status === 200 && r.body.status === 'open', r.body);
    const [payRows] = await db.query('SELECT COUNT(*) AS n FROM pos_payments WHERE order_id=?', [OR]);
    check('reopen cleared payments', Number(payRows[0].n) === 0, payRows[0]);

    // ── 7) offline sync batch (replay-safe) ──────────────────────────────────
    const OS = ulid(6);
    const ops = [
      { opId: 'op-sync-1', type: 'upsert', payload: { id: OS, shiftId, lines: [{ menuId: M1, qty: 1 }] } },
      { opId: 'op-sync-2', type: 'hold', orderId: OS, payload: {} },
      { opId: 'op-sync-3', type: 'bogus', orderId: OS, payload: {} },
    ];
    r = await req('POST', API + '/sync', c1, { ops });
    check('sync: upsert+hold ok, bogus fails per-op', r.body.results[0].ok && r.body.results[1].ok && !r.body.results[2].ok, r.body.results && r.body.results.map((x) => x.ok));
    const [vBefore] = await db.query('SELECT version, status FROM pos_orders WHERE id=?', [OS]);
    r = await req('POST', API + '/sync', c1, { ops: ops.slice(0, 2) });
    check('sync replay (same opIds) → replay:true, no re-execution', r.body.results.every((x) => x.ok && x.replay === true), r.body.results);
    const [vAfter] = await db.query('SELECT version, status FROM pos_orders WHERE id=?', [OS]);
    check('replayed sync did not change the order', vBefore[0].version === vAfter[0].version && vBefore[0].status === vAfter[0].status, { before: vBefore[0], after: vAfter[0] });

    // ── 8) shift summary ─────────────────────────────────────────────────────
    r = await req('GET', API + '/shift-summary/' + shiftId, c1);
    // Same assertion strength as before — completed amount 76, cash 46, card 30 —
    // PLUS the completed count (=1) the old check's label promised but never
    // asserted. Optional chaining only turns a missing key into a normal failed
    // check that prints the real payload, instead of a run-killing TypeError.
    const sum = (r.body && r.body.data) || {};
    check('shift summary: 1 completed = 76 (cash 46 + card 30)', r.status === 200
      && sum.byStatus?.completed?.count === 1
      && near(sum.byStatus?.completed?.amount, 76)
      && near(sum.completedByMethod?.cash, 46)
      && near(sum.completedByMethod?.card, 30), r.body && r.body.data);
  } finally {
    try { server.kill(); } catch (_) {}
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  console.log(`\n${_f === 0 ? '✅' : '❌'} posV2.api: ${_p} passed, ${_f} failed\n`);
  process.exit(_f === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
