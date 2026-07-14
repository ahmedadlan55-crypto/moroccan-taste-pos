/**
 * Purchase Requisitions (PR) — end-to-end integration test.
 *
 * Boots server.js with PROCUREMENT_P2P_ENABLE=1 on a unique port and exercises
 * the NEW /api/procurement/requisitions subsystem:
 *   • RBAC — a non-manager (cashier, lacking purchasing.requisitions.approve)
 *     is 403'd on approve.
 *   • Happy path — create(draft) → submit → approve → convert-to-po, asserting a
 *     purchase_orders row appears and the requisition flips to 'converted'+po_id.
 *   • Double-approve race — two concurrent approves resolve to a SINGLE approval
 *     (one 200, one 422 INVALID_STATE_TRANSITION; DB status='approved' once).
 *   • Guards — create needs ≥1 line; convert requires an approved requisition;
 *     delete is draft-only.
 *
 * Self-cleaning. Run: node tests/integration/requisitions.api.test.js
 * (NOT part of `npm test`.)
 */
'use strict';
try { require('dotenv').config(); } catch (_) {}
const http = require('http');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = Number(process.env.REQ_TEST_PORT || 3242);
const BASE = { host: '127.0.0.1', port: PORT };
const SUP = 'SUP-REQ-1';

let _p = 0, _f = 0;
function check(name, cond, extra) { if (cond) { _p++; console.log('  ✅', name); } else { _f++; console.log('  ❌', name, extra != null ? '→ ' + JSON.stringify(extra) : ''); } }

function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
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
function tok(id, username, role, dev) { return jwt.sign({ id, username, role, isDeveloper: !!dev, tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

const _createdReqs = [];
const _createdPos = [];

async function cleanup() {
  const sqls = [];
  if (_createdPos.length) {
    sqls.push(['DELETE FROM po_lines WHERE po_id IN (?)', [_createdPos]]);
    sqls.push(['DELETE FROM purchase_orders WHERE id IN (?)', [_createdPos]]);
    sqls.push(["DELETE FROM procurement_events WHERE document_type='po' AND document_id IN (?)", [_createdPos]]);
  }
  if (_createdReqs.length) {
    sqls.push(['DELETE FROM purchase_requisition_lines WHERE requisition_id IN (?)', [_createdReqs]]);
    sqls.push(['DELETE FROM purchase_requisitions WHERE id IN (?)', [_createdReqs]]);
  }
  sqls.push(['DELETE FROM suppliers WHERE id=?', [SUP]]);
  for (const [s, p] of sqls) { try { await db.query(s, p); } catch (_) {} }
}
async function seed() {
  await cleanup();
  await db.query('INSERT INTO suppliers (id,name,is_active) VALUES (?,?,1)', [SUP, 'مورد طلبات الشراء']);
}

const LINES = [
  { itemId: 'REQ-ITEM-A', itemName: 'صنف أ', quantity: 10, unit: 'كجم', estimatedPrice: 5, notes: 'عاجل' },
  { itemId: 'REQ-ITEM-B', itemName: 'صنف ب', quantity: 4, unit: 'علبة', estimatedPrice: 20 },
];

async function createReq(token, lines = LINES, extra = {}) {
  const r = await req('POST', '/api/procurement/requisitions', token, Object.assign({ warehouseId: 'WH-REQ', notes: 'طلب اختبار', lines }, extra));
  if (r.body && r.body.data && r.body.data.id) _createdReqs.push(r.body.data.id);
  return r;
}

(async () => {
  if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(2); }
  console.log('\n═══ Purchase Requisitions — integration ═══\n');
  await seed();
  const admin = tok(0, 'req_admin', 'admin', true);
  const cashier = tok(0, 'req_cashier', 'cashier'); // lacks purchasing.requisitions.approve
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), PROCUREMENT_P2P_ENABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) { console.error('server did not start'); process.exit(2); }

    // ── validation: create needs ≥1 line ──
    const bad = await req('POST', '/api/procurement/requisitions', admin, { lines: [] });
    check('create with no lines → 422 VALIDATION_ERROR', bad.status === 422 && bad.body && bad.body.code === 'VALIDATION_ERROR', bad.body);

    // ── RBAC: non-manager approve → 403 ──
    const rbacReq = await createReq(admin);
    check('admin creates draft requisition (201)', rbacReq.status === 201 && rbacReq.body.status === 'draft' && /^PR-/.test(rbacReq.body.documentNumber || ''), rbacReq.body);
    const rbacId = rbacReq.body.data.id;
    const rbacSubmit = await req('POST', `/api/procurement/requisitions/${rbacId}/submit`, admin, {});
    check('submit draft → submitted (200)', rbacSubmit.status === 200 && rbacSubmit.body.status === 'submitted', rbacSubmit.body);
    const rbacApprove = await req('POST', `/api/procurement/requisitions/${rbacId}/approve`, cashier, {});
    check('non-manager (cashier) approve → 403 PERMISSION_DENIED', rbacApprove.status === 403 && rbacApprove.body && rbacApprove.body.code === 'PERMISSION_DENIED', { s: rbacApprove.status, c: rbacApprove.body && rbacApprove.body.code });

    // ── happy path: create → submit → approve → convert-to-po ──
    const hp = await createReq(admin);
    const hpId = hp.body.data.id;
    check('happy: create (201)', hp.status === 201, hp.body);
    const hpSubmit = await req('POST', `/api/procurement/requisitions/${hpId}/submit`, admin, {});
    check('happy: submit (200)', hpSubmit.status === 200 && hpSubmit.body.status === 'submitted', hpSubmit.body);
    // convert before approve → blocked
    const earlyConvert = await req('POST', `/api/procurement/requisitions/${hpId}/convert-to-po`, admin, { supplierId: SUP });
    check('convert before approve → 422 INVALID_STATE_TRANSITION', earlyConvert.status === 422 && earlyConvert.body && earlyConvert.body.code === 'INVALID_STATE_TRANSITION', earlyConvert.body);
    const hpApprove = await req('POST', `/api/procurement/requisitions/${hpId}/approve`, admin, {});
    check('happy: approve (200) → approved', hpApprove.status === 200 && hpApprove.body.status === 'approved', hpApprove.body);
    // convert without a supplier → 422
    const noSup = await req('POST', `/api/procurement/requisitions/${hpId}/convert-to-po`, admin, {});
    check('convert without supplier → 422', noSup.status === 422, noSup.body);
    const convert = await req('POST', `/api/procurement/requisitions/${hpId}/convert-to-po`, admin, { supplierId: SUP });
    if (convert.body && convert.body.data && convert.body.data.poId) _createdPos.push(convert.body.data.poId);
    check('happy: convert-to-po (201) → converted + poId', convert.status === 201 && convert.body.status === 'converted' && !!(convert.body.data && convert.body.data.poId), convert.body);

    // ── DB assertions: a PO row appeared, linked, totals computed ──
    const poId = convert.body && convert.body.data && convert.body.data.poId;
    const [[poRow]] = await db.query('SELECT id, po_number, supplier_id, status, total_after_vat FROM purchase_orders WHERE id=?', [poId || '']);
    check('PO row exists (draft, linked to supplier)', !!poRow && poRow.status === 'draft' && poRow.supplier_id === SUP, poRow);
    // 10*5 + 4*20 = 130 net; +15% VAT = 149.5
    check('PO total computed server-side (149.5)', !!poRow && Math.abs(Number(poRow.total_after_vat) - 149.5) < 0.01, poRow && poRow.total_after_vat);
    const [[poLineCount]] = await db.query('SELECT COUNT(*) AS c FROM po_lines WHERE po_id=?', [poId || '']);
    check('PO has 2 lines', !!poLineCount && Number(poLineCount.c) === 2, poLineCount);
    const [[reqRow]] = await db.query('SELECT status, po_id FROM purchase_requisitions WHERE id=?', [hpId]);
    check('requisition flipped to converted + po_id set', !!reqRow && reqRow.status === 'converted' && reqRow.po_id === poId, reqRow);
    // convert again → blocked (already converted)
    const reConvert = await req('POST', `/api/procurement/requisitions/${hpId}/convert-to-po`, admin, { supplierId: SUP });
    check('double convert → 422 INVALID_STATE_TRANSITION', reConvert.status === 422 && reConvert.body && reConvert.body.code === 'INVALID_STATE_TRANSITION', reConvert.body);

    // ── double-approve race: exactly ONE approval wins ──
    const race = await createReq(admin);
    const raceId = race.body.data.id;
    await req('POST', `/api/procurement/requisitions/${raceId}/submit`, admin, {});
    const [a1, a2] = await Promise.all([
      req('POST', `/api/procurement/requisitions/${raceId}/approve`, admin, {}),
      req('POST', `/api/procurement/requisitions/${raceId}/approve`, admin, {}),
    ]);
    const okCount = [a1, a2].filter((x) => x.status === 200).length;
    const conflictCount = [a1, a2].filter((x) => x.status === 422 && x.body && x.body.code === 'INVALID_STATE_TRANSITION').length;
    check('double-approve: exactly ONE 200', okCount === 1, { a1: a1.status, a2: a2.status });
    check('double-approve: the loser is 422 INVALID_STATE_TRANSITION', conflictCount === 1, { a1: a1.body && a1.body.code, a2: a2.body && a2.body.code });
    const [[raceRow]] = await db.query('SELECT status FROM purchase_requisitions WHERE id=?', [raceId]);
    check('double-approve: DB status = approved (single approval)', !!raceRow && raceRow.status === 'approved', raceRow);

    // ── delete guards ──
    const delApproved = await req('DELETE', `/api/procurement/requisitions/${raceId}`, admin);
    check('delete non-draft → 422', delApproved.status === 422, delApproved.body);
    const draftForDelete = await createReq(admin);
    const delDraft = await req('DELETE', `/api/procurement/requisitions/${draftForDelete.body.data.id}`, admin);
    check('delete draft → 200', delDraft.status === 200 && delDraft.body && delDraft.body.data && delDraft.body.data.deleted === true, delDraft.body);

    // ── list + detail ──
    const list = await req('GET', '/api/procurement/requisitions?status=converted', admin);
    check('list (status=converted) returns the converted req', list.status === 200 && Array.isArray(list.body.data) && list.body.data.some((x) => x.id === hpId), { s: list.status });
    const detail = await req('GET', `/api/procurement/requisitions/${hpId}`, admin);
    check('detail returns header + 2 lines', detail.status === 200 && detail.body.data && Array.isArray(detail.body.data.lines) && detail.body.data.lines.length === 2, detail.body && detail.body.data && { lines: detail.body.data.lines && detail.body.data.lines.length });
  } catch (e) { console.error('ERROR', e); exitCode = 1; }
  finally { try { server.kill(); } catch (_) {} }
  console.log('\n═══ ' + _p + ' passed, ' + _f + ' failed ═══\n');
  await cleanup().catch(() => {});
  setTimeout(() => process.exit(_f || exitCode ? 1 : 0), 300);
})();
