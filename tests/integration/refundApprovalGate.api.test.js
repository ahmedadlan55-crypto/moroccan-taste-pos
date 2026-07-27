'use strict';
/* Integration — the void/return MANAGER-APPROVAL gate, live through the real
 * server + DB.
 *
 * THE DEFECT (W0-A #1): routes/sales.js mounted both reversal routes as
 *   router.post('/:orderId/void',   requireCapability('pos.refund'), …)
 *   router.post('/:orderId/return', requireCapability('pos.refund'), …)
 * while `_requireManagerApproval` — the thing that reads approverUsername /
 * approverPassword out of the BODY — ran INSIDE the handler, i.e. AFTER the
 * middleware. Role `cashier` is deliberately not granted `pos.refund`
 * (server.js cashier grant list), so the middleware answered 403
 * PERMISSION_DENIED before the credentials were ever looked at: the cashier
 * typed a correct manager username + password into the POS approval dialog and
 * the dialog looped forever. The button could NEVER succeed.
 *
 * THE FIX: authority is asserted in-handler by `_assertRefundAuthority`.
 * A caller WITH pos.refund behaves exactly as before; a caller WITHOUT it may
 * proceed only when this request carries manager credentials that verify
 * server-side AND that manager holds pos.refund himself.
 *
 * What this suite proves:
 *   (1) cashier + NO credentials              → 403 approval_required   (was PERMISSION_DENIED)
 *   (2) cashier + wrong password              → 403 approval_invalid
 *   (3) cashier + another CASHIER's real pw   → 403 approval_invalid    (role gate intact)
 *   (4) cashier + a MANAGER whose pos.refund
 *       is revoked by user override           → 403 approval_forbidden  (new, deliberate)
 *   (5) cashier + valid manager credentials   → 200, sale voided, approvedBy
 *       echoed, 'VOID_APPROVED_BY <mgr>' on the sale, audit_logs row written
 *   (6) admin, no credentials                 → 200 (today's path unchanged)
 *   (7) RequireManagerApprovalForVoid='0' does NOT grant refund to a cashier
 *       (the opt-out relaxes the SECOND factor, it never hands out the right)
 *   (8) the ZATCA-submitted refusal is NOT weakened: valid manager credentials
 *       still cannot void a submitted invoice (403 invoice_immutable)
 *   (9) POST /return — cashier + NO credentials → 403 approval_required
 *  (10) POST /return — cashier + valid manager credentials → 200 credit note,
 *       approvedBy echoed, 'RETURN_APPROVED_BY <mgr>' in the audit note
 *
 * ORDER_TO_CASH_ENABLE is pinned OFF: middleware/o2cLegacyGate 409s the LEGACY
 * void/return for EVERY caller when it is on (a separate product decision this
 * suite does not touch).
 *
 * Fixtures: ITEST-RAG-* / w0a_rag_* prefixed; cleanup runs before AND in
 * finally. PORT 3987. Run: node tests/integration/refundApprovalGate.api.test.js
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../db/connection');

const PORT = 3987;
const SFX = String(Date.now()).slice(-6);
const P = (s) => `ITEST-RAG-${SFX}-${s}`;
const SHIFT = P('SH');
const MENU1 = P('M1');
const PW = 'Rag#Test!2032';
const CASHIER = 'w0a_rag_cash';
const CASHIER2 = 'w0a_rag_cash2';
const MGR = 'w0a_rag_mgr';
const MGR_NR = 'w0a_rag_mgr_norefund';   // role=manager, pos.refund REVOKED
const ADMIN = 'w0a_rag_admin';
const USERS = [CASHIER, CASHIER2, MGR, MGR_NR, ADMIN];

let pass = 0, fail = 0; const fails = [];
function check(n, c, extra) {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; fails.push(n); console.log('  ❌', n, extra != null ? '→ ' + JSON.stringify(extra).slice(0, 320) : ''); }
}

function call(method, p, token, body) {
  return new Promise((res) => {
    const d = body !== undefined ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (s) => {
      let b = ''; s.on('data', (c) => (b += c));
      s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: s.statusCode, body: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.setTimeout(20000, () => { r.destroy(); res({ status: 0 }); });
    if (d) r.write(d); r.end();
  });
}
async function waitUp() {
  // Generous: a cold boot runs the procurement/GL migrations before listening.
  for (let i = 0; i < 300; i++) {
    const ok = await new Promise((z) => http.get('http://127.0.0.1:' + PORT + '/api/version', (s) => z(s.statusCode === 200)).on('error', () => z(false)));
    if (ok) return true;
    await new Promise((z) => setTimeout(z, 500));
  }
  return false;
}
const tok = (id, username, role) => jwt.sign({ id, username, role }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function saleRow(id) {
  const [r] = await db.query('SELECT zatca_type, has_credit_note, payment_notes FROM sales WHERE id=? LIMIT 1', [id]);
  return r[0] || null;
}

async function cleanup() {
  const del = async (sql, a) => { try { await db.query(sql, a || []); } catch (_) {} };
  for (const refType of ['Sale', 'ChannelCommission']) {
    const [js] = await db.query("SELECT id FROM gl_journals WHERE reference_type=? AND reference_id LIKE 'ITEST-RAG-%'", [refType]).catch(() => [[]]);
    for (const j of js) {
      await del('DELETE FROM gl_entries WHERE journal_id=?', [j.id]);
      await del('DELETE FROM gl_journals WHERE id=?', [j.id]);
    }
  }
  const [docs] = await db.query("SELECT id FROM ar_documents WHERE source_type='pos' AND source_id LIKE 'ITEST-RAG-%'").catch(() => [[]]);
  for (const d of docs) {
    await del('DELETE FROM ar_document_line_components WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_document_lines WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_events WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_events WHERE entity_id=?', [d.id]);
    await del('DELETE FROM analytics_modifier_facts WHERE document_id=?', [d.id]);
    await del('DELETE FROM analytics_order_facts WHERE document_id=?', [d.id]);
    await del('DELETE FROM ar_documents WHERE id=?', [d.id]);
  }
  await del("DELETE FROM analytics_payment_facts WHERE source_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM analytics_order_facts WHERE sale_id LIKE 'ITEST-RAG-%' OR document_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM analytics_till_facts WHERE source_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM zatca_submission_queue WHERE doc_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM audit_logs WHERE entity_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM credit_notes WHERE original_sale_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM inventory_movements WHERE notes LIKE '%ITEST-RAG-%'");
  await del("DELETE FROM sales_items WHERE order_id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM sales WHERE id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM shifts WHERE id LIKE 'ITEST-RAG-%'");
  await del("DELETE FROM menu WHERE id LIKE 'ITEST-RAG-%'");
  for (const u of USERS) {
    await del('DELETE FROM user_permission_overrides WHERE username=?', [u]);
    await del('DELETE FROM users WHERE username=?', [u]);
  }
}

async function fixtures() {
  const hash = await bcrypt.hash(PW, 12);
  const ids = {};
  for (const [u, role] of [[CASHIER, 'cashier'], [CASHIER2, 'cashier'], [MGR, 'manager'], [MGR_NR, 'manager'], [ADMIN, 'admin']]) {
    await db.query('INSERT INTO users (username,password,role,active) VALUES (?,?,?,1)', [u, hash, role]);
    const [r] = await db.query('SELECT id FROM users WHERE username=?', [u]);
    ids[u] = r[0].id;
  }
  // A MANAGER whose pos.refund is explicitly revoked — the exact account the
  // elevation path must refuse (privileged ROLE is not the same as holding the
  // refund CAPABILITY).
  await db.query("INSERT INTO user_permission_overrides (username, permission_id, grant_type, granted_by) VALUES (?,?,'revoke',?)",
    [MGR_NR, 'pos.refund', 'itest']);
  await db.query("INSERT INTO shifts (id, username, status, start_time, opening_float) VALUES (?,?,'OPEN',NOW(),0)", [SHIFT, CASHIER]);
  // Tax-inclusive so the recorded total is exactly the price (no client/server
  // total_mismatch noise — that guard is not what this suite is about).
  await db.query('INSERT INTO menu (id, name, price, cost, active, tax_category, is_tax_inclusive) VALUES (?,?,?,?,1,?,1)',
    [MENU1, P('Tagine'), 100, 20, 'S']);
  return ids;
}

let saleSeq = 0;
async function makeSale(token) {
  saleSeq++;
  const co = P('CO-' + saleSeq);
  const r = await call('POST', '/api/sales', token, {
    clientOrderId: co, shiftId: SHIFT,
    items: [{ id: MENU1, name: 'ITEST RAG Tagine', qty: 1, price: 100, lineDiscount: 0, baseQty: 1 }],
    total: 100, totalFinal: 100, discountAmount: 0, lineDiscountTotal: 0,
    paymentMethod: 'cash',
  });
  return { status: r.status, id: r.body && r.body.orderId, body: r.body };
}

(async () => {
  await cleanup();
  const ids = await fixtures();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    // The legacy void/return path is what this gate lives on; o2cLegacyGate
    // 409s it for EVERYONE when ORDER_TO_CASH_ENABLE=1 (documented, untouched).
    env: { ...process.env, PORT: String(PORT), ORDER_TO_CASH_ENABLE: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const cashier = tok(ids[CASHIER], CASHIER, 'cashier');
  const admin = tok(ids[ADMIN], ADMIN, 'admin');

  try {
    if (!(await waitUp())) { console.error('server did not start'); process.exit(2); }

    // ── the cashier really does NOT hold pos.refund (premise of the whole fix) ──
    const { hasCapability } = require('../../middleware/requireCapability');
    check('premise: role cashier does NOT hold pos.refund',
      (await hasCapability({ username: CASHIER, role: 'cashier' }, 'pos.refund')) === false);
    check('premise: role manager DOES hold pos.refund',
      (await hasCapability({ username: MGR, role: 'manager' }, 'pos.refund')) === true);
    check('premise: the override-revoked manager does NOT hold pos.refund',
      (await hasCapability({ username: MGR_NR, role: 'manager' }, 'pos.refund')) === false);

    console.log('\n▶ VOID — the gate is reachable at all');
    const s1 = await makeSale(cashier);
    check('seed sale created', s1.status === 200 && !!s1.id, s1.body);

    // (1) THE REGRESSION: no credentials must ask for approval, not deny the route.
    const r1 = await call('POST', `/api/sales/${s1.id}/void`, cashier, {});
    check('cashier + no credentials → 403 approval_required (NOT PERMISSION_DENIED)',
      r1.status === 403 && r1.body && r1.body.code === 'approval_required', { status: r1.status, body: r1.body });

    // (2) wrong password
    const r2 = await call('POST', `/api/sales/${s1.id}/void`, cashier, { approverUsername: MGR, approverPassword: 'not-the-password' });
    check('cashier + wrong manager password → 403 approval_invalid',
      r2.status === 403 && r2.body && r2.body.code === 'approval_invalid', { status: r2.status, body: r2.body });

    // (3) a real password, but the approver is not privileged
    const r3 = await call('POST', `/api/sales/${s1.id}/void`, cashier, { approverUsername: CASHIER2, approverPassword: PW });
    check('cashier + another CASHIER\'s real password → 403 approval_invalid',
      r3.status === 403 && r3.body && r3.body.code === 'approval_invalid', { status: r3.status, body: r3.body });

    // (4) privileged role, capability revoked
    const r4 = await call('POST', `/api/sales/${s1.id}/void`, cashier, { approverUsername: MGR_NR, approverPassword: PW });
    check('cashier + manager WITHOUT pos.refund → 403 approval_forbidden',
      r4.status === 403 && r4.body && r4.body.code === 'approval_forbidden', { status: r4.status, body: r4.body });

    const stillLive = await saleRow(s1.id);
    check('none of the four refusals mutated the sale', !!stillLive && stillLive.zatca_type !== 'cancellation', stillLive);

    // (5) the happy path the button was supposed to have all along
    const r5 = await call('POST', `/api/sales/${s1.id}/void`, cashier, { approverUsername: MGR, approverPassword: PW });
    check('cashier + VALID manager credentials → 200 success', r5.status === 200 && r5.body && r5.body.success === true, { status: r5.status, body: r5.body });
    check('response echoes approvedBy = the approving manager', r5.body && r5.body.approvedBy === MGR, r5.body && r5.body.approvedBy);
    const voided = await saleRow(s1.id);
    check('sale is stamped zatca_type=cancellation', voided && voided.zatca_type === 'cancellation', voided);
    check('the approving manager is on the sale audit note (VOID_APPROVED_BY)',
      !!voided && String(voided.payment_notes || '').includes('VOID_APPROVED_BY ' + MGR), voided && voided.payment_notes);
    const [aud] = await db.query(
      "SELECT action, user_username, details FROM audit_logs WHERE entity_type='sale' AND entity_id=? AND action='sale_void_approved'", [s1.id]);
    check('audit_logs carries a sale_void_approved row naming the approver',
      aud.length === 1 && String(aud[0].details || '').includes(MGR) && aud[0].user_username === CASHIER, aud);

    // (6) the authorized caller's path is untouched
    console.log('\n▶ VOID — the pos.refund holder\'s path is unchanged');
    const s2 = await makeSale(cashier);
    const r6 = await call('POST', `/api/sales/${s2.id}/void`, admin, {});
    check('admin + no credentials → 200 (unchanged)', r6.status === 200 && r6.body && r6.body.success === true, { status: r6.status, body: r6.body });
    check('admin void reports approvedBy = null (acted on own authority)', r6.body && r6.body.approvedBy === null, r6.body && r6.body.approvedBy);

    // (7) the void opt-out must NOT become a refund grant
    console.log('\n▶ VOID — RequireManagerApprovalForVoid=0 is not a capability grant');
    const [prev] = await db.query("SELECT setting_value FROM settings WHERE setting_key='RequireManagerApprovalForVoid' LIMIT 1");
    const hadSetting = prev.length;
    const prevVal = hadSetting ? prev[0].setting_value : null;
    await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('RequireManagerApprovalForVoid','0') " +
      "ON DUPLICATE KEY UPDATE setting_value='0'");
    try {
      const s3 = await makeSale(cashier);
      const r7 = await call('POST', `/api/sales/${s3.id}/void`, cashier, {});
      check('cashier + opt-out ON + no credentials → still 403 approval_required',
        r7.status === 403 && r7.body && r7.body.code === 'approval_required', { status: r7.status, body: r7.body });
      const untouched = await saleRow(s3.id);
      check('…and the sale is still live', !!untouched && untouched.zatca_type !== 'cancellation', untouched);
      const r7b = await call('POST', `/api/sales/${s3.id}/void`, admin, {});
      check('…while the admin still voids with the opt-out on', r7b.status === 200 && r7b.body.success === true, { status: r7b.status, body: r7b.body });
    } finally {
      if (hadSetting) await db.query("UPDATE settings SET setting_value=? WHERE setting_key='RequireManagerApprovalForVoid'", [prevVal]);
      else await db.query("DELETE FROM settings WHERE setting_key='RequireManagerApprovalForVoid'");
    }

    // (8) no other guard was traded away for the elevation
    console.log('\n▶ VOID — the ZATCA immutability refusal survives the elevation');
    const s4 = await makeSale(cashier);
    await db.query('UPDATE sales SET zatca_submitted_at = NOW() WHERE id = ?', [s4.id]);
    const r8 = await call('POST', `/api/sales/${s4.id}/void`, cashier, { approverUsername: MGR, approverPassword: PW });
    check('valid manager approval STILL cannot void a ZATCA-submitted invoice',
      r8.status === 403 && r8.body && r8.body.code === 'invoice_immutable', { status: r8.status, body: r8.body });
    const immutable = await saleRow(s4.id);
    check('…and that sale is untouched', !!immutable && immutable.zatca_type !== 'cancellation', immutable);

    // (9)+(10) the return route had the identical ordering bug
    console.log('\n▶ RETURN — same gate, same fix');
    const s5 = await makeSale(cashier);
    const r9 = await call('POST', `/api/sales/${s5.id}/return`, cashier, { reason: 'itest no creds' });
    check('cashier return + no credentials → 403 approval_required (NOT PERMISSION_DENIED)',
      r9.status === 403 && r9.body && r9.body.code === 'approval_required', { status: r9.status, body: r9.body });

    const r10 = await call('POST', `/api/sales/${s5.id}/return`, cashier, {
      reason: 'itest approved return', approverUsername: MGR, approverPassword: PW });
    check('cashier return + VALID manager credentials → 200 success', r10.status === 200 && r10.body && r10.body.success === true, { status: r10.status, body: r10.body });
    check('a real credit note was issued', !!(r10.body && r10.body.creditNoteId), r10.body && r10.body.creditNoteId);
    check('return response echoes approvedBy', r10.body && r10.body.approvedBy === MGR, r10.body && r10.body.approvedBy);
    const returned = await saleRow(s5.id);
    check('original flagged has_credit_note', !!(returned && Number(returned.has_credit_note) === 1), returned);
    check('the approving manager is on the credit-note audit note (RETURN_APPROVED_BY)',
      !!returned && String(returned.payment_notes || '').includes('RETURN_APPROVED_BY ' + MGR), returned && returned.payment_notes);
    const [aud2] = await db.query(
      "SELECT action FROM audit_logs WHERE entity_type='sale' AND entity_id=? AND action='sale_return_approved'", [s5.id]);
    check('audit_logs carries a sale_return_approved row', aud2.length === 1, aud2);

    console.log(`\n${fail === 0 ? '✅' : '❌'} refundApprovalGate: ${pass} passed, ${fail} failed`);
    if (fail) console.log('   failed:', fails.join(' | '));
  } finally {
    server.kill();
    await cleanup();
    try { await db.end(); } catch (_) {}
  }
  process.exit(fail === 0 ? 0 : 1);
})();
