/**
 * Phase 4B — Lots API (list/detail/trace/lifecycle/expiry/integrity) ENFORCE off.
 * Run: node tests/integration/lotIntegrity.api.test.js  (NOT in `npm test`)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.LOTI_TEST_PORT || 3275);
const BASE = { host: '127.0.0.1', port: PORT };
const WH = 'WH-4BI';
const T = 'LOTI-T';
const ADMIN = 'loti_admin';
const V2 = '/api/inventory/v2';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }
function dplus(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function req(method, path, token, body, headers) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({ Accept: 'application/json' }, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ ...BASE, method, path, headers: h }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, body: j, raw: b }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code })); r.setTimeout(9000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
async function waitForServer() { for (let i = 0; i < 90; i++) { const r = await req('GET', '/api/version'); if (r.status) return true; await new Promise((z) => setTimeout(z, 500)); } return false; }
function tok(id, u, role, dev) { return jwt.sign({ id, username: u, role, isDeveloper: !!dev }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

async function cleanup() {
  for (const [s, p] of [
    ['DELETE FROM inv_tx_events WHERE doc_type=? AND doc_id LIKE ?', ['lot', 'LOTI-%']],
    ['DELETE FROM inventory_lot_movements WHERE warehouse_id=?', [WH]],
    ['DELETE FROM warehouse_lot_balances WHERE warehouse_id=?', [WH]],
    ['DELETE FROM inventory_lots WHERE item_id=?', [T]],
    ['DELETE FROM warehouse_stock WHERE warehouse_id=?', [WH]],
    ['DELETE FROM idempotency_keys WHERE username=?', [ADMIN]],
    ['DELETE FROM inv_items WHERE id=?', [T]],
    ['DELETE FROM warehouses WHERE id=?', [WH]],
    ['DELETE FROM users WHERE username=?', [ADMIN]],
  ]) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO warehouses (id,code,name,type,is_active,is_main) VALUES (?,?,?,?,1,1)', [WH, '4BI', 'مستودع الدفعات', 'main']);
  await db.query("INSERT INTO inv_items (id,name,category,unit,cost,active) VALUES (?,?,?,?,?,1)", [T, 'صنف تتبع', 'خام', 'كجم', 5]);
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Lots API — list/trace/lifecycle/expiry/integrity ═══\n');
  await seed();
  const admin = tok(0, ADMIN, 'admin', true);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }
    await db.query("UPDATE inv_items SET tracking_mode='expiry' WHERE id=?", [T]);
    // Lots: A (near, +10), B (expired, -5), C (safe, +200). Balances + a movement on A.
    for (const [lid, exp] of [['LIA', dplus(10)], ['LIB', dplus(-5)], ['LIC', dplus(200)]]) {
      await db.query("INSERT INTO inventory_lots (id,item_id,lot_number,lot_norm,expiry_date,lifecycle_status,unit_cost,version) VALUES (?,?,?,?,?, 'active',5,1)", [lid, T, lid, lid, exp]);
      await db.query('INSERT INTO warehouse_lot_balances (id,warehouse_id,lot_id,item_id,qty) VALUES (?,?,?,?,?)', ['B' + lid, WH, lid, T, 10]);
    }
    await db.query("INSERT INTO warehouse_stock (id,warehouse_id,item_id,qty,avg_cost) VALUES ('WSI',?,?,30,5)", [WH, T]);
    await db.query("INSERT INTO inventory_lot_movements (id,lot_id,warehouse_id,item_id,signed_qty,reference_type,reference_id,occurred_at) VALUES ('ILMI-1','LIA',?,?,10,'inv_receipt','RCV-X',NOW())", [WH, T]);

    // 1) list
    const list = await req('GET', `${V2}/lots?itemId=${T}`, admin);
    check('GET /lots → 3 rows with expiry class', list.status === 200 && (list.body.data || []).length === 3 && list.body.data.every((d) => d.expiryClass), { st: list.status, n: (list.body.data || []).length });
    const expiredRow = (list.body.data || []).find((d) => d.id === 'LIB');
    check('LIB classified expired', expiredRow && expiredRow.expiryClass === 'expired', expiredRow && expiredRow.expiryClass);
    const risk = await req('GET', `${V2}/lots?itemId=${T}&risk=expired`, admin);
    check('risk=expired filter → only LIB', risk.status === 200 && (risk.body.data || []).length === 1 && risk.body.data[0].id === 'LIB', risk.body && risk.body.data);

    // 2) create + duplicate
    const cre = await req('POST', `${V2}/lots`, admin, { itemId: T, lotNumber: 'MANUAL-1', expiryDate: dplus(60) }, { 'Idempotency-Key': 'loti-c' });
    check('POST /lots create → 201', cre.status === 201 && cre.body.id, cre.body);
    const dup = await req('POST', `${V2}/lots`, admin, { itemId: T, lotNumber: ' manual-1 ', expiryDate: dplus(60) });
    check('duplicate lot number (case/space) → 422', dup.status === 422, dup.body && dup.body.code);

    // 3) detail
    const det = await req('GET', `${V2}/lots/LIA`, admin);
    check('GET /lots/:id → detail + distribution', det.status === 200 && det.body.data && Array.isArray(det.body.distribution) && det.body.distribution[0].qty === 10, { st: det.status });

    // 4) PATCH expiry after a movement → TRACKING_MODE_LOCKED; notes allowed
    const pe = await req('PATCH', `${V2}/lots/LIA`, admin, { expiryDate: dplus(99), expectedVersion: 1 });
    check('PATCH expiry after movement → 422 TRACKING_MODE_LOCKED', pe.status === 422 && pe.body.code === 'TRACKING_MODE_LOCKED', pe.body && pe.body.code);
    const pn = await req('PATCH', `${V2}/lots/LIA`, admin, { notes: 'ملاحظة', expectedVersion: 1 });
    check('PATCH notes → 200', pn.status === 200, pn.body && pn.body.code);

    // 5) movements + trace
    const mv = await req('GET', `${V2}/lots/LIA/movements`, admin);
    check('GET /lots/:id/movements → 1 row', mv.status === 200 && (mv.body.data || []).length === 1, mv.body && (mv.body.data || []).length);
    const tr = await req('GET', `${V2}/lots/LIA/trace`, admin);
    check('GET /lots/:id/trace → lot + warehouses + timeline', tr.status === 200 && tr.body.lot && Array.isArray(tr.body.warehouses) && Array.isArray(tr.body.timeline), { st: tr.status });

    // 6) lifecycle quarantine → release → recall (reason + version)
    const noReason = await req('POST', `${V2}/lots/LIC/quarantine`, admin, { expectedVersion: 1 });
    check('quarantine without reason → 422', noReason.status === 422, noReason.body && noReason.body.code);
    const qn = await req('POST', `${V2}/lots/LIC/quarantine`, admin, { reason: 'فحص جودة', expectedVersion: 1 });
    check('quarantine → quarantined v2', qn.status === 200 && qn.body.status === 'quarantined' && qn.body.version === 2, qn.body);
    const rel = await req('POST', `${V2}/lots/LIC/release`, admin, { reason: 'اجتاز الفحص', expectedVersion: 2 });
    check('release → active v3', rel.status === 200 && rel.body.status === 'active' && rel.body.version === 3, rel.body);
    const rec = await req('POST', `${V2}/lots/LIC/recall`, admin, { reason: 'استدعاء', expectedVersion: 3 });
    check('recall → recalled v4', rec.status === 200 && rec.body.status === 'recalled', rec.body);
    const relBad = await req('POST', `${V2}/lots/LIC/release`, admin, { reason: 'x', expectedVersion: 4 });
    check('release from recalled → 422 INVALID_STATE_TRANSITION', relBad.status === 422 && relBad.body.code === 'INVALID_STATE_TRANSITION', relBad.body && relBad.body.code);

    // 7) expiry + summary
    const exp = await req('GET', `${V2}/expiry?warehouseId=${WH}`, admin);
    check('GET /expiry → rows classified', exp.status === 200 && (exp.body.data || []).length >= 2 && exp.body.data.some((d) => d.expiryClass === 'expired'), { st: exp.status });
    const sum = await req('GET', `${V2}/expiry/summary?warehouseId=${WH}`, admin);
    check('GET /expiry/summary → byClass with expired ≥ 1', sum.status === 200 && sum.body.data.byClass.expired >= 1, sum.body && sum.body.data);

    // 8) FEFO suggest
    const sug = await req('GET', `${V2}/lot-allocation/suggest?warehouseId=${WH}&itemId=${T}&qty=15`, admin);
    check('GET /lot-allocation/suggest → FEFO (expired excluded)', sug.status === 200 && sug.body.data.tracked && sug.body.data.allocations.length >= 1 && !sug.body.data.allocations.some((a) => a.lotId === 'LIB'), sug.body && sug.body.data);

    // 9) integrity (stock 30 == Σlot 30 → ok). Then break it and detect.
    const integ = await req('GET', `${V2}/lot-integrity?warehouseId=${WH}`, admin);
    check('GET /lot-integrity → ok (stock==Σlot)', integ.status === 200 && integ.body.data.length === 1 && integ.body.data[0].ok === true, integ.body && integ.body.data);
    await db.query('UPDATE warehouse_stock SET qty=35 WHERE warehouse_id=? AND item_id=?', [WH, T]);
    const drift = await req('GET', `${V2}/lot-integrity?warehouseId=${WH}&driftOnly=1`, admin);
    check('lot-integrity detects a drift (stock 35 ≠ Σlot 30)', drift.status === 200 && drift.body.data.length === 1 && Math.abs(drift.body.data[0].drift - 5) < 0.001, drift.body && drift.body.data);
    const csv = await req('GET', `${V2}/lot-integrity/export?warehouseId=${WH}`, admin);
    check('lot-integrity export → CSV', csv.status === 200 && /الصنف/.test(csv.raw || ''), { st: csv.status });

  } catch (e) { _f++; exitCode = 1; console.error('  ❌ FATAL', e && e.stack || e); }
  finally { try { server.kill(); } catch (_) {} try { await cleanup(); } catch (_) {} }
  console.log('\n  ' + _p + ' passed, ' + _f + ' failed\n');
  if (_f > 0) exitCode = 1;
  try { await db.end(); } catch (_) {}
  process.exit(exitCode);
})();
